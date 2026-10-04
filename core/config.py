"""全局配置：所有可调参数集中在这里，改这一处即可。"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# ---- 资料目录（只读！程序绝不向这里写入任何内容）----
# 本机真实路径放在 storage.json 的 source_root 里（那个文件不进版本库），
# 所以这里给一个中性默认值：别人 clone 下来改成自己的目录即可，
# 也可以用环境变量 STUDY_SOURCE_ROOT 覆盖（优先级最高）。
DEFAULT_SOURCE_ROOT = Path(r"D:\学习资料")


def _initial_source_root() -> Path:
    env = os.environ.get("STUDY_SOURCE_ROOT")
    if env and str(env).strip():
        return Path(str(env).strip())
    try:
        raw = json.loads((BASE_DIR / "storage.json").read_text(encoding="utf-8"))
        value = str((raw or {}).get("source_root") or "").strip()
        if value:
            return Path(value)
    except Exception:
        pass
    return DEFAULT_SOURCE_ROOT


SOURCE_ROOT = _initial_source_root()

# ---- 额外资料目录（只读；管理端可以增删，存在 storage.json 的 source_roots 里）----
# 第一项永远是默认资料目录（id 为空字符串，数据库里仍旧记作 library，老数据不受影响）。
SOURCE_ROOTS_MAX = 12


def source_roots() -> list:
    roots = [{"id": "", "name": "默认资料目录", "path": str(SOURCE_ROOT), "enabled": True}]
    stored = read_settings().get("source_roots")
    if isinstance(stored, list):
        for node in stored:
            if not isinstance(node, dict):
                continue
            rid = str(node.get("id") or "").strip()
            path = str(node.get("path") or "").strip()
            if not rid or not path:
                continue
            roots.append({"id": rid, "name": str(node.get("name") or "").strip() or rid,
                          "path": path, "enabled": bool(node.get("enabled", True))})
    return roots


def save_source_roots(roots) -> list:
    clean = []
    for node in roots or []:
        if not isinstance(node, dict):
            continue
        rid = str(node.get("id") or "").strip()
        path = str(node.get("path") or "").strip()
        if not rid or not path:
            continue
        clean.append({"id": rid, "name": str(node.get("name") or "").strip(),
                      "path": path, "enabled": bool(node.get("enabled", True))})
    save_settings({"source_roots": clean})
    return source_roots()


def new_source_id() -> str:
    return "r" + secrets.token_hex(4)


# ---- 项目数据目录（可以在网页里改到别的位置）----
SETTINGS_PATH = BASE_DIR / "storage.json"
DEFAULT_DATA_DIR = BASE_DIR / "data"


def read_settings() -> dict:
    """storage.json 里存着数据目录和 AI 接入方式，管理端可以改。

    别的进程（管理端保存、命令行脚本）正好在重写这个文件时，可能读到写了一半的内容；
    那样会把整份配置读成空的（AI 设置、站点名都会瞬间"消失"）。所以这里等一下再读。
    """
    for attempt in range(4):
        try:
            if not SETTINGS_PATH.exists():
                return {}
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
            return {}
        except (OSError, ValueError):
            if attempt == 3:
                return {}
            time.sleep(0.04)
    return {}


def save_settings(patch: dict) -> None:
    data = read_settings()
    data.update(patch or {})
    # 先写临时文件再原子替换：别人读的时候不会读到写了一半的半截 JSON。
    tmp = SETTINGS_PATH.with_name(SETTINGS_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, SETTINGS_PATH)


# ---- 注册方式（管理端可以改：需要邀请码 / 开放注册）----
REG_MODES = ("invite", "open")
# 去掉了容易看错的 I O 0 1
_INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_invite_code(length: int = 8) -> str:
    return "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(length))


def registration_settings() -> dict:
    """返回注册方式。默认需要邀请码；第一个账号永远放行（否则没人能建管理员）。"""
    data = read_settings()
    mode = str(data.get("registration") or "invite").strip().lower()
    if mode not in REG_MODES:
        mode = "invite"
    code = str(data.get("invite_code") or "").strip().upper()
    if mode == "invite" and not code:
        code = new_invite_code()
        save_settings({"invite_code": code})
    return {"mode": mode, "open": mode == "open", "invite_code": code}


def save_registration(mode=None, invite_code=None) -> dict:
    patch = {}
    if mode in REG_MODES:
        patch["registration"] = mode
    if invite_code is not None:
        patch["invite_code"] = str(invite_code).strip().upper()
    if patch:
        save_settings(patch)
    return registration_settings()


# ---- 公网静态版「连接服务器」 ----
# 单文件版自己抓不了网页（浏览器跨域限制），也存不进服务器。让它可以借用本机
# 抓取能力：只做“搜索 + 抓正文”，抓到的内容回给访客的浏览器保存，不落本机硬盘。
# 默认关闭；打开后要凭连接码调用，免得被陌生人当成免费代理。
def bridge_settings() -> dict:
    """公网版借用本机抓取用的开关和连接码。默认关闭。"""
    data = read_settings()
    node = data.get("bridge") or {}
    enabled = bool(node.get("enabled"))
    token = str(node.get("token") or "").strip().upper()
    if enabled and len(token) < 8:
        token = new_invite_code(12)
        save_settings({"bridge": {"enabled": True, "token": token}})
    return {"enabled": enabled, "token": token}


def save_bridge(enabled=None, token=None, regenerate=False) -> dict:
    node = dict(read_settings().get("bridge") or {})
    if enabled is not None:
        node["enabled"] = bool(enabled)
    if regenerate:
        node["token"] = new_invite_code(12)
    elif token is not None:
        node["token"] = str(token).strip().upper()
    if node.get("enabled") and len(str(node.get("token") or "").strip()) < 8:
        node["token"] = new_invite_code(12)
    save_settings({"bridge": {"enabled": bool(node.get("enabled")),
                              "token": str(node.get("token") or "").strip().upper()}})
    return bridge_settings()


def _stored_data_dir():
    """数据目录记在 storage.json 里，用户可以在「我的」页面改。"""
    try:
        data = read_settings()
        if data:
            value = str((data or {}).get("data_dir") or "").strip()
            if value:
                candidate = Path(value).expanduser()
                anchor = candidate.anchor
                if anchor and not Path(anchor).exists():
                    return None
                return candidate
    except Exception:
        pass
    return None


DATA_DIR = _stored_data_dir() or DEFAULT_DATA_DIR
UPLOAD_DIR = DATA_DIR / "uploads"
THUMB_DIR = DATA_DIR / "thumbs"
CACHE_DIR = DATA_DIR / "cache"
EXPORT_DIR = DATA_DIR / "exports"
DIST_DIR = BASE_DIR / "dist"
DB_PATH = DATA_DIR / "study.db"
SECRET_PATH = DATA_DIR / "secret.key"
BASELINE_PATH = DATA_DIR / "baseline_source.txt"
WEB_DIR = BASE_DIR / "web"

DATA_SUBDIRS = ("uploads", "thumbs", "cache", "exports")
DATA_FILES = ("study.db", "study.db-wal", "study.db-shm", "secret.key", "baseline_source.txt")

# ---- 服务 ----
HOST = os.environ.get("STUDY_HOST", "0.0.0.0")
PORT = int(os.environ.get("STUDY_PORT", "8787"))

# ---- 模型接入（默认走本机代理，免密钥；也可以在管理端换成别的 OpenAI 兼容接口）----
AI_DEFAULTS = {
    "base_url": os.environ.get("STUDY_AI_BASE", "http://127.0.0.1:15721/v1"),
    "api_key": os.environ.get("STUDY_AI_KEY", ""),
    "model_text": "deepseek-v4-pro",
    "model_vision": "deepseek-flash",
}

AI_BASE_URL = AI_DEFAULTS["base_url"]
AI_API_KEY = AI_DEFAULTS["api_key"]
AI_CHAT_URL = AI_BASE_URL.rstrip("/") + "/chat/completions"
MODEL_VISION = AI_DEFAULTS["model_vision"]
MODEL_TEXT = AI_DEFAULTS["model_text"]


def ai_settings() -> dict:
    """把用户改过的 AI 设置叠加到默认值上。"""
    merged = dict(AI_DEFAULTS)
    stored = read_settings().get("ai") or {}
    for key in merged:
        value = str(stored.get(key) or "").strip()
        if value:
            merged[key] = value
    return merged


def apply_ai_settings(base_url=None, api_key=None, model_text=None, model_vision=None) -> dict:
    """改完立刻生效，不用重启。"""
    global AI_BASE_URL, AI_API_KEY, AI_CHAT_URL, MODEL_TEXT, MODEL_VISION
    current = ai_settings()
    if base_url is not None:
        current["base_url"] = str(base_url).strip() or AI_DEFAULTS["base_url"]
    if api_key is not None:
        current["api_key"] = str(api_key).strip()
    if model_text is not None:
        current["model_text"] = str(model_text).strip() or AI_DEFAULTS["model_text"]
    if model_vision is not None:
        current["model_vision"] = str(model_vision).strip() or AI_DEFAULTS["model_vision"]
    current["allow_shared_ai"] = allow_shared_ai()
    save_settings({"ai": current})
    AI_BASE_URL = current["base_url"]
    AI_API_KEY = current["api_key"]
    AI_CHAT_URL = AI_BASE_URL.rstrip("/") + "/chat/completions"
    MODEL_TEXT = current["model_text"]
    MODEL_VISION = current["model_vision"]
    return current


def allow_shared_ai() -> bool:
    """局域网里是否允许别人共用管理员的 AI。默认关闭，免得花掉管理员的额度。"""
    return bool((read_settings().get("ai") or {}).get("allow_shared_ai"))


def save_allow_shared_ai(flag: bool) -> bool:
    conf = read_settings()
    ai = dict(conf.get("ai") or {})
    ai["allow_shared_ai"] = bool(flag)
    save_settings({"ai": ai})
    return bool(flag)


AI_TIMEOUT = 240
AI_ANIM_TIMEOUT = 180
AI_ANIM_TOKENS = 20000
AI_DEEP_TIMEOUT = 420
AI_MAX_CONCURRENCY = 2
AI_FALLBACKS = {
    "text": ["deepseek-v4-pro", "deepseek-flash"],
    "vision": ["deepseek-flash"],
}
AI_IS_LOCAL_PROXY = AI_BASE_URL.rstrip("/") == AI_DEFAULTS["base_url"].rstrip("/")

# 启动时把用户存过的 AI 设置叠上去
_overlay = ai_settings()
AI_BASE_URL = _overlay["base_url"]
AI_API_KEY = _overlay["api_key"]
AI_CHAT_URL = AI_BASE_URL.rstrip("/") + "/chat/completions"
MODEL_TEXT = _overlay["model_text"]
MODEL_VISION = _overlay["model_vision"]
AI_IS_LOCAL_PROXY = AI_BASE_URL.rstrip("/") == AI_DEFAULTS["base_url"].rstrip("/")

# ---- 文本提取 / 页面渲染 ----
RENDER_MAX_SIDE = 1500
RENDER_QUALITY = 80
VISION_MAX_PAGES_PER_DOC = 120
MIN_PAGE_TEXT_CHARS = 15
EXTRACT_MAX_PAGES = 2000
XLSX_MAX_ROWS = 300
XLSX_MAX_COLS = 40
TXT_MAX_BYTES = 2000000

# ---- 导出 ----
EXPORT_MAX_INLINE_IMAGE = 2 * 1024 * 1024
EXPORT_MAX_INLINE_PDF = 8 * 1024 * 1024
EXPORT_WARN_BYTES = 20 * 1024 * 1024
EXPORT_BUNDLE_MAX_BYTES = 3 * 1024 * 1024 * 1024

UNCLASSIFIED = "未分类"
MODEL_SUBJECT = "模型动画"

_lock = threading.Lock()


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOAD_DIR, THUMB_DIR, CACHE_DIR, EXPORT_DIR, WEB_DIR):
        d.mkdir(parents=True, exist_ok=True)


def check_source_root(folder, roots=None) -> tuple:
    """检查这个位置能不能当只读资料目录。返回 (是否可以, 说明)。"""
    raw = str(folder or "").strip()
    if not raw:
        return False, "请填写目录的完整路径"
    target = Path(raw).expanduser()
    if not target.is_absolute():
        return False, "请填写完整的绝对路径，例如 E:" + chr(92) + "我的资料"
    try:
        resolved = target.resolve()
    except OSError:
        return False, "这个路径解析不了：" + raw
    if not resolved.exists():
        return False, "这个目录不存在：" + str(resolved)
    if not resolved.is_dir():
        return False, "这不是一个文件夹：" + str(resolved)
    if resolved.parent == resolved:
        return False, "不能把整个磁盘当资料目录，请选具体某个文件夹"
    for blocked in (Path(os.environ.get("SystemRoot", "C:" + chr(92) + "Windows")).resolve(),
                    BASE_DIR.resolve()):
        try:
            resolved.relative_to(blocked)
            return False, "这个目录是系统或程序自己的目录，不能当资料目录：" + str(resolved)
        except ValueError:
            pass
    for base in (DATA_DIR.resolve(), UPLOAD_DIR.resolve()):
        try:
            resolved.relative_to(base)
            return False, "不能把程序自己的数据目录当资料目录"
        except ValueError:
            pass
    existing = roots if roots is not None else source_roots()
    for node in existing:
        try:
            other = Path(str(node.get("path") or "")).resolve()
        except OSError:
            continue
        if other == resolved:
            return False, "这个目录已经在列表里了：" + str(resolved)
        try:
            resolved.relative_to(other)
            return False, "这个目录已经在「" + str(node.get("name") or "") + "」里面了，不用重复添加"
        except ValueError:
            pass
        try:
            other.relative_to(resolved)
            return False, "「" + str(node.get("name") or "") + "」在这个目录里面，会重复，换一个目录吧"
        except ValueError:
            pass
    return True, ""


def check_data_dir(folder) -> tuple:
    """检查这个位置能不能用来放数据。返回 (是否可以, 说明)。"""
    target = Path(folder).expanduser()
    if not target.is_absolute():
        return False, "请填写完整的绝对路径，例如 D:\\学习网页数据"
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, "这个位置建不了文件夹：" + str(exc)
    probe = target / ".studyweb-write-test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return False, "这个位置写不进去（可能没有权限）：" + str(exc)
    try:
        if shutil.disk_usage(str(target)).free < 200 * 1024 * 1024:
            return False, "这个盘剩余空间不足 200 MB"
    except OSError:
        pass
    return True, ""


def save_data_dir(folder) -> None:
    save_settings({"data_dir": str(Path(folder).expanduser())})


def copy_data_to(folder) -> int:
    """把当前数据目录里的数据库、上传、缓存、导出成品复制过去，返回复制的文件数。"""
    target = Path(folder).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    copied = 0
    for name in DATA_SUBDIRS:
        source = DATA_DIR / name
        if not source.exists():
            continue
        for item in source.rglob("*"):
            if not item.is_file():
                continue
            destination = target / name / item.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                shutil.copy2(item, destination)
                copied += 1
    for name in DATA_FILES:
        source = DATA_DIR / name
        if source.exists():
            destination = target / name
            if not destination.exists() or name.startswith("study.db"):
                shutil.copy2(source, destination)
                copied += 1
    return copied


def secret_key() -> bytes:
    ensure_dirs()
    with _lock:
        if SECRET_PATH.exists():
            value = SECRET_PATH.read_bytes()
            if value:
                return value
        value = os.urandom(32)
        SECRET_PATH.write_bytes(value)
        return value


# ---- 站点外观（管理端设置，所有人可见）----
DEFAULT_SITE = {"name": "我的学习网页", "announcement": "",
                "theme": "", "allow_user_theme": True}


def site_settings() -> dict:
    node = read_settings().get("site") or {}
    out = dict(DEFAULT_SITE)
    if isinstance(node, dict):
        for key in DEFAULT_SITE:
            if key in node:
                out[key] = node[key]
    out["name"] = str(out["name"] or DEFAULT_SITE["name"]).strip()[:40] or DEFAULT_SITE["name"]
    out["announcement"] = str(out["announcement"] or "").strip()[:500]
    out["theme"] = out["theme"] if isinstance(out["theme"], dict) else ""
    out["allow_user_theme"] = bool(out["allow_user_theme"])
    return out


def save_site(patch: dict) -> dict:
    node = dict(read_settings().get("site") or {})
    for key in DEFAULT_SITE:
        if key in (patch or {}):
            node[key] = patch[key]
    save_settings({"site": node})
    return site_settings()


# ---- HTTPS：局域网里要用「选文件夹」功能就必须是安全上下文，所以要开 TLS ----
def tls_settings() -> dict:
    node = read_settings().get("tls") or {}
    return {"enabled": bool(node.get("enabled")), "port": int(node.get("port") or PORT),
            "http_port": int(node.get("http_port") or (PORT + 1)),
            "cert_dir": str(DATA_DIR / "tls")}


def save_tls(enabled=None, port=None) -> dict:
    node = dict(read_settings().get("tls") or {})
    if enabled is not None:
        node["enabled"] = bool(enabled)
    if port is not None:
        node["port"] = int(port)
    save_settings({"tls": node})
    return tls_settings()


# ---- 自动扫描：默认关闭，管理端可以开；开了以后服务自己隔一段时间重扫一次资料目录 ----
SCAN_MIN_MINUTES = 5
SCAN_MAX_MINUTES = 1440


def scan_settings() -> dict:
    node = read_settings().get("scan") or {}
    try:
        minutes = int(node.get("minutes") or 30)
    except (TypeError, ValueError):
        minutes = 30
    minutes = max(SCAN_MIN_MINUTES, min(SCAN_MAX_MINUTES, minutes))
    return {"enabled": bool(node.get("enabled")), "minutes": minutes,
            "dir": str(SOURCE_ROOT), "min_minutes": SCAN_MIN_MINUTES,
            "max_minutes": SCAN_MAX_MINUTES}


def save_scan(enabled=None, minutes=None) -> dict:
    node = dict(read_settings().get("scan") or {})
    if enabled is not None:
        node["enabled"] = bool(enabled)
    if minutes is not None:
        try:
            node["minutes"] = int(minutes)
        except (TypeError, ValueError):
            raise ValueError("间隔要填分钟数（整数）")
    save_settings({"scan": node})
    return scan_settings()


# ---- 公网静态版：产物里绝不允许出现的「本机痕迹」----
def webbuild_forbidden() -> list:
    """构建公网单文件版时要检查的本机痕迹（自己的用户名、本机路径片段等）。

    这些串不该写进代码 —— 那等于把本机信息跟着代码一起公开发布。
    所以放在 storage.json 的 webbuild.forbidden 列表里，默认空列表，
    谁用谁按自己机器的实际情况填（管理端的构建自检就按这个列表拒绝出包）。
    """
    node = read_settings().get("webbuild") or {}
    values = node.get("forbidden")
    out = []
    if isinstance(values, list):
        for item in values:
            text = str(item or "").strip()
            if text and text not in out:
                out.append(text)
    return out

