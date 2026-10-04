"""打印本机网站该用哪个地址打开：开了自签 HTTPS 就是 https://127.0.0.1:8787。

给 启动.bat 用 —— 批处理里不好读 storage.json，所以让它问一下 Python。
"""
from __future__ import annotations

import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from core import config  # noqa: E402


def site_url() -> str:
    """本机打开的网址。开了 HTTPS 时，8787 是 TLS 代理，所以必须是 https。"""
    conf = config.tls_settings()
    scheme = "https" if conf["enabled"] else "http"
    return scheme + "://127.0.0.1:" + str(conf["port"])


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print(site_url())
