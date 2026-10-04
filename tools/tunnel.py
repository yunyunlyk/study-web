"""手机 / 外网访问：用一条免费的可信 https 隧道，把本机网站安全地发出去。

为什么不用自签 https 那套：自签证书会让每台设备都弹「不安全 / 继续访问」，
还要把端口从 http 改成 https、改完得重启、证书 825 天还会过期。
隧道方案是在前面加一层 Cloudflare 的可信证书，本机网站一个字都不用改：

  - 手机扫码就能打开，地址栏是正常的锁，没有警告
  - 电脑上照旧用 http://127.0.0.1:8787，什么都不变、旧链接照常能用
  - 证书由 Cloudflare 自动签发和轮换，你不用管续期
  - 别人从手机流量（不在同一个 Wi-Fi）也能打开

用法：
  隧道.cmd                       启动并打印网址 + 生成手机扫码图片
  停止隧道.cmd                   停止隧道（本机网站不受影响）
  python tools\tunnel.py status  看看现在有没有在跑、网址是多少
  python tools\tunnel.py check   检查"绑定自己域名"的前置条件
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
# 端口跟着服务走（服务端可用 STUDY_PORT 覆盖）。以前这里写死 8787：
# 一旦把端口改掉，隧道会把公网请求转到没人监听的端口上，表现就是一直 502。
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))
from core import config as _config  # noqa: E402

EXE = BASE / "tools" / "cloudflared.exe"
DATA = BASE / "data"
ERR = DATA / "tunnel.err.log"
OUT = DATA / "tunnel.out.log"
URL_FILE = DATA / "tunnel_url.txt"
PID_FILE = DATA / "tunnel.pid"
QR_FILE = DATA / "手机扫码访问.png"
DOWNLOAD = ("https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/"
            "latest/download/cloudflared-windows-amd64.exe")
PORT = _config.PORT
# cloudflared 要连的那个「纯 http」端口。开了 HTTPS 时，对外的 8787 是 TLS 代理，
# 对它发普通 http 请求会被直接断开（隧道的表现就是 502 / Bad Gateway）；
# 真正的 HTTP 后端在 tls.http_port（8788，只听 127.0.0.1）。所以两个端口必须分开：
#   PORT      —— 给人看的网址端口（浏览器 / 手机用，开了 HTTPS 就是 https 的）
#   SITE_PORT —— 隧道要连的纯 http 端口
_TLS = _config.tls_settings()
SITE_PORT = _TLS["http_port"] if _TLS["enabled"] else PORT

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq " + str(pid), "/NH"],
                             capture_output=True, text=True, timeout=15).stdout or ""
    except Exception:
        return False
    return str(pid) in out


def _running_pid():
    if not PID_FILE.exists():
        return 0
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip() or "0")
    except Exception:
        return 0
    return pid if _pid_alive(pid) else 0


def _current_url() -> str:
    if URL_FILE.exists():
        return URL_FILE.read_text(encoding="utf-8").strip()
    return ""


def _site_ok() -> bool:
    import socket
    try:
        s = socket.create_connection(("127.0.0.1", SITE_PORT), timeout=3)
        s.close()
        return True
    except Exception:
        return False


def _qr(url: str) -> str:
    try:
        import qrcode
    except Exception:
        return ""
    try:
        img = qrcode.make(url)
        img.save(str(QR_FILE))
        return str(QR_FILE)
    except Exception:
        return ""



def _wait_public(url: str, seconds: int = 60) -> bool:
    """刚建好的隧道要预热十几秒，等它真的能打开再告诉用户。"""
    import ssl
    import urllib.request
    ctx = ssl.create_default_context()
    end = time.time() + seconds
    while time.time() < end:
        try:
            req = urllib.request.Request(url + "/", headers={"User-Agent": "study-web-tunnel-check"})
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                if 200 <= resp.status < 400:
                    return True
        except Exception:
            pass
        time.sleep(4)
    return False


def start() -> int:
    if not EXE.exists():
        print("没有找到隧道程序：" + str(EXE))
        print("重新下载（约 55 MB）：")
        print('  curl.exe -L -o "' + str(EXE) + '" "' + DOWNLOAD + '"')
        return 1

    pid = _running_pid()
    url = _current_url()
    if pid and url:
        print("隧道已经在跑了。")
        print("手机打开：" + url)
        return 0
    if not _site_ok():
        print("[提醒] 本机的学习网页好像没在运行（" + str(PORT) + " 端口没响应）。")
        print("       请先双击「启动.bat」，再开隧道。")
        return 1

    for path in (ERR, OUT, URL_FILE):
        try:
            path.unlink()
        except Exception:
            pass
    DATA.mkdir(parents=True, exist_ok=True)
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags = subprocess.CREATE_NO_WINDOW
    with open(ERR, "wb") as log:
        proc = subprocess.Popen(
            [str(EXE), "tunnel", "--url", "http://127.0.0.1:" + str(SITE_PORT), "--no-autoupdate"],
            stdout=log, stderr=subprocess.STDOUT, cwd=str(BASE), creationflags=flags)
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")

    print("正在向 Cloudflare 申请一条 https 隧道，请稍等（一般 5~20 秒）...")
    pattern = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")
    found = ""
    for _ in range(60):
        time.sleep(1.5)
        try:
            text = ERR.read_text(encoding="utf-8", errors="replace")
        except Exception:
            text = ""
        hit = pattern.search(text)
        if hit:
            found = hit.group(0)
            break
        if not _pid_alive(proc.pid):
            print("隧道进程提前退出了，日志末尾：")
            print("\n".join(text.splitlines()[-12:]))
            return 1
    if not found:
        print("等了 90 秒还没拿到网址。可以再运行一次；如果一直不行，多半是网络问题。")
        return 1

    URL_FILE.write_text(found, encoding="utf-8")
    print("正在等隧道预热（第一次打开要十几秒，过了就能用）...")
    if _wait_public(found):
        print("隧道已就绪。")
    else:
        print("[提醒] 60 秒内没等到它响应，可能还要再等一会儿；稍后刷新一下就行。")
        # 域名是刚生成的，本机 DNS 有可能在此之前问过一次（问的时候还不存在）并把
        # 「不存在」缓存下来，于是浏览器说"找不到服务器"，但手机上（另走一条 DNS）却是好的。
        # 刷一下本机 DNS 缓存是最快的解法，所以直接把命令写在这里。
        print("       如果浏览器提示「找不到服务器 / DNS 错误」，在本窗口外新开一个命令行执行：")
        print("         ipconfig /flushdns")
        print("       然后刷新页面。（手机用流量访问不受这条影响。）")
    print("")
    print("=" * 62)
    print("  手机 / 外网访问地址（可信 https，不会有安全警告）：")
    print("  " + found)
    print("=" * 62)
    print("  这个地址每次启动都会变；机器关掉就失效。")
    if _TLS["enabled"]:
        print("  注意：本机开了自签 HTTPS，电脑上要打开 https://127.0.0.1:" + str(PORT)
              + "（会提示「不安全 / 继续访问」）；")
        print("        上面这个隧道地址是 Cloudflare 的可信证书，手机扫码不会有任何警告。")
    print("  想让地址固定、用自己的域名，见 README「二十三、手机访问与用自己域名上线」。")
    print("")
    qr = _qr(found)
    if qr:
        print("已生成手机扫码图片：" + qr)
        try:
            os.startfile(qr)  # noqa: S606 - 需要给用户看/扫
        except Exception:
            pass
    else:
        print("（装了 qrcode 才能生成扫码图片：.venv\\Scripts\\python.exe -m pip install qrcode）")
    return 0


def stop() -> int:
    pid = _running_pid()
    if not pid:
        print("隧道没在运行。")
    else:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, text=True, timeout=30)
        print("隧道已停止（本机网站还在跑，不影响电脑上访问）。")
    for path in (PID_FILE, URL_FILE):
        try:
            path.unlink()
        except Exception:
            pass
    return 0


def status() -> int:
    pid = _running_pid()
    url = _current_url()
    if pid and url:
        print("运行中，PID " + str(pid))
        print("网址：" + url)
    else:
        print("没有在运行。")
    print("本机网站：" + ("在跑" if _site_ok() else "没在跑（端口 " + str(PORT) + " 无响应）"))
    return 0


def check() -> int:
    print("=== 用自己域名上线的前置检查 ===")
    print("1) 隧道程序：" + (str(EXE) if EXE.exists() else "缺失"))
    try:
        ver = subprocess.run([str(EXE), "--version"], capture_output=True, text=True,
                             timeout=30).stdout.strip()
    except Exception:
        ver = ""
    print("   版本：" + (ver or "无法读取"))
    conf = Path(os.path.expanduser("~")) / ".cloudflared" / "cert.pem"
    print("2) Cloudflare 登录凭据：" + ("已存在 " + str(conf) if conf.exists() else "还没有"))
    print("3) 本机网站：" + ("在跑" if _site_ok() else "没在跑"))
    print("4) 自签 https 开关：" + "见管理端「系统设置」，用隧道就不用开它")
    print("")
    print("接下来的步骤（需要你登录一次 Cloudflare 账号，域名也要托管在 Cloudflare）：")
    print("  tools\\cloudflared.exe tunnel login")
    print("  tools\\cloudflared.exe tunnel create study-web")
    print("  tools\\cloudflared.exe tunnel route dns study-web study.你的域名.com")
    print("  tools\\cloudflared.exe tunnel run --url http://127.0.0.1:" + str(SITE_PORT) + " study-web")
    print("详见 README「二十三、手机访问与用自己域名上线」。")
    return 0


def main() -> int:
    action = (sys.argv[1] if len(sys.argv) > 1 else "start").strip().lower()
    if action in ("start", "up", "on"):
        return start()
    if action in ("stop", "down", "off"):
        return stop()
    if action == "status":
        return status()
    if action == "check":
        return check()
    print("用法：tunnel.py [start|stop|status|check]")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())