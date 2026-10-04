"""账号系统：scrypt 加盐哈希 + Flask 签名会话。开放注册，第一个账号是管理员。"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import jsonify, session

from . import db

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
DKLEN = 32


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                        p=SCRYPT_P, dklen=DKLEN)
    return "$".join(["scrypt", str(SCRYPT_N), str(SCRYPT_R), str(SCRYPT_P),
                     salt.hex(), dk.hex()])


def verify_password(password: str, stored: str) -> bool:
    try:
        parts = str(stored).split("$")
        if len(parts) != 6 or parts[0] != "scrypt":
            return False
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt = bytes.fromhex(parts[4])
        expected = bytes.fromhex(parts[5])
        dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                            dklen=len(expected))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


AVATARS = ("🙂", "🐱", "🐼", "🦊", "🐳", "🌱", "🍀", "⭐", "🚀", "🎧", "📚", "⚡")
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_MINUTES = 10


def _field(row, name, default=""):
    try:
        value = row[name]
    except Exception:
        return default
    return default if value is None else value


def public_user(row) -> dict:
    if not row:
        return None
    theme = {}
    raw = str(_field(row, "theme_json", "") or "")
    if raw:
        try:
            data = json.loads(raw)
            theme = data if isinstance(data, dict) else {}
        except Exception:
            theme = {}
    ai = {}
    raw_ai = str(_field(row, "ai_json", "") or "")
    if raw_ai:
        try:
            data = json.loads(raw_ai)
            ai = data if isinstance(data, dict) else {}
        except Exception:
            ai = {}
    return {
        "id": row["id"],
        "username": row["username"],
        "nickname": str(_field(row, "nickname", "") or ""),
        "avatar": str(_field(row, "avatar", "") or "🙂"),
        "theme": theme,
        "is_admin": bool(row["is_admin"]),
        "created_at": row["created_at"],
        "disabled": bool(_field(row, "disabled", 0)),
        "last_login_at": str(_field(row, "last_login_at", "") or ""),
        "last_ip": str(_field(row, "last_ip", "") or ""),
        "has_own_ai": bool(ai.get("api_key")),
        "session_version": int(_field(row, "session_version", 0) or 0),
    }


def validate_credentials(username: str, password: str) -> str:
    username = (username or "").strip()
    if len(username) < 2 or len(username) > 20:
        return "用户名长度需在 2 到 20 个字符之间"
    for ch in " \t\n/\x5c":
        if ch in username:
            return "用户名不能包含空格或斜杠"
    if len(password or "") < 6:
        return "密码至少 6 位"
    if len(password) > 128:
        return "密码过长"
    return ""


def check_invite(code: str):
    """注册前的门禁：返回 (是否放行, 拒绝原因)。

    规则：库里一个账号都没有时永远放行（第一个账号必须是管理员，否则谁也进不来）；
    其余情况看管理端设的注册方式——「开放注册」放行，「需要邀请码」必须对得上。
    """
    from . import config
    conn = db.connect()
    total = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if total == 0:
        return True, ""
    conf = config.registration_settings()
    if conf["open"]:
        return True, ""
    if not conf["invite_code"]:
        return False, "管理员还没有设置邀请码，请联系管理员"
    entered = (code or "").strip().upper()
    if not entered:
        return False, "这个网站需要邀请码才能注册，请向管理员要一个"
    if entered != conf["invite_code"]:
        return False, "邀请码不对，请向管理员再确认一次"
    return True, ""


def register(username: str, password: str):
    username = (username or "").strip()
    err = validate_credentials(username, password)
    if err:
        return None, err
    conn = db.connect()
    if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
        return None, "这个用户名已经被注册了"
    total = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    is_admin = 1 if total == 0 else 0
    with db.tx() as tx:
        cur = tx.execute(
            "INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?,?,?,?)",
            (username, hash_password(password), is_admin, now_iso()),
        )
        user_id = cur.lastrowid
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return public_user(row), ""


def authenticate(username: str, password: str):
    """返回 (用户, 失败原因)。"""
    conn = db.connect()
    row = conn.execute("SELECT * FROM users WHERE username=?",
                       ((username or "").strip(),)).fetchone()
    if not row or not verify_password(password or "", row["password_hash"]):
        return None, "用户名或密码不正确"
    if row["disabled"]:
        return None, "这个账号已被管理员停用，请联系管理员"
    return public_user(row), ""


def user_id_by_name(username: str):
    row = db.connect().execute("SELECT id FROM users WHERE username=?",
                               ((username or "").strip(),)).fetchone()
    return row["id"] if row else None


def mark_login(user_id, ip: str = "") -> None:
    with db.tx() as conn:
        conn.execute("UPDATE users SET last_login_at=?, last_ip=?, login_fails=0 WHERE id=?",
                     (now_iso(), ip or "", user_id))


def bump_login_fail(user_id) -> None:
    if not user_id:
        return
    with db.tx() as conn:
        conn.execute("UPDATE users SET login_fails=login_fails+1 WHERE id=?", (user_id,))


def get_user(user_id):
    row = db.connect().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return public_user(row)


def current_user():
    """带会话版本号：改密码 / 登出全部设备之后，旧的登录会立刻失效。"""
    uid = session.get("uid")
    if not uid:
        return None
    row = db.connect().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        session.clear()
        return None
    if int(_field(row, "session_version", 0) or 0) != int(session.get("sv") or 0):
        session.clear()
        return None
    return public_user(row)


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"ok": False, "error": "请先登录", "need_login": True}), 401
        if user.get("disabled"):
            session.clear()
            return jsonify({"ok": False, "error": "这个账号已被管理员停用", "need_login": True}), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"ok": False, "error": "请先登录", "need_login": True}), 401
        if not user["is_admin"]:
            return jsonify({"ok": False, "error": "只有管理员可以操作"}), 403
        return fn(*args, **kwargs)
    return wrapper


def list_users() -> list:
    rows = db.connect().execute(
        "SELECT * FROM users ORDER BY id ASC").fetchall()
    return [public_user(r) for r in rows]


def list_users_full() -> list:
    rows = db.connect().execute("SELECT * FROM users ORDER BY id ASC").fetchall()
    return [public_user(r) for r in rows]


def set_disabled(user_id, disabled: bool) -> bool:
    with db.tx() as conn:
        cur = conn.execute("UPDATE users SET disabled=? WHERE id=?",
                           (1 if disabled else 0, user_id))
        return bool(cur.rowcount)


def set_password(user_id, password: str) -> str:
    if len(password or "") < 6:
        return "密码至少 6 位"
    with db.tx() as conn:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (hash_password(password), user_id))
    return ""


def delete_user(user_id) -> int:
    """删账号，连带删掉他自己的上传、笔记、收藏、做题记录。返回删除的资料数。"""
    from . import config
    from pathlib import Path
    conn = db.connect()
    rows = conn.execute("SELECT id, rel_path FROM materials WHERE owner_id=?", (user_id,)).fetchall()
    removed = 0
    ids = []
    for row in rows:
        ids.append(row["id"])
        source, _, rel = str(row["rel_path"]).partition("|")
        if source != "upload" or not rel:
            continue
        path = (config.UPLOAD_DIR / Path(rel)).resolve()
        try:
            path.relative_to(config.UPLOAD_DIR.resolve())
        except ValueError:
            continue
        if path.exists():
            path.unlink()
            removed += 1
    with db.tx() as tx:
        for material_id in ids:
            tx.execute("DELETE FROM texts WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM texts_fts WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM summaries WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM notes WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM favorites WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM quiz_attempts WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM progress WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM materials WHERE id=?", (material_id,))
        tx.execute("DELETE FROM audit_log WHERE user_id=?", (user_id,))
        tx.execute("DELETE FROM users WHERE id=?", (user_id,))
    return removed


def get_prefs(user_id) -> dict:
    """个人资料 + 外观设置。"""
    row = db.connect().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        return {}
    theme = {}
    raw = str(_field(row, "theme_json", "") or "")
    if raw:
        try:
            data = json.loads(raw)
            theme = data if isinstance(data, dict) else {}
        except Exception:
            theme = {}
    return {"nickname": str(_field(row, "nickname", "") or ""),
            "avatar": str(_field(row, "avatar", "") or "🙂"),
            "theme": theme}


def save_prefs(user_id, nickname=None, avatar=None, theme=None):
    sets = []
    params = []
    if nickname is not None:
        sets.append("nickname=?")
        params.append(str(nickname).strip()[:20])
    if avatar is not None:
        value = str(avatar).strip()
        if value and value not in AVATARS:
            return {}, "这个头像不在可选列表里"
        sets.append("avatar=?")
        params.append(value)
    if theme is not None:
        if not isinstance(theme, dict):
            return {}, "主题格式不对"
        text = json.dumps(theme, ensure_ascii=False)
        if len(text) > 6000:
            return {}, "主题设置太大，请把壁纸换成小一点的图片"
        sets.append("theme_json=?")
        params.append(text)
    if not sets:
        return get_prefs(user_id), ""
    params.append(user_id)
    with db.tx() as conn:
        conn.execute("UPDATE users SET " + ", ".join(sets) + " WHERE id=?", params)
    return get_prefs(user_id), ""


def password_hash(user_id) -> str:
    row = db.connect().execute("SELECT password_hash FROM users WHERE id=?", (user_id,)).fetchone()
    return row["password_hash"] if row else ""


def session_version(user_id) -> int:
    row = db.connect().execute("SELECT session_version FROM users WHERE id=?", (user_id,)).fetchone()
    return int(row["session_version"] or 0) if row else 0


def bump_session_version(user_id) -> int:
    with db.tx() as conn:
        conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=?", (user_id,))
    return session_version(user_id)


def user_ai(user_id) -> dict:
    """用户自己存到服务器上的 AI 接入方式（默认不存在浏览器里）。"""
    row = db.connect().execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    raw = str(_field(row, "ai_json", "") or "") if row else ""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def save_user_ai(user_id, base_url=None, api_key=None, model_text=None,
                 model_vision=None) -> dict:
    conf = user_ai(user_id)
    if base_url is not None:
        conf["base_url"] = str(base_url).strip()
    if api_key:
        conf["api_key"] = str(api_key).strip()
    if model_text is not None:
        conf["model_text"] = str(model_text).strip()
    if model_vision is not None:
        conf["model_vision"] = str(model_vision).strip()
    with db.tx() as conn:
        conn.execute("UPDATE users SET ai_json=? WHERE id=?",
                     (json.dumps(conf, ensure_ascii=False), user_id))
    return conf


def clear_user_ai(user_id) -> None:
    with db.tx() as conn:
        conn.execute("UPDATE users SET ai_json='' WHERE id=?", (user_id,))


# 重置码只用这些字符：去掉了容易看错的 I / O / 0 / 1。
RESET_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
RESET_TTL_MINUTES = 15


def quota_mb(user_id) -> int:
    """这个账号在服务器端的上传配额（MB）。0 = 不限。"""
    row = db.connect().execute("SELECT quota_mb FROM users WHERE id=?", (user_id,)).fetchone()
    try:
        return max(0, int(_field(row, "quota_mb", 0) or 0))
    except (TypeError, ValueError):
        return 0


def set_quota(user_id, quota_mb) -> int:
    value = max(0, int(quota_mb or 0))
    with db.tx() as conn:
        conn.execute("UPDATE users SET quota_mb=? WHERE id=?", (value, user_id))
    return value


def used_bytes(user_id) -> int:
    row = db.connect().execute(
        "SELECT COALESCE(SUM(size), 0) AS n FROM materials"
        " WHERE source='upload' AND owner_id=?", (user_id,)).fetchone()
    return int(row["n"] or 0) if row else 0


def make_reset_code(user_id) -> dict:
    """生成一次性重置码（默认 15 分钟内有效，只显示这一次）。旧码作废。"""
    row = db.connect().execute("SELECT id, username FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        return {}
    code = "".join(secrets.choice(RESET_CODE_ALPHABET) for _ in range(8))
    expires = (datetime.now(timezone.utc).astimezone()
               + timedelta(minutes=RESET_TTL_MINUTES)).isoformat(timespec="seconds")
    with db.tx() as conn:
        conn.execute("DELETE FROM password_resets WHERE user_id=? AND used_at=''", (user_id,))
        conn.execute(
            "INSERT INTO password_resets(user_id, username, code_hash, expires_at, used_at, created_at)"
            " VALUES(?,?,?,?,?,?)",
            (user_id, str(row["username"]), hash_password(code), expires, "", now_iso()),
        )
    return {"code": code, "expires_at": expires, "username": str(row["username"]),
            "minutes": RESET_TTL_MINUTES}


def use_reset_code(username: str, code: str, new_password: str):
    """拿一次性重置码换新密码。返回 (user_id 或 None, 错误说明)。"""
    name = (username or "").strip()
    text = (code or "").strip().upper()
    if not name or not text:
        return None, "请填用户名和重置码"
    err = validate_credentials(name, new_password)
    if err:
        return None, err
    row = db.connect().execute(
        "SELECT * FROM password_resets WHERE username=? AND used_at='' ORDER BY id DESC LIMIT 1",
        (name,)).fetchone()
    if not row:
        return None, "重置码不对，或者已经用过了。请让管理员重新生成一个。"
    try:
        expires = datetime.fromisoformat(str(_field(row, "expires_at", "")))
    except ValueError:
        expires = None
    if expires is None or datetime.now(timezone.utc) > expires.astimezone(timezone.utc):
        return None, "重置码过期了（" + str(RESET_TTL_MINUTES) + " 分钟内要用掉）。请让管理员重新生成一个。"
    if not verify_password(text, str(_field(row, "code_hash", ""))):
        return None, "重置码不对，或者已经用过了。请让管理员重新生成一个。"
    user_id = int(row["user_id"])
    with db.tx() as conn:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (hash_password(new_password), user_id))
        conn.execute("UPDATE password_resets SET used_at=? WHERE id=?", (now_iso(), row["id"]))
    bump_session_version(user_id)
    return user_id, ""


def set_admin(user_id, is_admin: bool) -> bool:
    with db.tx() as conn:
        cur = conn.execute("UPDATE users SET is_admin=? WHERE id=?",
                           (1 if is_admin else 0, user_id))
        return bool(cur.rowcount)


def login_locked(username: str):
    """15 分钟内失败满 5 次就锁 10 分钟。返回 (是否锁定, 提示)。"""
    name = (username or "").strip()
    if not name:
        return False, ""
    conn = db.connect()
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM audit_log WHERE action='login_fail' AND username=?"
        " AND datetime(created_at) >= datetime('now','-15 minutes')", (name,)).fetchone()
    if int(row["c"] or 0) < LOGIN_MAX_FAILS:
        return False, ""
    last = conn.execute(
        "SELECT MAX(created_at) AS t FROM audit_log WHERE action='login_fail' AND username=?",
        (name,)).fetchone()
    stamp = str((last["t"] if last else "") or "")
    if not stamp:
        return False, ""
    try:
        when = datetime.fromisoformat(stamp)
    except Exception:
        return False, ""
    now = datetime.now(when.tzinfo) if when.tzinfo else datetime.now()
    if now >= when + timedelta(minutes=LOGIN_LOCK_MINUTES):
        return False, ""
    return True, ("登录失败次数太多，请等 " + str(LOGIN_LOCK_MINUTES)
                  + " 分钟后再试，或者找管理员重置密码。")
