"""启动本地学习网页服务。"""
from __future__ import annotations

import socket
import sys
import threading
import time

from waitress import serve

from app import app, local_ips
from core import config, tls


def port_busy(port, host="0.0.0.0") -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, int(port)))
        return False
    except OSError:
        return True
    finally:
        try:
            sock.close()
        except Exception:
            pass


def wait_port(port, host="127.0.0.1", timeout=25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        sock = socket.socket()
        sock.settimeout(0.5)
        try:
            sock.connect((host, int(port)))
            return True
        except OSError:
            time.sleep(0.2)
        finally:
            try:
                sock.close()
            except Exception:
                pass
    return False


def warm_scan() -> None:
    from core import catalog
    from core.indexer import INDEXER
    try:
        stats = catalog.scan_all()
        print("[扫描] 完成：", stats)
    except Exception as exc:
        print("[扫描] 失败：", exc)
    INDEXER.ensure_started()


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


MAX_RESTARTS = 5
RESTART_WAIT = 5.0
LOG_MAX_BYTES = 1024 * 1024


def log_line(text: str) -> None:
    """一行写到屏幕，同时追加进 data/server.log（超过 1 MB 就把旧的留成 server.log.old）。"""
    line = "[" + time.strftime("%Y-%m-%d %H:%M:%S") + "] " + text
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        path = config.DATA_DIR / "server.log"
        if path.exists() and path.stat().st_size > LOG_MAX_BYTES:
            path.replace(path.with_name("server.log.old"))
        with open(str(path), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def serve_once(ips) -> None:
    """按当前设置把服务跑起来。正常结束就返回；真崩了把异常抛给上层去重启。"""
    conf = config.tls_settings()
    if not conf["enabled"]:
        if port_busy(config.PORT):
            log_line("[错误] 端口 " + str(config.PORT) + " 被占用了，先关掉占用的程序再启动。")
            return
        serve(app, host=config.HOST, port=config.PORT, threads=8, channel_timeout=900)
        return

    hosts = ["127.0.0.1", "localhost"] + ips
    cert, key = tls.make_cert(conf["cert_dir"], hosts)
    if not cert:
        log_line("[提醒] 没生成证书（缺 cryptography），这次还是用 http 启动。")
        log_line("       想用 https：.venv\\Scripts\\pip install cryptography")
        if port_busy(config.PORT):
            log_line("[错误] 端口 " + str(config.PORT) + " 被占用了，先关掉占用的程序再启动。")
            return
        serve(app, host=config.HOST, port=config.PORT, threads=8, channel_timeout=900)
        return

    inner = conf["http_port"]
    https_port = conf["port"]
    if port_busy(inner):
        log_line("[错误] 内网端口 " + str(inner) + " 被占用了，先关掉占用的程序再启动。")
        return
    if port_busy(https_port):
        log_line("[错误] https 端口 " + str(https_port) + " 被占用了，先关掉占用的程序再启动。")
        return
    thread = threading.Thread(
        target=lambda: serve(app, host="127.0.0.1", port=inner, threads=8, channel_timeout=900),
        daemon=True)
    thread.start()
    if not wait_port(inner):
        log_line("[错误] 内部服务没起来，请看上面的报错。")
        return
    tls.serve_tls(cert, key, "0.0.0.0", https_port, "127.0.0.1", inner)


def main() -> None:
    _force_utf8()
    config.ensure_dirs()
    threading.Thread(target=warm_scan, daemon=True).start()
    from core import autoscan
    autoscan.start()
    ips = local_ips()
    conf = config.tls_settings()
    scan = config.scan_settings()
    print("=" * 58, flush=True)
    print("  学习网页已启动", flush=True)
    print("  本机打开：       http://127.0.0.1:" + str(config.PORT), flush=True)
    for candidate in ips:
        print("  同一 Wi-Fi 下：  http://" + candidate + ":" + str(config.PORT), flush=True)
    print("  资料目录（只读）：" + str(config.SOURCE_ROOT), flush=True)
    print("  自动扫描：      " + ("每 " + str(scan["minutes"]) + " 分钟一次"
                                  if scan["enabled"] else "已关闭（管理端可以开）"), flush=True)
    if conf["enabled"]:
        print("  加密访问（https，推荐）：", flush=True)
        for candidate in ["127.0.0.1"] + ips:
            print("     https://" + candidate + ":" + str(conf["port"]), flush=True)
        print("  手机第一次打开会提示“不安全”，点“继续访问”就好。", flush=True)
    print("  运行日志：      " + str(config.DATA_DIR / "server.log"), flush=True)
    print("  按 Ctrl+C 可以停止服务", flush=True)
    print("=" * 58, flush=True)

    fails = 0
    while True:
        try:
            serve_once(ips)
            return
        except KeyboardInterrupt:
            return
        except Exception as exc:
            fails += 1
            log_line("[错误] 服务异常退出（第 " + str(fails) + " 次）：" + repr(exc))
            if fails >= MAX_RESTARTS:
                log_line("[错误] 连续失败 " + str(fails) + " 次，先不重启了；请把上面的报错发出来。")
                return
            log_line("[提示] " + str(int(RESTART_WAIT)) + " 秒后自动重启。")
            time.sleep(RESTART_WAIT)


if __name__ == "__main__":
    main()
