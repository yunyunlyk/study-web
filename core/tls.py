"""局域网 HTTPS：自签证书 + 一个很小的 TLS 反向代理。

waitress 不支持 TLS，所以用标准库的 ssl 在前面挡一层：
浏览器 --(https 8787)--> 这个代理 --(http 8788)--> waitress。
这样局域网里的手机/平板也能拿到“安全上下文”，才能用「选择文件夹」功能。
"""
from __future__ import annotations

import json
import socket
import ssl
import threading
from pathlib import Path

CERT_NAME = "study.crt"
KEY_NAME = "study.key"
META_NAME = "study.meta.json"
VALID_DAYS = 825


def make_cert(cert_dir, hosts):
    """生成/复用自签证书。没装 cryptography 就返回 (None, None)。"""
    cert_dir = Path(cert_dir)
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_path = cert_dir / CERT_NAME
    key_path = cert_dir / KEY_NAME
    meta_path = cert_dir / META_NAME
    wanted = sorted({str(h).strip() for h in hosts if str(h).strip()})
    if cert_path.exists() and key_path.exists() and meta_path.exists():
        try:
            saved = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            saved = {}
        if sorted(saved.get("hosts") or []) == wanted:
            return cert_path, key_path
    try:
        import datetime as _dt
        import ipaddress

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except Exception:
        return None, None

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "study-web")])
    names = []
    for host in wanted:
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            names.append(x509.DNSName(host))
    if not names:
        names = [x509.DNSName("localhost")]
    now = _dt.datetime.now(_dt.timezone.utc)
    builder = x509.CertificateBuilder()
    builder = builder.subject_name(subject).issuer_name(subject)
    builder = builder.public_key(key.public_key())
    builder = builder.serial_number(x509.random_serial_number())
    builder = builder.not_valid_before(now - _dt.timedelta(days=1))
    builder = builder.not_valid_after(now + _dt.timedelta(days=VALID_DAYS))
    builder = builder.add_extension(x509.SubjectAlternativeName(names), critical=False)
    builder = builder.add_extension(
        x509.BasicConstraints(ca=False, path_length=None), critical=True)
    cert = builder.sign(key, hashes.SHA256())
    key_path.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    meta_path.write_text(json.dumps({"hosts": wanted}, ensure_ascii=False), encoding="utf-8")
    return cert_path, key_path


def _pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass


def serve_tls(cert_path, key_path, host, port, target_host, target_port):
    """把 TLS 端口收到的连接转发到本机 http 端口，一直不返回。"""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert_path), str(key_path))
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, int(port)))
    server.listen(128)
    while True:
        try:
            raw, _addr = server.accept()
        except OSError:
            continue
        try:
            conn = context.wrap_socket(raw, server_side=True)
        except Exception:
            try:
                raw.close()
            except Exception:
                pass
            continue
        try:
            upstream = socket.create_connection((target_host, int(target_port)), timeout=15)
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            continue
        conn.settimeout(None)
        upstream.settimeout(None)
        threading.Thread(target=_pipe, args=(conn, upstream), daemon=True).start()
        threading.Thread(target=_pipe, args=(upstream, conn), daemon=True).start()