"""公网静态版构建器：把学习界面 + 模型动画 + 工具打包成一个自包含的 HTML 文件。

产物里不含任何资料、账号、笔记或密钥；使用者上传的文件只存在他自己的浏览器里。
"""
from __future__ import annotations

import base64
import hashlib
import html
import secrets
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import config, db

PDFJS_VERSION = "3.11.174"
PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VERSION + "/build/"
GATE_ITERATIONS = 150000
# 去掉了容易看错的 I O 0 1
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PRODUCT_NAME = "学习工具.html"


# ---------------- 分享码 ----------------
def new_share_code(length: int = 8) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def hash_code(code: str, salt: bytes, iterations: int = GATE_ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt, iterations).hex()


def share_code() -> str:
    """当前分享码；没有就自动生成一个存进 storage.json。"""
    conf = config.read_settings()
    code = str((conf.get("webbuild") or {}).get("share_code") or "").strip()
    if len(code) < 4:
        code = new_share_code()
        save_share_code(code)
    return code


def save_share_code(code: str) -> str:
    code = str(code or "").strip()
    if len(code) < 4:
        raise ValueError("分享码至少要 4 位")
    config.save_settings({"webbuild": {"share_code": code}})
    return code


def regenerate_share_code() -> str:
    return save_share_code(new_share_code())


# ---------------- 资源 ----------------
def _b64_js(data: bytes, chunk: int = 900) -> str:
    """把 base64 拆成若干短行再拼起来，避免产物出现超长单行（网页上传器会拒绝）。"""
    s = base64.b64encode(data).decode("ascii")
    parts = [s[i:i + chunk] for i in range(0, len(s), chunk)]
    return "\"" + "\" +\n\"".join(parts) + "\""

def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _download(url: str, target: Path) -> bytes:
    if target.exists() and target.stat().st_size > 100000:
        return target.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "study-web-builder"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = resp.read()
    if len(data) < 100000:
        raise RuntimeError("下载 pdf.js 失败：内容不完整")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return data


def ensure_pdfjs() -> tuple:
    """拿到 pdf.js 主库和 worker（带缓存，只下一次）。"""
    lib = _download(PDFJS_BASE + "pdf.min.js", config.CACHE_DIR / ("pdfjs-" + PDFJS_VERSION + "-lib.js"))
    worker = _download(PDFJS_BASE + "pdf.worker.min.js",
                       config.CACHE_DIR / ("pdfjs-" + PDFJS_VERSION + "-worker.js"))
    return lib, worker


# ---------------- 上线前自检 ----------------
def audit_build(text: str) -> list:
    """产物里绝对不能出现任何私人内容，命中就拒绝出包。"""
    problems = []
    key = str(config.ai_settings().get("api_key") or "").strip()
    if len(key) >= 12 and key in text:
        problems.append("出现了你自己的 AI 密钥")
    for token in config.webbuild_forbidden():
        if token in text:
            problems.append("出现了本机痕迹「" + token + "」（在 storage.json 的 webbuild.forbidden 里配的）")
    for token in ("study.db", "secret.key", "storage.json", "baseline_source"):
        if token in text:
            problems.append("出现了本机文件名 " + token)
    conn = db.connect()
    leaked = []
    for row in conn.execute("SELECT name FROM materials").fetchall():
        name = str(row["name"] or "")
        if len(name) >= 8 and name in text:
            leaked.append(name)
            if len(leaked) >= 5:
                break
    if leaked:
        problems.append("出现了资料文件名：" + "、".join(leaked))
    return problems


# ---------------- 构建 ----------------
def build(code: str = "", title: str = "学习资料库") -> dict:
    code = str(code or share_code()).strip()
    if len(code) < 4:
        raise ValueError("分享码至少要 4 位")
    css = _read(config.WEB_DIR / "style.css")
    models_js = _read(config.WEB_DIR / "models.js")
    store_js = _read(config.WEB_DIR / "store.js")
    app_js = _read(config.WEB_DIR / "app.js")
    theme_js = _read(config.WEB_DIR / "theme.js")
    folder_js = _read(config.WEB_DIR / "folder.js")
    ui_js = _read(config.WEB_DIR / "ui.js")
    lib, worker = ensure_pdfjs()

    salt = secrets.token_bytes(16)
    digest = hash_code(code, salt)
    boot = (
        "window.STUDY_MODE='local';"
        "window.STUDY_GATE={salt:'" + base64.b64encode(salt).decode("ascii")
        + "',iter:" + str(GATE_ITERATIONS) + ",hash:'" + digest + "'};"
        "window.STUDY_PDFJS_BASE64=" + _b64_js(lib) + ";"
        "window.STUDY_PDFJS_WORKER_BASE64=" + _b64_js(worker) + ";"
    )
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    doc = (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        "<title>" + html.escape(title) + "</title>\n"
        "<meta name=\"description\" content=\"离线可用的资料工具：资料搜索、AI 问答、网络收集、数理化模型动画。"
        "你上传和收集的文件只存在你自己的浏览器里，不会上传到任何服务器。\">\n"
        "<style>" + css + "</style>\n"
        "</head>\n<body>\n"
        "<div id=\"topbar\"></div>\n"
        "<div id=\"app\"><div class=\"loading\">正在加载…</div></div>\n"
        "<div id=\"toast\"></div>\n"
        "<input type=\"file\" id=\"hiddenFile\" style=\"display:none\">\n"
        "<script>" + boot + "</script>\n"
        "<script>" + ui_js + "</script>\n"
        "<script>" + theme_js + "</script>\n"
        "<script>" + models_js + "</script>\n"
        "<script>" + store_js + "</script>\n"
        "<script>" + folder_js + "</script>\n"
        "<script>" + app_js + "</script>\n"
        "</body>\n</html>\n"
    )
    problems = audit_build(doc)
    if problems:
        raise RuntimeError("构建自检没通过，已拒绝出包：" + "；".join(problems))
    raw = doc.encode("utf-8")
    config.DIST_DIR.mkdir(parents=True, exist_ok=True)
    single = config.DIST_DIR / PRODUCT_NAME
    single.write_bytes(raw)
    (config.DIST_DIR / "index.html").write_bytes(raw)
    # 再放一份到仓库的 docs/index.html：GitHub Pages 的「Deploy from a branch」
    # 只允许用仓库根目录或 docs 目录，用不了 dist/。每次重建都自动同步这一份，
    # 免得以后每次上线都要人工拷一遍、迟早会忘。
    pages_dir = config.BASE_DIR / "docs"
    pages_dir.mkdir(parents=True, exist_ok=True)
    pages_index = pages_dir / "index.html"
    pages_index.write_bytes(raw)
    return {
        "ok": True,
        "size": len(raw),
        "path": str(single),
        "built_at": stamp,
        "share_code": code,
        "title": title,
        "files": [str(single), str(config.DIST_DIR / "index.html"), str(pages_index)],
    }