"""学习资料库 —— 本地服务入口（Flask）。资料默认私有，只有本人可见。"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import (Flask, Response, jsonify, redirect, request, send_file,
                   send_from_directory, session)

from core import access, ai, audit, auth, autoscan, backup, catalog, collect, config, db, extract
from core.query import query_grams, query_terms
from core import export as export_mod
from core import webbuild
from core.indexer import INDEXER, bootstrap

KIND_ORDER = ["pdf", "word", "ppt", "excel", "image", "video", "web", "text", "audio", "archive", "other"]

FEEDBACK_KINDS = [
    {"id": "suggestion", "label": "功能建议"},
    {"id": "bug", "label": "问题反馈"},
    {"id": "content", "label": "内容需求"},
    {"id": "other", "label": "其他"},
]
FEEDBACK_KIND_IDS = [k["id"] for k in FEEDBACK_KINDS]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def human_size(num) -> str:
    value = float(num or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return str(int(value)) + " B"
            return ("%.1f" % value) + " " + unit
        value /= 1024.0
    return str(int(value)) + " B"


def create_app() -> Flask:
    config.ensure_dirs()
    db.init_db()
    bootstrap()
    app = Flask(__name__, static_folder=str(config.WEB_DIR), static_url_path="/static")
    app.config["SECRET_KEY"] = config.secret_key()
    app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.json.ensure_ascii = False
    register_routes(app)
    return app


# ---------------- 辅助 ----------------

def visible(user, alias="m"):
    return access.visible_clause(user, alias)


def thumb_file(material_id: int) -> Path:
    return config.THUMB_DIR / (str(material_id) + ".jpg")


def _check_animation_html(html: str):
    """生成的动画必须能离线跑，也只允许是个网页。"""
    text = html or ""
    if len(text) < 400:
        return "生成的内容太短，可能没写成功，换个说法再试一次。"
    if len(text) > 600 * 1024:
        return "生成的文件太大（超过 600 KB），把要求写简单点再试。"
    low = text.lower()
    if "<html" not in low:
        return "生成的内容不是完整的 HTML 文件，请重试。"
    if not any(tag in low for tag in ("<canvas", "<svg", "<script")):
        return "生成的内容里没有画布或脚本，看起来不是动画，请重试。"
    if re.search(r"""(src|href)\s*=\s*["']https?://""", low) or "@import url(http" in low:
        return "生成的动画引用了外部网址，为了离线也能看，已经拒绝保存。请再生成一次。"
    return ""


def local_ips() -> list:
    """这台电脑可能给其他人用的局域网地址：真实网卡排前面，VPN/虚拟网卡排最后。"""
    found = []

    def add(ip):
        if ip and ip not in found and not ip.startswith("127."):
            found.append(ip)

    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            add(ip)
    except Exception:
        pass
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        add(sock.getsockname()[0])
    except Exception:
        pass
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

    def score(ip):
        parts = ip.split(".")
        if len(parts) != 4 or not all(p.isdigit() for p in parts):
            return (9, ip)
        first, second = int(parts[0]), int(parts[1])
        if first == 192 and second == 168:
            return (0, ip)
        if first == 10 and second != 0:
            return (1, ip)
        if first == 172 and 16 <= second <= 31:
            return (2, ip)
        if first == 100 and 64 <= second <= 127:
            return (8, ip)
        if first == 169 and second == 254:
            return (9, ip)
        return (5, ip)

    found.sort(key=score)
    return found


def local_ip() -> str:
    """给别人用的首选地址。以前直接取默认路由，会把 VPN 虚拟网卡（100.64.x.x）当成
    局域网地址发出去，别人根本连不上，所以这里改成按网段挑真实网卡。"""
    ips = local_ips()
    return ips[0] if ips else "127.0.0.1"


def client_ip() -> str:
    try:
        return (request.remote_addr or "")[:60]
    except Exception:
        return ""


AI_LOCKED = ("这台服务器没有开放共用的 AI 额度。"
             "你可以到「我的 → AI 接入」填一个自己的模型接口，用你自己的额度使用 AI。")
BRIDGE_LOCKED = ("这台服务器没有开放给公网版借用抓取，或者连接码不对。"
                 "请让站长在管理端「公网版」里打开开关，并把连接码填进页面。")


def ai_allowed(user) -> bool:
    """管理员随便用；其他人要么管理员开了「共用 AI」，要么自己填了密钥。"""
    if not user:
        return False
    if user.get("is_admin") or config.allow_shared_ai():
        return True
    try:
        return bool(auth.user_ai(user["id"]).get("api_key"))
    except Exception:
        return False


def bridge_token_ok() -> bool:
    """公网单文件版借本机抓网页时的连接码校验（用请求头，不靠 Cookie）。"""
    conf = config.bridge_settings()
    if not conf["enabled"]:
        return False
    user = auth.current_user()
    if user and user.get("is_admin"):
        return True
    given = (request.headers.get("X-Study-Key") or request.args.get("key") or "").strip().upper()
    if not given:
        return False
    return hmac.compare_digest(given, conf["token"])


def readonly_roots() -> list:
    """允许读取的所有资料目录（含被停用的，因为库里可能还留着它们的记录）。"""
    roots = [config.SOURCE_ROOT]
    for node in config.source_roots():
        if node["id"]:
            roots.append(Path(node["path"]))
    return roots


def safe_resolve(row):
    source, _rel = catalog.split_rel(str(row["rel_path"]))
    # 目录已经被管理员移除：这条记录不该再解析出任何路径。
    if source.startswith("lib:") and source[4:] not in catalog.root_map():
        return None
    path = catalog.resolve_material(row).resolve()
    for base in readonly_roots() + [config.UPLOAD_DIR]:
        try:
            path.relative_to(base.resolve())
            return path
        except (ValueError, OSError):
            continue
    return None


def has_text_map(conn, ids):
    if not ids:
        return set()
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        "SELECT DISTINCT material_id FROM texts WHERE material_id IN (" + marks + ")", ids
    ).fetchall()
    return {r["material_id"] for r in rows}


def fav_map(conn, user, ids):
    if not ids or not user:
        return set()
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        "SELECT material_id FROM favorites WHERE user_id=? AND material_id IN (" + marks + ")",
        [user["id"]] + list(ids),
    ).fetchall()
    return {r["material_id"] for r in rows}


def material_json(row, have, favs, user=None) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "name": row["name"],
        "subject": row["subject"],
        "group_path": row["group_path"],
        "ext": row["ext"],
        "kind": row["kind"],
        "kind_label": extract.KIND_LABELS.get(row["kind"], row["kind"]),
        "size": row["size"],
        "size_label": human_size(row["size"]),
        "mtime": row["mtime"],
        "pages": row["pages"],
        "source": row["source"],
        "visibility": row["visibility"],
        "shared": row["visibility"] == "shared",
        "mine": bool(user and access.can_manage(user, row)),
        "text_state": row["text_state"],
        "vision_state": row["vision_state"],
        # 读不出来的原因（空文件 / 格式不对 / 结构损坏），资料页上会显示成「无法解析」。
        "text_note": (row["text_note"] or "") if "text_note" in keys else "",
        "vision_note": (row["vision_note"] or "") if "vision_note" in keys else "",
        "has_text": row["id"] in have,
        "fav": row["id"] in favs,
        "created_at": row["created_at"],
    }


def find_visible(conn, user, material_id):
    sql, params = visible(user, "m")
    row = conn.execute(
        "SELECT m.* FROM materials m WHERE m.id=? AND " + sql, [material_id] + params
    ).fetchone()
    if row is None and user:
        exists = conn.execute("SELECT name FROM materials WHERE id=?", (material_id,)).fetchone()
        if exists:
            audit.record(user["id"], user["username"], "forbidden",
                         "想打开《" + exists["name"] + "》(#" + str(material_id) + ")，但没有权限",
                         "warn", client_ip())
    return row


def _search(q: str, user, limit: int = 30, dedupe: bool = True) -> list:
    conn = db.connect()
    q = (q or "").strip()
    if not q:
        return []
    fetch = limit * 4
    hits = []
    if len(q) >= 3:
        expr = '"' + q.replace('"', '""') + '"'
        try:
            rows = conn.execute(
                "SELECT material_id, page, snippet(texts_fts, 0, '[[', ']]', ' … ', 20) AS snip"
                " FROM texts_fts WHERE texts_fts MATCH ? ORDER BY rank LIMIT ?",
                (expr, fetch),
            ).fetchall()
            hits = [dict(r) for r in rows]
        except Exception:
            hits = []
    if not hits:
        rows = conn.execute(
            "SELECT material_id, page, substr(content, 1, 260) AS snip FROM texts"
            " WHERE content LIKE ? LIMIT ?",
            ("%" + q + "%", fetch),
        ).fetchall()
        hits = [dict(r) for r in rows]
    if not hits:
        for term in query_terms(q):
            rows = conn.execute(
                "SELECT material_id, page, substr(content, 1, 260) AS snip FROM texts"
                " WHERE content LIKE ? LIMIT ?",
                ("%" + term + "%", fetch),
            ).fetchall()
            if rows:
                hits = [dict(r) for r in rows]
                break
    if not hits:
        grams = query_grams(q)
        if grams:
            clause = " OR ".join(["content LIKE ?"] * len(grams))
            rows = conn.execute(
                "SELECT material_id, page, substr(content, 1, 260) AS snip FROM texts"
                " WHERE " + clause + " LIMIT ?",
                ["%" + g + "%" for g in grams] + [fetch * 3],
            ).fetchall()
            hits = [dict(r) for r in rows]
    if not hits:
        return []
    sql, params = visible(user, "m")
    out = []
    seen = set()
    by_material = {}
    # 同一个文件在资料库里存了两三份（不同文件夹）时，搜索结果也合并成一条，免得看着像重复。
    by_name = {}
    for hit in hits:
        key = (hit["material_id"], hit["page"])
        if key in seen:
            continue
        row = conn.execute(
            "SELECT m.* FROM materials m WHERE m.id=? AND " + sql,
            [hit["material_id"]] + params,
        ).fetchone()
        if not row:
            continue
        seen.add(key)
        existing = by_material.get(row["id"]) if dedupe else None
        if existing is not None:
            existing["matches"] += 1
            continue
        entry = {
            "material_id": row["id"],
            "name": row["name"],
            "subject": row["subject"],
            "kind": row["kind"],
            "size": row["size"] or 0,
            "page": hit["page"],
            "snippet": hit["snip"],
            "matches": 1,
            "copies": 1,
        }
        if dedupe:
            twin = by_name.get((entry["name"], entry["size"]))
            if twin is not None:
                twin["copies"] += 1
                continue
            by_material[row["id"]] = entry
            by_name[(entry["name"], entry["size"])] = entry
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def _fingerprint_root(root: Path) -> dict:
    digest = hashlib.sha256()
    count = 0
    total = 0
    for dirpath, dirnames, filenames in os.walk(str(root)):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, str(root))
            count += 1
            total += st.st_size
            digest.update((rel + "|" + str(st.st_size) + "|" + str(st.st_mtime_ns)).encode("utf-8"))
    return {"files": count, "bytes": total, "sha256": digest.hexdigest()}


def _source_fingerprint() -> dict:
    info = _fingerprint_root(config.SOURCE_ROOT)
    current = info["sha256"]
    baseline = ""
    if config.BASELINE_PATH.exists():
        for line in config.BASELINE_PATH.read_text(encoding="utf-8").splitlines():
            if line.startswith("sha256="):
                baseline = line.split("=", 1)[1].strip()
    extra = []
    for node in config.source_roots():
        if not node["id"]:
            continue
        root = Path(node["path"])
        entry = {"id": node["id"], "name": node["name"], "path": node["path"]}
        if root.exists():
            entry.update(_fingerprint_root(root))
        else:
            entry["missing"] = True
        extra.append(entry)
    return {
        "files": info["files"],
        "bytes": info["bytes"],
        "sha256": current,
        "baseline_sha256": baseline,
        "unchanged": bool(baseline) and baseline == current,
        "roots": extra,
    }


def _placeholder_svg(kind: str, ext: str) -> str:
    label = {"pdf": "PDF", "word": "DOC", "ppt": "PPT", "excel": "XLS", "video": "VIDEO",
             "audio": "AUDIO", "archive": "ZIP", "text": "TXT"}.get(kind, (ext or "FILE").upper()[:5])
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
        '<rect width="320" height="200" fill="#f0f2f5"/>'
        '<text x="160" y="110" font-family="Segoe UI,Microsoft YaHei" font-size="34" '
        'fill="#8a9199" text-anchor="middle">' + label + "</text></svg>"
    )


# ---------------- 路由 ----------------

def extra_contexts(raw, limit: int = 4, max_chars: int = 1500) -> list:
    """前端从用户自己浏览器里挑出来的片段（文件夹模式 / 本地上传的资料）。

    这些文件只在他的机器上，服务器索引里没有，所以由前端把最相关的几段发上来一起当上下文。
    """
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()[:max_chars]
        if not text:
            continue
        out.append({
            "material_id": str(item.get("material_id") or "")[:200],
            "title": (str(item.get("title") or "").strip() or "本地资料")[:200],
            "subject": str(item.get("subject") or "")[:200],
            "text": text,
        })
        if len(out) >= limit:
            break
    return out


def _sse(event: dict) -> str:
    """把一条事件打包成 SSE（浏览器一段段读）。"""
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


def _stream_ask(question: str, contexts: list, sources: list, deep: bool, conf):
    """流式问答：第一条事件先给来源（编号马上能点），后面一个字一个字地给正文。"""
    def gen():
        # 生成器可能在另一个线程里被迭代，保险起见把这次请求该用的 AI 配置再设一遍。
        ai.set_user_conf(conf)
        yield _sse({"type": "sources", "sources": sources, "deep": bool(deep)})
        try:
            for kind, text in ai.ask_stream(question, contexts, deep=bool(deep)):
                yield _sse({"type": kind, "text": text})
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)})
            return
        yield _sse({"type": "done"})

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def register_routes(app: Flask):

    # 公网单文件版从别的地址（file:// 或 GitHub Pages）访问本机接口时要 CORS 放行。
    # 只用连接码（X-Study-Key）鉴权，不靠 Cookie，所以不回显凭证、也不带 Allow-Credentials。
    @app.before_request
    def _cors_preflight():
        if request.method == "OPTIONS" and request.headers.get("Origin"):
            return ("", 204)

    @app.before_request
    def _scope_user_ai():
        """普通账号把密钥存在自己账号里时，这次请求的 AI 调用就用他的那份。"""
        try:
            user = auth.current_user()
            ai.set_user_conf(auth.user_ai(user["id"]) if user else None)
        except Exception:
            ai.set_user_conf(None)

    @app.after_request
    def _cors_headers(resp):
        origin = request.headers.get("Origin")
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Study-Key"
            resp.headers["Access-Control-Max-Age"] = "600"
            resp.headers.add("Vary", "Origin")
        # 接口一律不缓存。浏览器如果拿上一份 JSON 来用，表现出来就是
        # “管理员回复了、用户那边却看不到”。缩略图自己设了 max-age，这里不覆盖它。
        if request.path.startswith("/api/") and not resp.headers.get("Cache-Control"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/")
    def index():
        return send_file(str(config.WEB_DIR / "index.html"))

    @app.get("/favicon.ico")
    def favicon():
        return ("", 204)

    @app.get("/sw.js")
    def service_worker():
        # 放在根路径，离线壳才能覆盖整个站点；界面改动靠“网络优先”保证随时生效
        resp = send_from_directory(str(config.WEB_DIR), "sw.js",
                                   mimetype="application/javascript")
        resp.headers["Service-Worker-Allowed"] = "/"
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    # ---- 账号 ----
    @app.get("/api/register/info")
    def api_register_info():
        """给登录页用：现在要不要邀请码（不会把邀请码本身吐出来）。"""
        conf = config.registration_settings()
        total = db.connect().execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        return jsonify({
            "ok": True,
            "first_account": total == 0,
            "open": conf["open"],
            "need_invite": (not conf["open"]) and total > 0,
            "site": config.site_settings(),
        })

    @app.post("/api/register")
    def api_register():
        body = request.get_json(silent=True) or {}
        allowed, why = auth.check_invite(body.get("invite") or "")
        if not allowed:
            audit.record(None, str(body.get("username") or "")[:40], "register_fail",
                         why, "warn", client_ip())
            return jsonify({"ok": False, "error": why, "need_invite": True}), 400
        user, err = auth.register(body.get("username", ""), body.get("password", ""))
        if err:
            return jsonify({"ok": False, "error": err}), 400
        session["uid"] = user["id"]
        session["sv"] = auth.session_version(user["id"])
        session.permanent = True
        audit.record(user["id"], user["username"], "register",
                     "注册成功" + ("（第一个账号，自动成为管理员）" if user["is_admin"] else ""),
                     "info", client_ip())
        return jsonify({"ok": True, "user": user})

    @app.post("/api/login")
    def api_login():
        body = request.get_json(silent=True) or {}
        username = (body.get("username") or "").strip()
        locked, why = auth.login_locked(username)
        if locked:
            audit.record(None, username, "login_locked", why, "warn", client_ip())
            return jsonify({"ok": False, "error": why, "locked": True}), 429
        user, err = auth.authenticate(username, body.get("password", ""))
        if not user:
            user_id = auth.user_id_by_name(username)
            audit.record(user_id, username, "login_fail", err or "登录失败", "warn", client_ip())
            auth.bump_login_fail(user_id)
            return jsonify({"ok": False, "error": err or "用户名或密码不正确"}), 400
        auth.mark_login(user["id"], client_ip())
        audit.record(user["id"], user["username"], "login", "登录成功", "info", client_ip())
        session["uid"] = user["id"]
        session["sv"] = auth.session_version(user["id"])
        session.permanent = bool(body.get("remember", True))
        return jsonify({"ok": True, "user": user})


    @app.post("/api/logout")
    def api_logout():
        user = auth.current_user()
        if user:
            audit.record(user["id"], user["username"], "logout", "退出登录", "info", client_ip())
        session.clear()
        return jsonify({"ok": True})

    @app.get("/api/me")
    def api_me():
        return jsonify({"ok": True, "user": auth.current_user()})

    # ---- 个人资料 / 外观（每个账号都能改自己的）----
    @app.get("/api/me/prefs")
    @auth.login_required
    def api_me_prefs():
        user = auth.current_user()
        return jsonify({"ok": True, "prefs": auth.get_prefs(user["id"]),
                        "site": config.site_settings(), "avatars": list(auth.AVATARS)})

    @app.post("/api/me/prefs")
    @auth.login_required
    def api_me_prefs_save():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        prefs, err = auth.save_prefs(user["id"], nickname=body.get("nickname"),
                                     avatar=body.get("avatar"), theme=body.get("theme"))
        if err:
            return jsonify({"ok": False, "error": err}), 400
        audit.record(user["id"], user["username"], "prefs", "更新了个人资料或外观",
                     "info", client_ip())
        return jsonify({"ok": True, "prefs": prefs})

    # 文件夹模式“选了却说没选中”这类问题只发生在用户浏览器里，服务端看不到原因：
    # 前端把原始报错送过来，落到 data/folder_diag.log，方便事后查。
    @app.post("/api/folder/diag")
    @auth.login_required
    def api_folder_diag():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        row = {
            "at": auth.now_iso(),
            "user": user["username"],
            "ip": client_ip(),
            "where": str(body.get("where") or "")[:40],
            "name": str(body.get("name") or "")[:80],
            "message": str(body.get("message") or "")[:400],
            "ms": body.get("ms"),
            "has_picker": bool(body.get("hasPicker")),
            "secure": bool(body.get("secure")),
            "in_frame": bool(body.get("inFrame")),
            "lost_focus": bool(body.get("lostFocus")),
            "href": str(body.get("href") or "")[:300],
            "ua": str(body.get("ua") or "")[:300],
        }
        try:
            with (config.DATA_DIR / "folder_diag.log").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return jsonify({"ok": True})

    @app.post("/api/me/password")
    @auth.login_required
    def api_me_password():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        if not auth.verify_password(str(body.get("old") or ""), auth.password_hash(user["id"])):
            audit.record(user["id"], user["username"], "password_fail",
                         "改密码时原密码不对", "warn", client_ip())
            return jsonify({"ok": False, "error": "原来的密码不对"}), 400
        err = auth.set_password(user["id"], str(body.get("new") or ""))
        if err:
            return jsonify({"ok": False, "error": err}), 400
        auth.bump_session_version(user["id"])
        session["sv"] = auth.session_version(user["id"])
        audit.record(user["id"], user["username"], "password", "修改了自己的密码",
                     "warn", client_ip())
        return jsonify({"ok": True, "note": "改好了。其它设备上的登录已经失效，需要重新登录。"})

    @app.post("/api/me/logout-all")
    @auth.login_required
    def api_me_logout_all():
        user = auth.current_user()
        auth.bump_session_version(user["id"])
        session["sv"] = auth.session_version(user["id"])
        audit.record(user["id"], user["username"], "logout", "登出了全部设备",
                     "info", client_ip())
        return jsonify({"ok": True})

    # ---- 自带密钥：存服务器（可选，默认存在浏览器里）----
    @app.get("/api/me/ai")
    @auth.login_required
    def api_me_ai_get():
        user = auth.current_user()
        conf = auth.user_ai(user["id"])
        return jsonify({"ok": True, "ai": {
            "base_url": conf.get("base_url", ""),
            "model_text": conf.get("model_text", ""),
            "model_vision": conf.get("model_vision", ""),
            "has_key": bool(conf.get("api_key"))}})

    @app.post("/api/me/ai")
    @auth.login_required
    def api_me_ai_save():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        conf = auth.save_user_ai(user["id"], body.get("base_url"), body.get("api_key"),
                                 body.get("model_text"), body.get("model_vision"))
        audit.record(user["id"], user["username"], "ai",
                     "保存了自己的 AI 接入（存在服务器上）", "info", client_ip())
        return jsonify({"ok": True, "ai": {"base_url": conf.get("base_url", ""),
                                           "has_key": bool(conf.get("api_key"))}})

    @app.post("/api/me/ai/test")
    @auth.login_required
    def api_me_ai_test():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        stored = auth.user_ai(user["id"])
        conf = dict(stored)
        for key in ("base_url", "model_text", "model_vision"):
            if body.get(key):
                conf[key] = str(body.get(key)).strip()
        if body.get("api_key"):
            conf["api_key"] = str(body.get("api_key")).strip()
        if not conf.get("api_key"):
            return jsonify({"ok": False, "error": "还没填密钥，先在下面填上再测"}), 400
        ai.set_user_conf(conf)
        try:
            result = ai.ping()
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        finally:
            ai.set_user_conf(stored)
        return jsonify({"ok": True, "result": result, "via": "服务器代发（用你自己的密钥）"})

    @app.post("/api/me/ai/clear")
    @auth.login_required
    def api_me_ai_clear():
        user = auth.current_user()
        auth.clear_user_ai(user["id"])
        audit.record(user["id"], user["username"], "ai", "删掉了存在服务器上的 AI 密钥",
                     "info", client_ip())
        return jsonify({"ok": True})

    # ---- 概览 ----
    @app.get("/api/overview")
    @auth.login_required
    def api_overview():
        user = auth.current_user()
        conn = db.connect()
        sql, params = visible(user, "m")
        subjects = conn.execute(
            "SELECT m.subject AS subject, COUNT(*) AS total, SUM(m.size) AS bytes FROM materials m"
            " WHERE " + sql + " GROUP BY m.subject ORDER BY m.subject ASC",
            params,
        ).fetchall()
        kinds = conn.execute(
            "SELECT m.kind AS kind, COUNT(*) AS total FROM materials m WHERE " + sql
            + " GROUP BY m.kind", params
        ).fetchall()
        totals = conn.execute(
            "SELECT COUNT(*) AS c, SUM(m.size) AS b FROM materials m WHERE " + sql, params
        ).fetchone()
        recent_rows = conn.execute(
            "SELECT m.* FROM materials m WHERE " + sql + " ORDER BY m.id DESC LIMIT 12", params
        ).fetchall()
        ids = [r["id"] for r in recent_rows]
        progress_rows = conn.execute(
            "SELECT m.* FROM progress p JOIN materials m ON m.id = p.material_id"
            " WHERE p.user_id=? AND " + sql + " ORDER BY p.updated_at DESC LIMIT 6",
            [user["id"]] + params,
        ).fetchall()
        pids = [r["id"] for r in progress_rows]
        is_admin = bool(user.get("is_admin"))
        empty_index = {"running": False, "paused": False, "phase": "idle", "current": None,
                       "text_pending": 0, "vision_pending": 0, "failed": 0, "indexed": 0,
                       "total": 0, "done": 0, "last_error": "", "last_finished": ""}
        return jsonify({
            "ok": True,
            "subjects": [{"name": r["subject"], "count": r["total"], "bytes": r["bytes"] or 0} for r in subjects],
            "kind_counts": {r["kind"]: r["total"] for r in kinds},
            "kind_order": KIND_ORDER,
            "recent": [material_json(r, has_text_map(conn, ids), fav_map(conn, user, ids), user) for r in recent_rows],
            "continue": [material_json(r, has_text_map(conn, pids), fav_map(conn, user, pids), user) for r in progress_rows],
            "totals": {"files": totals["c"], "bytes": totals["b"] or 0, "bytes_label": human_size(totals["b"])},
            # 非管理员看不到别人资料库的规模、路径和 AI 通道：一律给空值，防止泄露。
            "index": INDEXER.status() if is_admin else empty_index,
            "ai": ({"base": config.AI_BASE_URL, "vision_model": config.MODEL_VISION,
                    "text_model": config.MODEL_TEXT} if is_admin
                   else {"base": "", "vision_model": "", "text_model": ""}),
            "source": {"root": str(config.SOURCE_ROOT) if is_admin else "",
                       "roots": ([{"name": n["name"], "path": n["path"], "enabled": n["enabled"]}
                                  for n in config.source_roots()] if is_admin else [])},
            "is_admin": is_admin,
            "allow_shared_ai": config.allow_shared_ai(),
            "site": config.site_settings(),
        })

    @app.get("/api/materials")
    @auth.login_required
    def api_materials():
        user = auth.current_user()
        conn = db.connect()
        subject = request.args.get("subject") or ""
        kind = request.args.get("kind") or ""
        q = request.args.get("q") or ""
        sort = request.args.get("sort") or "name"
        fav_only = request.args.get("fav") == "1"
        try:
            limit = min(300, max(1, int(request.args.get("limit", 200))))
            offset = max(0, int(request.args.get("offset", 0)))
        except ValueError:
            limit, offset = 200, 0
        sql, params = visible(user, "m")
        where = [sql]
        if subject:
            where.append("m.subject = ?")
            params.append(subject)
        if kind:
            where.append("m.kind = ?")
            params.append(kind)
        if q:
            where.append("m.name LIKE ?")
            params.append("%" + q + "%")
        statement = "SELECT m.* FROM materials m"
        if fav_only:
            statement += " JOIN favorites f ON f.material_id = m.id AND f.user_id = ?"
            params.insert(0, user["id"])
        statement += " WHERE " + " AND ".join(where)
        order = {"name": "m.name ASC", "size": "m.size DESC", "new": "m.id DESC", "old": "m.id ASC"}.get(sort, "m.name ASC")
        statement += " ORDER BY " + order + " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = conn.execute(statement, params).fetchall()
        ids = [r["id"] for r in rows]
        return jsonify({
            "ok": True,
            "items": [material_json(r, has_text_map(conn, ids), fav_map(conn, user, ids), user) for r in rows],
        })

    @app.get("/api/material/<int:material_id>")
    @auth.login_required
    def api_material(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        note = conn.execute(
            "SELECT content FROM notes WHERE user_id=? AND material_id=?",
            (user["id"], material_id),
        ).fetchone()
        summary = conn.execute(
            "SELECT content, created_at FROM summaries WHERE material_id=? AND kind='summary'",
            (material_id,),
        ).fetchone()
        quiz = conn.execute(
            "SELECT content, created_at FROM summaries WHERE material_id=? AND kind='quiz'",
            (material_id,),
        ).fetchone()
        attempts = conn.execute(
            "SELECT score, total, created_at FROM quiz_attempts WHERE user_id=? AND material_id=?"
            " ORDER BY id DESC LIMIT 5",
            (user["id"], material_id),
        ).fetchall()
        progress = conn.execute(
            "SELECT position FROM progress WHERE user_id=? AND material_id=?",
            (user["id"], material_id),
        ).fetchone()
        texts = conn.execute(
            "SELECT page, origin, substr(content,1,4000) AS content FROM texts WHERE material_id=?"
            " ORDER BY (origin='extract') DESC, page ASC LIMIT 40",
            (material_id,),
        ).fetchall()
        quiz_data = None
        if quiz:
            try:
                quiz_data = json.loads(quiz["content"])
            except Exception:
                quiz_data = None
        return jsonify({
            "ok": True,
            "item": material_json(row, has_text_map(conn, [material_id]), fav_map(conn, user, [material_id]), user),
            "note": note["content"] if note else "",
            "summary": summary["content"] if summary else "",
            "quiz": quiz_data,
            "attempts": [dict(r) for r in attempts],
            "position": progress["position"] if progress else 0,
            "texts": [{"page": t["page"], "origin": t["origin"], "content": t["content"]} for t in texts],
        })

    @app.post("/api/material/<int:material_id>/visibility")
    @auth.login_required
    def api_visibility(material_id):
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        shared = bool(body.get("shared"))
        ok, err = access.set_visibility(user, material_id, shared)
        if not ok:
            return jsonify({"ok": False, "error": err}), 403
        return jsonify({"ok": True, "shared": shared})

    @app.get("/api/file/<int:material_id>")
    @auth.login_required
    def api_file(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        path = safe_resolve(row)
        if not path or not path.exists():
            return jsonify({"ok": False, "error": "文件不在磁盘上"}), 404
        return send_file(str(path), as_attachment=(request.args.get("download") == "1"),
                         download_name=row["name"], conditional=True)

    @app.get("/api/material/<int:material_id>/page")
    @auth.login_required
    def api_material_page(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row or row["kind"] != "web":
            return jsonify({"ok": False, "error": "这不是网页类型的资料"}), 404
        path = safe_resolve(row)
        if not path or not path.exists():
            return jsonify({"ok": False, "error": "文件不在磁盘上"}), 404
        try:
            text = extract.decode_bytes(path.read_bytes())
        except Exception:
            return jsonify({"ok": False, "error": "这个网页文件读不出文本内容"}), 400
        if not re.search(r"<base\b", text, re.I):
            base = '<base href="/api/material/' + str(material_id) + '/page/">'
            if re.search(r"<head\b[^>]*>", text, re.I):
                text = re.sub(r"(<head\b[^>]*>)", lambda m: m.group(1) + base, text, count=1, flags=re.I)
            else:
                text = base + text
        resp = app.response_class(text, mimetype="text/html")
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/material/<int:material_id>/page/<path:rel>")
    @auth.login_required
    def api_material_page_asset(material_id, rel):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row or row["kind"] != "web":
            return jsonify({"ok": False, "error": "这不是网页类型的资料"}), 404
        base_dir = safe_resolve(row).parent.resolve()
        target = (base_dir / rel).resolve()
        try:
            target.relative_to(base_dir)
        except ValueError:
            return jsonify({"ok": False, "error": "路径不合法"}), 400
        if not target.is_file():
            return jsonify({"ok": False, "error": "网页引用的文件不存在"}), 404
        resp = send_file(str(target), conditional=True)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.get("/api/thumb/<int:material_id>")
    @auth.login_required
    def api_thumb(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return ("", 404)
        cache = thumb_file(material_id)
        path = safe_resolve(row)
        if path and path.exists():
            try:
                fresh = cache.exists() and cache.stat().st_mtime >= path.stat().st_mtime
            except OSError:
                fresh = False
            if not fresh:
                try:
                    if row["kind"] == "image":
                        data = extract.image_to_jpeg_bytes(path, max_side=420, quality=72)
                    elif row["kind"] == "pdf":
                        data = extract.render_pdf_page(path, 0, max_side=420, quality=72)
                    else:
                        data = None
                    if data:
                        cache.write_bytes(data)
                except Exception:
                    pass
        if cache.exists():
            return send_file(str(cache), mimetype="image/jpeg", max_age=300)
        return app.response_class(_placeholder_svg(row["kind"], row["ext"]), mimetype="image/svg+xml")

    @app.post("/api/material/<int:material_id>/index")
    @auth.login_required
    def api_index_one(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        body = request.get_json(silent=True) or {}
        mode = body.get("mode") or "auto"
        if not ai_allowed(user) and (mode == "vision" or row["kind"] == "image"):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        if mode == "auto":
            with db.tx() as tx:
                if row["kind"] == "image":
                    tx.execute("UPDATE materials SET vision_state='pending', priority=1 WHERE id=?", (material_id,))
                else:
                    tx.execute("UPDATE materials SET text_state='pending', vision_state='pending', priority=1 WHERE id=?", (material_id,))
            INDEXER.ensure_started()
            return jsonify({"ok": True, "queued": True})
        threading.Thread(target=INDEXER.index_one, args=(material_id, mode), daemon=True).start()
        return jsonify({"ok": True, "started": True, "mode": mode})

    @app.post("/api/material/<int:material_id>/summary")
    @auth.login_required
    def api_summary(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        text = export_mod.content_for(conn, material_id)
        if not text.strip():
            return jsonify({"ok": False, "error": "这份资料还没有可用的文字内容，请先点“AI 识别”或“重新提取文字”。"}), 400
        try:
            content = ai.summarize(row["name"], text)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        with db.tx() as tx:
            tx.execute(
                "INSERT INTO summaries(material_id, kind, content, model, created_at) VALUES(?,?,?,?,?)"
                " ON CONFLICT(material_id, kind) DO UPDATE SET content=excluded.content,"
                " model=excluded.model, created_at=excluded.created_at",
                (material_id, "summary", content, config.MODEL_TEXT, now_iso()),
            )
        return jsonify({"ok": True, "summary": content})

    @app.post("/api/material/<int:material_id>/quiz")
    @auth.login_required
    def api_quiz(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        text = export_mod.content_for(conn, material_id)
        if not text.strip():
            return jsonify({"ok": False, "error": "这份资料还没有可用的文字内容。"}), 400
        try:
            questions = ai.make_quiz(row["name"], text)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        with db.tx() as tx:
            tx.execute(
                "INSERT INTO summaries(material_id, kind, content, model, created_at) VALUES(?,?,?,?,?)"
                " ON CONFLICT(material_id, kind) DO UPDATE SET content=excluded.content,"
                " model=excluded.model, created_at=excluded.created_at",
                (material_id, "quiz", json.dumps(questions, ensure_ascii=False), config.MODEL_TEXT, now_iso()),
            )
        return jsonify({"ok": True, "quiz": questions})

    @app.post("/api/material/<int:material_id>/quiz/submit")
    @auth.login_required
    def api_quiz_submit(material_id):
        user = auth.current_user()
        conn = db.connect()
        if not find_visible(conn, user, material_id):
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        body = request.get_json(silent=True) or {}
        answers = body.get("answers") or []
        quiz = conn.execute(
            "SELECT content FROM summaries WHERE material_id=? AND kind='quiz'", (material_id,)
        ).fetchone()
        if not quiz:
            return jsonify({"ok": False, "error": "还没有练习题"}), 400
        try:
            questions = json.loads(quiz["content"])
        except Exception:
            return jsonify({"ok": False, "error": "练习题数据损坏"}), 500

        def norm(value):
            text = str(value or "").strip().lower()
            for ch in " \t\n。，、；：（）()【】[]":
                text = text.replace(ch, "")
            return text

        detail = []
        score = 0
        for index, item in enumerate(questions):
            given = answers[index] if index < len(answers) else ""
            ok = norm(given) != "" and norm(given) == norm(item.get("answer"))
            if ok:
                score += 1
            detail.append({"given": given, "answer": item.get("answer"), "ok": ok})
        with db.tx() as tx:
            tx.execute(
                "INSERT INTO quiz_attempts(user_id, material_id, score, total, detail, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (user["id"], material_id, score, len(questions),
                 json.dumps(detail, ensure_ascii=False), now_iso()),
            )
        return jsonify({"ok": True, "score": score, "total": len(questions), "detail": detail})

    @app.get("/api/search")
    @auth.login_required
    def api_search():
        q = request.args.get("q") or ""
        return jsonify({"ok": True, "query": q, "hits": _search(q, auth.current_user(), limit=60)})

    @app.post("/api/ask")
    @auth.login_required
    def api_ask():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        question = (body.get("question") or "").strip()
        if not question:
            return jsonify({"ok": False, "error": "请输入问题"}), 400
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        deep = bool(body.get("deep"))
        hits = _search(question, user, limit=24, dedupe=False)
        grouped = {}
        for hit in hits:
            grouped.setdefault(hit["material_id"], []).append(hit)
        contexts = []
        for material_id, items in grouped.items():
            joined = "\n".join(str(i["snippet"]).replace("[[", "").replace("]]", "") for i in items)
            contexts.append({
                "material_id": material_id,
                "title": items[0]["name"],
                "subject": items[0]["subject"],
                "text": joined,
            })
            if len(contexts) >= 6:
                break
        # 用户自己浏览器里的资料（文件夹模式 / 本地上传）也一起给模型，来源里能直接点开本地文件。
        seen_titles = {str(c["title"]) for c in contexts}
        for item in extra_contexts(body.get("extra")):
            if item["title"] in seen_titles:
                continue
            seen_titles.add(item["title"])
            contexts.append(item)
            if len(contexts) >= 10:
                break
        if not contexts:
            return jsonify({
                "ok": True,
                "answer": "在你的可见资料里没有检索到相关内容。可以到“索引进度”确认资料是否已经处理完，或者换一种说法再问。",
                "sources": [],
            })
        audit.record(user["id"], user["username"], "ask",
                     ("深度思考：" if deep else "") + question[:120], "info", client_ip())
        sources = [{"index": i + 1, "material_id": c["material_id"], "name": c["title"],
                    "subject": c["subject"]} for i, c in enumerate(contexts)]
        # 浏览器要流式（边收边显示）：走 SSE；否则还是老的一次性返回。
        if body.get("stream"):
            return _stream_ask(question, contexts, sources, deep, ai.user_conf())
        try:
            if deep:
                result = ai.ask_deep(question, contexts)
                return jsonify({"ok": True, "answer": result["answer"],
                                "reasoning": result["reasoning"], "model": result["model"],
                                "deep": True, "sources": sources})
            answer = ai.ask(question, contexts)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        return jsonify({"ok": True, "answer": answer, "reasoning": "", "deep": False,
                        "sources": sources})

    @app.post("/api/notes/<int:material_id>")
    @auth.login_required
    def api_note(material_id):
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        conn = db.connect()
        if not find_visible(conn, user, material_id):
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        with db.tx() as tx:
            tx.execute(
                "INSERT INTO notes(user_id, material_id, content, updated_at) VALUES(?,?,?,?)"
                " ON CONFLICT(user_id, material_id) DO UPDATE SET content=excluded.content,"
                " updated_at=excluded.updated_at",
                (user["id"], material_id, str(body.get("content") or ""), now_iso()),
            )
        return jsonify({"ok": True})

    @app.post("/api/favorite/<int:material_id>")
    @auth.login_required
    def api_favorite(material_id):
        user = auth.current_user()
        conn = db.connect()
        if not find_visible(conn, user, material_id):
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        exists = conn.execute("SELECT 1 FROM favorites WHERE user_id=? AND material_id=?",
                              (user["id"], material_id)).fetchone()
        with db.tx() as tx:
            if exists:
                tx.execute("DELETE FROM favorites WHERE user_id=? AND material_id=?", (user["id"], material_id))
                state = False
            else:
                tx.execute("INSERT INTO favorites(user_id, material_id, created_at) VALUES(?,?,?)",
                           (user["id"], material_id, now_iso()))
                state = True
        return jsonify({"ok": True, "fav": state})

    @app.post("/api/progress/<int:material_id>")
    @auth.login_required
    def api_progress(material_id):
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        conn = db.connect()
        if not find_visible(conn, user, material_id):
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        try:
            position = float(body.get("position") or 0)
        except (TypeError, ValueError):
            position = 0.0
        with db.tx() as tx:
            tx.execute(
                "INSERT INTO progress(user_id, material_id, position, updated_at) VALUES(?,?,?,?)"
                " ON CONFLICT(user_id, material_id) DO UPDATE SET position=excluded.position,"
                " updated_at=excluded.updated_at",
                (user["id"], material_id, position, now_iso()),
            )
        return jsonify({"ok": True})

    @app.get("/api/me/dashboard")
    @auth.login_required
    def api_me_dashboard():
        user = auth.current_user()
        conn = db.connect()
        sql, params = visible(user, "m")
        fav_rows = conn.execute(
            "SELECT m.* FROM favorites f JOIN materials m ON m.id = f.material_id"
            " WHERE f.user_id=? AND " + sql + " ORDER BY f.created_at DESC LIMIT 100",
            [user["id"]] + params,
        ).fetchall()
        note_rows = conn.execute(
            "SELECT n.content AS note_content, n.updated_at AS note_at, m.* FROM notes n"
            " JOIN materials m ON m.id = n.material_id WHERE n.user_id=? AND " + sql
            + " ORDER BY n.updated_at DESC LIMIT 100",
            [user["id"]] + params,
        ).fetchall()
        attempt_rows = conn.execute(
            "SELECT a.score, a.total, a.created_at, m.id AS material_id, m.name AS name,"
            " m.subject AS subject FROM quiz_attempts a JOIN materials m ON m.id = a.material_id"
            " WHERE a.user_id=? AND " + sql + " ORDER BY a.id DESC LIMIT 50",
            [user["id"]] + params,
        ).fetchall()
        ids = [r["id"] for r in fav_rows] + [r["id"] for r in note_rows]
        return jsonify({
            "ok": True,
            "favorites": [material_json(r, has_text_map(conn, ids), {r["id"] for r in fav_rows}, user) for r in fav_rows],
            "notes": [{"material_id": r["id"], "name": r["name"], "subject": r["subject"],
                       "kind": r["kind"], "content": r["note_content"], "updated_at": r["note_at"]}
                      for r in note_rows],
            "attempts": [dict(r) for r in attempt_rows],
        })

    # ---- 疑问解答：谁都能问，AI 或管理员解答，所有人可翻阅 ----
    @app.get("/api/qa")
    @auth.login_required
    def api_qa_list():
        user = auth.current_user()
        kw = str(request.args.get("q") or "").strip()
        conn = db.connect()
        sql = "SELECT * FROM qa"
        params = []
        if kw:
            sql += " WHERE question LIKE ? OR answer LIKE ?"
            like = "%" + kw + "%"
            params += [like, like]
        sql += " ORDER BY id DESC LIMIT 200"
        items = []
        for row in conn.execute(sql, params).fetchall():
            item = dict(row)
            item["mine"] = (item["user_id"] == user["id"])
            items.append(item)
        total = conn.execute("SELECT COUNT(*) AS c FROM qa").fetchone()["c"]
        open_count = conn.execute("SELECT COUNT(*) AS c FROM qa WHERE answer=''").fetchone()["c"]
        return jsonify({"ok": True, "items": items, "total": total, "open": open_count,
                        "is_admin": bool(user["is_admin"])})

    @app.post("/api/qa")
    @auth.login_required
    def api_qa_create():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        question = str(body.get("question") or "").strip()
        if not question:
            return jsonify({"ok": False, "error": "先写下你的问题"}), 400
        if len(question) > 1000:
            return jsonify({"ok": False, "error": "问题最多 1000 字"}), 400
        with db.tx() as tx:
            cur = tx.execute("INSERT INTO qa(user_id, username, question, asked_at) VALUES(?,?,?,?)",
                             (user["id"], user["username"], question, now_iso()))
            qid = cur.lastrowid
        audit.record(user["id"], user["username"], "qa", "提问：" + question[:120], "info", client_ip())
        item = dict(db.connect().execute("SELECT * FROM qa WHERE id=?", (qid,)).fetchone())
        item["mine"] = True
        return jsonify({"ok": True, "item": item})

    @app.post("/api/qa/<int:qid>/ai")
    @auth.login_required
    def api_qa_ai(qid):
        user = auth.current_user()
        row = db.connect().execute("SELECT * FROM qa WHERE id=?", (qid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "这个问题不存在"}), 404
        if row["user_id"] != user["id"] and not user["is_admin"]:
            return jsonify({"ok": False, "error": "只有提问的人或管理员能让 AI 解答"}), 403
        try:
            answer = ai.answer_question(row["question"])
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        with db.tx() as tx:
            tx.execute("UPDATE qa SET answer=?, answer_source='ai', answered_by='AI', answered_at=?"
                       " WHERE id=?", (answer, now_iso(), qid))
        audit.record(user["id"], user["username"], "ask", "让 AI 解答疑问 #" + str(qid), "info", client_ip())
        item = dict(db.connect().execute("SELECT * FROM qa WHERE id=?", (qid,)).fetchone())
        item["mine"] = (item["user_id"] == user["id"])
        return jsonify({"ok": True, "item": item})

    @app.post("/api/qa/<int:qid>/answer")
    @auth.admin_required
    def api_qa_answer(qid):
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        answer = str(body.get("answer") or "").strip()
        if not db.connect().execute("SELECT 1 FROM qa WHERE id=?", (qid,)).fetchone():
            return jsonify({"ok": False, "error": "这个问题不存在"}), 404
        with db.tx() as tx:
            tx.execute("UPDATE qa SET answer=?, answer_source='admin', answered_by=?, answered_at=?"
                       " WHERE id=?", (answer, me["username"], now_iso(), qid))
        audit.record(me["id"], me["username"], "admin", "解答疑问 #" + str(qid), "info", client_ip())
        item = dict(db.connect().execute("SELECT * FROM qa WHERE id=?", (qid,)).fetchone())
        item["mine"] = (item["user_id"] == me["id"])
        return jsonify({"ok": True, "item": item})

    @app.post("/api/qa/<int:qid>/delete")
    @auth.login_required
    def api_qa_delete(qid):
        user = auth.current_user()
        row = db.connect().execute("SELECT * FROM qa WHERE id=?", (qid,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "这个问题不存在"}), 404
        if row["user_id"] != user["id"] and not user["is_admin"]:
            return jsonify({"ok": False, "error": "只能删掉自己的提问"}), 403
        with db.tx() as tx:
            tx.execute("DELETE FROM qa WHERE id=?", (qid,))
        audit.record(user["id"], user["username"], "admin" if user["is_admin"] else "qa",
                     "删除疑问 #" + str(qid), "warn", client_ip())
        return jsonify({"ok": True})

    # ---- 用户反馈：用户端提交，管理端收到并处理 ----
    @app.post("/api/feedback")
    @auth.login_required
    def api_feedback_create():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        content = str(body.get("content") or "").strip()
        if not content:
            return jsonify({"ok": False, "error": "反馈内容不能为空"}), 400
        if len(content) > 2000:
            return jsonify({"ok": False, "error": "反馈内容最多 2000 字"}), 400
        kind = str(body.get("kind") or "suggestion").strip()
        if kind not in FEEDBACK_KIND_IDS:
            kind = "other"
        contact = str(body.get("contact") or "").strip()[:120]
        page = str(body.get("page") or "").strip()[:200]
        with db.tx() as tx:
            cur = tx.execute(
                "INSERT INTO feedback(user_id, username, kind, content, contact, page, status, created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (user["id"], user["username"], kind, content, contact, page, "new", now_iso()),
            )
            new_id = cur.lastrowid
        audit.record(user["id"], user["username"], "feedback",
                     kind + "：" + content[:120], "info", client_ip())
        return jsonify({"ok": True, "id": new_id})

    @app.get("/api/feedback")
    @auth.login_required
    def api_feedback_list():
        """管理员拿到全部；普通用户只拿到自己提交的（含管理员的回复）。"""
        user = auth.current_user()
        conn = db.connect()
        if user["is_admin"]:
            status = str(request.args.get("status") or "").strip()
            sql = "SELECT * FROM feedback"
            params = []
            if status in ("new", "read", "done"):
                sql += " WHERE status=?"
                params.append(status)
            sql += " ORDER BY id DESC LIMIT 300"
            rows = conn.execute(sql, params).fetchall()
            new_count = conn.execute(
                "SELECT COUNT(*) AS c FROM feedback WHERE status='new'").fetchone()["c"]
        else:
            rows = conn.execute(
                "SELECT * FROM feedback WHERE user_id=? ORDER BY id DESC LIMIT 100",
                (user["id"],)).fetchall()
            new_count = 0
        return jsonify({"ok": True, "items": [dict(r) for r in rows], "new_count": new_count,
                        "kinds": FEEDBACK_KINDS})

    @app.post("/api/feedback/<int:fb_id>/status")
    @auth.admin_required
    def api_feedback_status(fb_id):
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        status = str(body.get("status") or "").strip()
        if status not in ("new", "read", "done"):
            return jsonify({"ok": False, "error": "状态不合法"}), 400
        reply = str(body.get("reply") or "").strip()[:2000]
        if not db.connect().execute("SELECT 1 FROM feedback WHERE id=?", (fb_id,)).fetchone():
            return jsonify({"ok": False, "error": "这条反馈不存在"}), 404
        with db.tx() as tx:
            tx.execute("UPDATE feedback SET status=?, reply=?, handled_at=? WHERE id=?",
                       (status, reply, now_iso() if status == "done" else "", fb_id))
        audit.record(me["id"], me["username"], "admin",
                     "处理反馈 #" + str(fb_id) + " -> " + status, "info", client_ip())
        return jsonify({"ok": True})

    @app.post("/api/feedback/<int:fb_id>/delete")
    @auth.admin_required
    def api_feedback_delete(fb_id):
        me = auth.current_user()
        with db.tx() as tx:
            tx.execute("DELETE FROM feedback WHERE id=?", (fb_id,))
        audit.record(me["id"], me["username"], "admin", "删除反馈 #" + str(fb_id), "warn", client_ip())
        return jsonify({"ok": True})

    @app.post("/api/upload")
    @auth.admin_required
    def api_upload():
        user = auth.current_user()
        subject = request.form.get("subject") or config.UNCLASSIFIED
        files = request.files.getlist("files")
        if not files:
            return jsonify({"ok": False, "error": "没有收到文件"}), 400
        saved = []
        risky = []
        # 服务器端配额（MB，0 = 不限）。默认就是 0，所以这条平时不影响任何行为。
        quota = auth.quota_mb(user["id"])
        room = quota * 1024 * 1024 - auth.used_bytes(user["id"]) if quota else 0
        full = ""
        for storage in files:
            name = storage.filename or ""
            if not name:
                continue
            if quota:
                try:
                    storage.stream.seek(0, 2)
                    fsize = storage.stream.tell()
                    storage.stream.seek(0)
                except Exception:
                    fsize = 0
                if room - fsize < 0:
                    full = "服务器端存储配额（" + str(quota) + " MB）不够了，剩下的文件没有保存。"
                    break
                room -= fsize
            target = catalog.unique_upload_path(subject, name)
            storage.save(str(target))
            rel = target.relative_to(config.UPLOAD_DIR).as_posix()
            row = catalog.register_one("upload", rel, user["id"])
            if extract.ext_of(target.name) in audit.RISKY_EXTS:
                risky.append(target.name)
            saved.append({"name": target.name, "id": row["id"] if row else None})
        if full and not saved:
            return jsonify({"ok": False, "error": full}), 413
        audit.record(user["id"], user["username"], "upload",
                     "往「" + subject + "」上传 " + str(len(saved)) + " 个文件"
                     + ("；其中含可执行/脚本文件：" + "、".join(risky) if risky else ""),
                     "alert" if risky else "info", client_ip())
        INDEXER.ensure_started()
        return jsonify({"ok": True, "saved": saved, "subject": subject,
                        "note": full or "上传的资料默认只有你自己能看到。"})

    @app.post("/api/export")
    @auth.login_required
    def api_export():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        title = str(body.get("title") or "学习资料包").strip() or "学习资料包"
        mode = body.get("mode") or "single"
        try:
            ids = [int(i) for i in (body.get("ids") or [])]
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "资料编号不正确"}), 400
        if not ids:
            return jsonify({"ok": False, "error": "请先选择资料"}), 400
        conn = db.connect()
        allowed = [i for i in ids if find_visible(conn, user, i)]
        if not allowed:
            return jsonify({"ok": False, "error": "选中的资料你都没有权限导出"}), 403
        audit.record(user["id"], user["username"], "export",
                     "导出 " + str(len(allowed)) + " 份资料（" + str(mode) + "）", "info", client_ip())
        if mode == "bundle":
            result = export_mod.build_bundle(user, allowed, title)
            if result.get("error"):
                return jsonify({"ok": False, "error": result["error"]}), 400
            with db.tx() as tx:
                cur = tx.execute(
                    "INSERT INTO exports(user_id, title, file_name, size, warning, created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (user["id"], title, result["file_name"], result["size"],
                     "；".join(result["warnings"]), now_iso()),
                )
                export_id = cur.lastrowid
            return jsonify({
                "ok": True, "id": export_id, "mode": "bundle", "file_name": result["file_name"],
                "size": result["size"], "size_label": human_size(result["size"]),
                "count": result["count"], "warnings": result["warnings"],
            })
        result = export_mod.build_export(user, allowed, title)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = "study-" + stamp + ".html"
        (config.EXPORT_DIR / filename).write_bytes(result["html"])
        with db.tx() as tx:
            cur = tx.execute(
                "INSERT INTO exports(user_id, title, file_name, size, warning, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (user["id"], title, filename, result["size"], "；".join(result["warnings"]), now_iso()),
            )
            export_id = cur.lastrowid
        return jsonify({
            "ok": True, "id": export_id, "mode": "single", "file_name": filename,
            "size": result["size"], "size_label": human_size(result["size"]),
            "count": result["count"], "warnings": result["warnings"],
        })

    @app.get("/api/export/<int:export_id>/download")
    @auth.login_required
    def api_export_download(export_id):
        user = auth.current_user()
        conn = db.connect()
        row = conn.execute("SELECT * FROM exports WHERE id=?", (export_id,)).fetchone()
        if not row or (row["user_id"] != user["id"] and not user.get("is_admin")):
            return jsonify({"ok": False, "error": "找不到导出记录"}), 404
        path = (config.EXPORT_DIR / row["file_name"]).resolve()
        try:
            path.relative_to(config.EXPORT_DIR.resolve())
        except ValueError:
            return jsonify({"ok": False, "error": "路径不合法"}), 400
        if not path.exists():
            return jsonify({"ok": False, "error": "文件已被删除"}), 404
        mime = "application/zip" if path.suffix.lower() == ".zip" else "text/html"
        return send_file(str(path), as_attachment=True, download_name=row["file_name"], mimetype=mime)

    @app.get("/api/exports")
    @auth.login_required
    def api_exports():
        user = auth.current_user()
        rows = db.connect().execute(
            "SELECT * FROM exports WHERE user_id=? ORDER BY id DESC LIMIT 50", (user["id"],)
        ).fetchall()
        return jsonify({"ok": True, "items": [dict(r) for r in rows]})

    @app.post("/api/share/site")
    @auth.login_required
    def api_share_site():
        """导出「分享版网站」：整站界面 + 模型动画 + 明确的几份资料，不含任何个人数据。"""
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        title = str(body.get("title") or "离线学习站").strip() or "离线学习站"
        include_models = body.get("include_models", True) is not False
        try:
            ids = [int(i) for i in (body.get("ids") or [])]
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "资料编号不正确"}), 400
        conn = db.connect()
        allowed = [i for i in ids if find_visible(conn, user, i)]
        if ids and not allowed:
            return jsonify({"ok": False, "error": "选中的资料你都没有权限分享"}), 403
        audit.record(user["id"], user["username"], "export",
                     "生成分享版网站（含 " + str(len(allowed)) + " 份资料）", "warn", client_ip())
        try:
            result = export_mod.build_share_site(allowed, title, include_models=include_models)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = "share-" + stamp + ".html"
        (config.EXPORT_DIR / filename).write_bytes(result["html"])
        with db.tx() as tx:
            cur = tx.execute(
                "INSERT INTO exports(user_id, title, file_name, size, warning, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (user["id"], title, filename, result["size"],
                 "；".join(result["warnings"]), now_iso()),
            )
            export_id = cur.lastrowid
        return jsonify({
            "ok": True, "id": export_id, "mode": "site", "file_name": filename,
            "size": result["size"], "size_label": human_size(result["size"]),
            "count": result["count"], "warnings": result["warnings"],
        })

    # ---- AI 总结打印 / 下载 ----
    @app.post("/api/notes-export")
    @auth.login_required
    def api_notes_export():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        title = str(body.get("title") or "AI 学习总结").strip() or "AI 学习总结"
        include_quiz = body.get("include_quiz", True) is not False
        include_text = bool(body.get("include_text"))
        try:
            ids = [int(i) for i in (body.get("ids") or [])]
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "资料编号不正确"}), 400
        if not ids:
            return jsonify({"ok": False, "error": "请先选择资料"}), 400
        conn = db.connect()
        allowed = [i for i in ids if find_visible(conn, user, i)]
        if not allowed:
            return jsonify({"ok": False, "error": "选中的资料你都没有权限导出"}), 403
        result = export_mod.build_notes_doc(user, allowed, title, include_quiz, include_text)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = "notes-" + stamp + ".html"
        (config.EXPORT_DIR / filename).write_bytes(result["html"])
        with db.tx() as tx:
            cur = tx.execute(
                "INSERT INTO exports(user_id, title, file_name, size, warning, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (user["id"], title, filename, len(result["html"]),
                 "；".join(result["warnings"]), now_iso()),
            )
            export_id = cur.lastrowid
        return jsonify({
            "ok": True, "id": export_id, "file_name": filename,
            "size": len(result["html"]), "size_label": human_size(len(result["html"])),
            "count": result["count"], "warnings": result["warnings"],
        })

    @app.post("/api/material/<int:material_id>/notes-export")
    @auth.login_required
    def api_one_notes_export(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        title = "AI 学习总结 - " + row["name"]
        result = export_mod.build_notes_doc(user, [material_id], title, True, False)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = "notes-" + stamp + ".html"
        (config.EXPORT_DIR / filename).write_bytes(result["html"])
        with db.tx() as tx:
            cur = tx.execute(
                "INSERT INTO exports(user_id, title, file_name, size, warning, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (user["id"], title, filename, len(result["html"]), "", now_iso()),
            )
            export_id = cur.lastrowid
        return jsonify({"ok": True, "id": export_id, "file_name": filename,
                        "size_label": human_size(len(result["html"]))})

    @app.get("/api/material/<int:material_id>/summary.md")
    @auth.login_required
    def api_summary_markdown(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = find_visible(conn, user, material_id)
        if not row:
            return jsonify({"ok": False, "error": "资料不存在，或者你没有权限查看"}), 404
        summary = conn.execute(
            "SELECT content FROM summaries WHERE material_id=? AND kind='summary'", (material_id,)
        ).fetchone()
        if not summary or not (summary["content"] or "").strip():
            return jsonify({"ok": False, "error": "这份资料还没有 AI 笔记"}), 400
        text = "# " + row["name"] + "\n\n" + summary["content"].strip() + "\n"
        return app.response_class(
            text, mimetype="text/markdown; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=summary.md"})

    # ---- 公网静态版连接本机：只抓取，不落盘 ----
    # 单文件版在浏览器里受跨域限制，抓不到别的网站正文；这里把抓取能力借给它，
    # 抓到的东西直接回给访客的浏览器，由他自己保存，不占站长硬盘。
    @app.get("/api/bridge/ping")
    def api_bridge_ping():
        conf = config.bridge_settings()
        if not bridge_token_ok():
            return jsonify({"ok": False, "enabled": conf["enabled"], "error": BRIDGE_LOCKED}), 403
        return jsonify({"ok": True, "app": "study-web", "port": config.PORT})

    @app.get("/api/bridge/search")
    def api_bridge_search():
        if not bridge_token_ok():
            return jsonify({"ok": False, "error": BRIDGE_LOCKED}), 403
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"ok": False, "error": "请填写关键词"}), 400
        try:
            limit = min(10, max(1, int(request.args.get("limit") or 8)))
        except (TypeError, ValueError):
            limit = 8
        try:
            hits = collect.search_web(q, limit=limit)
        except Exception as exc:
            return jsonify({"ok": False, "error": "搜索失败：" + str(exc)}), 502
        return jsonify({"ok": True, "hits": hits})

    @app.get("/api/bridge/page")
    def api_bridge_page():
        if not bridge_token_ok():
            return jsonify({"ok": False, "error": BRIDGE_LOCKED}), 403
        url = (request.args.get("url") or "").strip()
        if not url:
            return jsonify({"ok": False, "error": "请填写网址"}), 400
        try:
            title, body, final_url = collect.fetch_page(url)
        except Exception as exc:
            return jsonify({"ok": False, "error": "抓取失败：" + str(exc)}), 502
        body = body[:200000]
        return jsonify({"ok": True, "title": title, "url": final_url,
                        "chars": len(body), "text": body})

    # ---- 网络收集 ----
    @app.get("/api/collect/search")
    @auth.admin_required
    def api_collect_search():
        if not ai_allowed(auth.current_user()):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"ok": False, "error": "请填写关键词"}), 400
        try:
            hits = collect.search_web(q, limit=8)
        except Exception as exc:
            return jsonify({"ok": False, "error": "搜索失败：" + str(exc)}), 502
        return jsonify({"ok": True, "hits": hits})

    @app.get("/api/collect/preview")
    @auth.admin_required
    def api_collect_preview():
        if not ai_allowed(auth.current_user()):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        url = (request.args.get("url") or "").strip()
        if not url:
            return jsonify({"ok": False, "error": "请填写网址"}), 400
        try:
            title, body, final_url = collect.fetch_page(url)
        except Exception as exc:
            return jsonify({"ok": False, "error": "抓取失败：" + str(exc)}), 502
        return jsonify({"ok": True, "title": title, "url": final_url,
                        "chars": len(body), "preview": body[:600]})

    @app.post("/api/collect/url")
    @auth.admin_required
    def api_collect_url():
        user = auth.current_user()
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        body = request.get_json(silent=True) or {}
        url = (body.get("url") or "").strip()
        subject = (body.get("subject") or "网络收集").strip() or "网络收集"
        summarize = body.get("summarize", True) is not False
        audit.record(user["id"], user["username"], "collect",
                     "保存网页：" + url[:120], "info", client_ip())
        quiz = bool(body.get("quiz"))
        if not url:
            return jsonify({"ok": False, "error": "请填写网址"}), 400
        try:
            result = collect.collect_url(user, url, subject, summarize, quiz)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        INDEXER.ensure_started()
        return jsonify({"ok": True, **result})

    @app.post("/api/collect/topic")
    @auth.admin_required
    def api_collect_topic():
        user = auth.current_user()
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        body = request.get_json(silent=True) or {}
        topic = (body.get("topic") or "").strip()
        subject = (body.get("subject") or "网络收集").strip() or "网络收集"
        audit.record(user["id"], user["username"], "collect",
                     "按主题收集：" + topic[:120], "info", client_ip())
        try:
            limit = min(8, max(1, int(body.get("limit") or 5)))
        except (TypeError, ValueError):
            limit = 5
        if not topic:
            return jsonify({"ok": False, "error": "请填写想收集的主题"}), 400
        try:
            result = collect.collect_topic(user, topic, subject, limit, bool(body.get("quiz")))
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        INDEXER.ensure_started()
        return jsonify({"ok": True, **result})

    @app.post("/api/collect/note")
    @auth.admin_required
    def api_collect_note():
        user = auth.current_user()
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        body = request.get_json(silent=True) or {}
        subject = (body.get("subject") or "我的笔记").strip() or "我的笔记"
        audit.record(user["id"], user["username"], "collect",
                     "保存笔记：" + str(body.get("title") or "")[:80], "info", client_ip())
        try:
            result = collect.collect_note(user, body.get("title"), body.get("content"), subject)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        INDEXER.ensure_started()
        return jsonify({"ok": True, **result})

    # ---- 索引 ----
    @app.get("/api/index/status")
    @auth.admin_required
    def api_index_status():
        return jsonify({"ok": True, "status": INDEXER.status()})

    @app.post("/api/index/control")
    @auth.admin_required
    def api_index_control():
        body = request.get_json(silent=True) or {}
        action = body.get("action") or ""
        if action == "start":
            INDEXER.paused = False
            INDEXER.ensure_started()
            return jsonify({"ok": True, "action": action})
        if action == "pause":
            INDEXER.paused = True
            return jsonify({"ok": True, "action": action})
        if action == "rescan":
            stats = catalog.scan_all()
            INDEXER.ensure_started()
            return jsonify({"ok": True, "action": action, "stats": stats})
        if action == "requeue":
            return jsonify({"ok": True, "action": action, "count": INDEXER.requeue_failed()})
        return jsonify({"ok": False, "error": "未知操作"}), 400

    @app.get("/api/index/failed")
    @auth.admin_required
    def api_index_failed():
        """读不出来的资料：failed = 还能重试，unreadable = 源文件本身的问题，重试也没用。"""
        rows = db.connect().execute(
            "SELECT id, name, subject, kind, text_state, vision_state, text_note, vision_note"
            " FROM materials"
            " WHERE text_state IN ('failed','unreadable') OR vision_state IN ('failed','unreadable')"
            " ORDER BY id LIMIT 200"
        ).fetchall()
        return jsonify({"ok": True, "items": [dict(r) for r in rows]})

    # ---- 自建模型动画 ----
    @app.get("/api/models/custom")
    @auth.login_required
    def api_models_custom():
        user = auth.current_user()
        sql, params = visible(user, "m")
        rows = db.connect().execute(
            "SELECT m.id, m.name, m.group_path, m.created_at FROM materials m"
            " WHERE m.kind='web' AND m.subject=? AND " + sql + " ORDER BY m.id DESC LIMIT 200",
            [config.MODEL_SUBJECT] + params,
        ).fetchall()
        return jsonify({"ok": True, "items": [dict(r) for r in rows]})

    @app.post("/api/models/generate")
    @auth.login_required
    def api_models_generate():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        category = str(body.get("category") or "").strip() or "我的模型"
        title = str(body.get("title") or "").strip()
        brief = str(body.get("prompt") or "").strip()
        if not title:
            return jsonify({"ok": False, "error": "请先写一个模型名称，例如“带电粒子在磁场中的螺旋运动”"}), 400
        if not ai_allowed(user):
            return jsonify({"ok": False, "error": AI_LOCKED}), 403
        audit.record(user["id"], user["username"], "ask",
                     "生成模型动画：" + category + " / " + title, "info", client_ip())
        try:
            html = ai.make_animation(title, brief)
        except Exception as exc:
            return jsonify({"ok": False, "error": "生成失败：" + str(exc)}), 502
        problem = _check_animation_html(html)
        if problem:
            return jsonify({"ok": False, "error": problem}), 400
        folder = config.UPLOAD_DIR / config.MODEL_SUBJECT / catalog.safe_component(category)
        folder.mkdir(parents=True, exist_ok=True)
        base = "【模型】" + catalog.safe_component(title)
        target = folder / (base + ".html")
        index = 1
        while target.exists():
            target = folder / (base + " (" + str(index) + ").html")
            index += 1
        target.write_text(html, encoding="utf-8")
        rel = target.relative_to(config.UPLOAD_DIR).as_posix()
        row = catalog.register_one("upload", rel, user["id"])
        return jsonify({"ok": True, "material_id": row["id"] if row else None,
                        "name": target.name, "category": category, "chars": len(html)})

    @app.post("/api/models/custom/<int:material_id>/delete")
    @auth.login_required
    def api_models_custom_delete(material_id):
        user = auth.current_user()
        conn = db.connect()
        row = conn.execute(
            "SELECT * FROM materials WHERE id=? AND source='upload' AND subject=?",
            (material_id, config.MODEL_SUBJECT),
        ).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "这个模型不存在"}), 404
        if row["owner_id"] != user["id"] and not user["is_admin"]:
            return jsonify({"ok": False, "error": "只能删除自己生成的模型"}), 403
        path = safe_resolve(row)
        if path and path.exists():
            try:
                path.resolve().relative_to(config.UPLOAD_DIR.resolve())
                path.unlink()
            except (ValueError, OSError):
                pass
        with db.tx() as tx:
            tx.execute("DELETE FROM texts WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM texts_fts WHERE material_id=?", (material_id,))
            tx.execute("DELETE FROM materials WHERE id=?", (material_id,))
        return jsonify({"ok": True})

    # ---- 局域网共用 AI ----
    @app.post("/api/settings/shared-ai")
    @auth.admin_required
    def api_settings_shared_ai():
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        flag = config.save_allow_shared_ai(bool(body.get("allow")))
        audit.record(me["id"], me["username"], "admin",
                     "局域网共用 AI：" + ("已开启（会用我的额度）" if flag else "已关闭"),
                     "warn", client_ip())
        return jsonify({"ok": True, "allow_shared_ai": flag})

    # ---- 公网静态版 ----
    @app.get("/api/webbuild/info")
    @auth.admin_required
    def api_webbuild_info():
        single = config.DIST_DIR / webbuild.PRODUCT_NAME
        built = None
        if single.exists():
            stat = single.stat()
            built = {
                "path": str(single),
                "size": stat.st_size,
                "size_label": human_size(stat.st_size),
                "at": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
            }
        return jsonify({"ok": True, "share_code": webbuild.share_code(), "built": built,
                        "dir": str(config.DIST_DIR), "product": webbuild.PRODUCT_NAME,
                        "bridge": config.bridge_settings(), "lan_url": "http://" + local_ip()
                        + ":" + str(config.PORT)})

    @app.post("/api/webbuild")
    @auth.admin_required
    def api_webbuild():
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        title = str(body.get("title") or "学习资料库").strip() or "学习资料库"
        try:
            if body.get("regenerate"):
                code = webbuild.regenerate_share_code()
            elif str(body.get("share_code") or "").strip():
                code = webbuild.save_share_code(str(body.get("share_code")))
            else:
                code = webbuild.share_code()
            result = webbuild.build(code, title)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"ok": False, "error": "生成失败：" + str(exc)}), 500
        audit.record(me["id"], me["username"], "admin",
                     "生成公网静态版（" + human_size(result["size"]) + "）", "warn", client_ip())
        return jsonify({"ok": True, "size": result["size"], "size_label": human_size(result["size"]),
                        "path": result["path"], "share_code": result["share_code"],
                        "built_at": result["built_at"]})

    @app.get("/api/webbuild/download")
    @auth.admin_required
    def api_webbuild_download():
        target = config.DIST_DIR / webbuild.PRODUCT_NAME
        if not target.exists():
            return jsonify({"ok": False, "error": "还没有生成，请先生成一次"}), 404
        return send_file(str(target), as_attachment=True,
                         download_name=webbuild.PRODUCT_NAME, mimetype="text/html")

    # ---- 管理端页面 ----
    @app.get("/admin")
    def admin_page():
        user = auth.current_user()
        if not user or not user.get("is_admin"):
            return redirect("/")
        return send_file(str(config.WEB_DIR / "admin.html"))

    # ---- 数据备份（只有管理员能用）----
    @app.get("/api/admin/backup/info")
    @auth.admin_required
    def api_backup_info():
        return jsonify({"ok": True, "info": backup.info()})

    @app.get("/api/admin/backup/db")
    @auth.admin_required
    def api_backup_db():
        user = auth.current_user()
        try:
            path = backup.snapshot()
        except Exception as exc:
            return jsonify({"ok": False, "error": "生成数据库快照失败：" + str(exc)}), 500
        audit.record(user["id"], user["username"], "backup",
                     "下载了数据库快照 " + path.name, "warn", client_ip())
        return send_file(str(path), as_attachment=True, download_name=path.name,
                         mimetype="application/octet-stream")

    @app.get("/api/admin/backup/manifest")
    @auth.admin_required
    def api_backup_manifest():
        user = auth.current_user()
        data = backup.manifest()
        audit.record(user["id"], user["username"], "backup",
                     "下载了资料清单（不含资料原文）", "warn", client_ip())
        name = "study-manifest-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
        resp = app.response_class(json.dumps(data, ensure_ascii=False, indent=2),
                                  mimetype="application/json")
        resp.headers["Content-Disposition"] = 'attachment; filename="%s"' % name
        return resp

    # ---- 设置：数据位置 & AI 接入（只有管理员能改）----
    @app.get("/api/settings")
    @auth.admin_required
    def api_settings_get():
        import shutil
        try:
            free = shutil.disk_usage(str(config.DATA_DIR)).free
        except OSError:
            free = 0
        ai_conf = config.ai_settings()
        reg_conf = config.registration_settings()
        return jsonify({
            "ok": True,
            "storage": {
                "dir": str(config.DATA_DIR),
                "default_dir": str(config.DEFAULT_DATA_DIR),
                "is_default": config.DATA_DIR == config.DEFAULT_DATA_DIR,
                "free": free,
                "free_label": human_size(free),
            },
            "registration": {
                "mode": reg_conf["mode"],
                "open": reg_conf["open"],
                "invite_code": reg_conf["invite_code"],
            },
            "allow_shared_ai": config.allow_shared_ai(),
            "bridge": config.bridge_settings(),
            "site": config.site_settings(),
            "tls": config.tls_settings(),
            "scan": config.scan_settings(),
            "scan_last": autoscan.last(),
            "source_roots": config.source_roots(),
            "lan_url": "http://" + local_ip() + ":" + str(config.PORT),
            "lan_urls": [("http://" + ip + ":" + str(config.PORT)) for ip in local_ips()],
            "ai": {
                "base_url": ai_conf["base_url"],
                "has_key": bool(ai_conf["api_key"]),
                "model_text": ai_conf["model_text"],
                "model_vision": ai_conf["model_vision"],
                "default_base_url": config.AI_DEFAULTS["base_url"],
                "default_model_text": config.AI_DEFAULTS["model_text"],
                "default_model_vision": config.AI_DEFAULTS["model_vision"],
                "is_default": ai_conf["base_url"].rstrip("/") == config.AI_DEFAULTS["base_url"].rstrip("/"),
                "presets": [
                    {"name": "本机代理（免密钥，推荐）", "base_url": "http://127.0.0.1:15721/v1",
                     "model_text": "deepseek-v4-pro", "model_vision": "deepseek-flash"},
                    {"name": "DeepSeek 官方", "base_url": "https://api.deepseek.com/v1",
                     "model_text": "deepseek-chat", "model_vision": "deepseek-chat"},
                    {"name": "硅基流动", "base_url": "https://api.siliconflow.cn/v1",
                     "model_text": "deepseek-ai/DeepSeek-V3", "model_vision": "Qwen/Qwen2.5-VL-72B-Instruct"},
                    {"name": "阿里云百炼（DashScope）", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "model_text": "qwen-plus", "model_vision": "qwen-vl-max"},
                    {"name": "智谱开放平台", "base_url": "https://open.bigmodel.cn/api/paas/v4",
                     "model_text": "glm-4-plus", "model_vision": "glm-4v-plus"},
                ],
            },
        })

    @app.post("/api/settings/site")
    @auth.admin_required
    def api_settings_site():
        """站点名字、公告、默认主题、允不允许用户自己改外观。"""
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        patch = {}
        if "name" in body:
            patch["name"] = str(body.get("name") or "").strip()[:40]
        if "announcement" in body:
            patch["announcement"] = str(body.get("announcement") or "").strip()[:500]
        if "theme" in body:
            patch["theme"] = body.get("theme") if isinstance(body.get("theme"), dict) else ""
        if "allow_user_theme" in body:
            patch["allow_user_theme"] = bool(body.get("allow_user_theme"))
        site = config.save_site(patch)
        audit.record(me["id"], me["username"], "admin", "更新了站点设置", "info", client_ip())
        return jsonify({"ok": True, "site": site})

    @app.post("/api/settings/tls")
    @auth.admin_required
    def api_settings_tls():
        """开 HTTPS：局域网里的手机/平板要用“选文件夹”就必须是安全上下文。"""
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        conf = config.save_tls(enabled=bool(body.get("enabled")), port=body.get("port"))
        has_lib = True
        try:
            import cryptography  # noqa: F401
        except Exception:
            has_lib = False
        audit.record(me["id"], me["username"], "admin",
                     ("开启" if conf["enabled"] else "关闭") + " HTTPS", "warn", client_ip())
        note = "已经开启，重启服务后生效（双击「停止.bat」再「启动.bat」），然后用 https:// 地址访问。" \
            if conf["enabled"] else "已经关闭，重启后回到 http 访问。"
        if conf["enabled"] and not has_lib:
            note = "已经开启，但缺 cryptography 库，重启后仍会用 http。请在项目目录运行：" \
                   ".venv\\Scripts\\pip install cryptography"
        return jsonify({"ok": True, "tls": conf, "has_cryptography": has_lib, "note": note})

    @app.post("/api/settings/scan")
    @auth.admin_required
    def api_settings_scan():
        """自动扫描：开关 + 间隔分钟；也可以点一下"立即扫一次"。"""
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        if body.get("now"):
            result = autoscan.run_once("手动")
            audit.record(me["id"], me["username"], "admin", result["text"], "info", client_ip())
            return jsonify({"ok": result["ok"], "scan": config.scan_settings(),
                            "last": autoscan.last(), "note": result["text"]})
        try:
            conf = config.save_scan(enabled=bool(body.get("enabled")), minutes=body.get("minutes"))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        audit.record(me["id"], me["username"], "admin",
                     ("开启" if conf["enabled"] else "关闭") + "自动扫描，间隔 "
                     + str(conf["minutes"]) + " 分钟", "info", client_ip())
        note = "已经开启：服务每隔 " + str(conf["minutes"]) + " 分钟重扫一次" \
            if conf["enabled"] else "已经关闭：只在你点“立即扫一次”，或者重启服务的时候才扫。"
        return jsonify({"ok": True, "scan": conf, "last": autoscan.last(), "note": note})

    @app.post("/api/settings/source-roots")
    @auth.admin_required
    def api_settings_source_roots():
        """只读资料目录：可增、删、改名、启停。删掉或改路径会清掉该目录已收录的资料记录。"""
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        incoming = body.get("roots")
        if not isinstance(incoming, list):
            return jsonify({"ok": False, "error": "请求格式不对"}), 400
        if len(incoming) > config.SOURCE_ROOTS_MAX:
            return jsonify({"ok": False,
                            "error": "最多支持 " + str(config.SOURCE_ROOTS_MAX) + " 个资料目录"}), 400
        old_paths = {n["id"]: n["path"] for n in config.source_roots() if n["id"]}
        base = [{"id": "", "name": "默认资料目录", "path": str(config.SOURCE_ROOT)}]
        cleaned = []
        for node in incoming:
            if not isinstance(node, dict):
                continue
            raw = str(node.get("path") or "").strip()
            if not raw:
                continue
            ok, why = config.check_source_root(raw, roots=base + cleaned)
            if not ok:
                return jsonify({"ok": False, "error": why}), 400
            rid = str(node.get("id") or "").strip()
            if not rid or any(r["id"] == rid for r in cleaned):
                rid = config.new_source_id()
            cleaned.append({"id": rid, "name": str(node.get("name") or "").strip(),
                            "path": str(Path(raw).expanduser()), "enabled": bool(node.get("enabled", True))})
        keep = {n["id"]: n["path"] for n in cleaned}
        stale = ["lib:" + rid for rid, path in old_paths.items() if keep.get(rid) != path]
        removed = catalog.purge_root_materials(stale) if stale else 0
        config.save_source_roots(cleaned)
        audit.record(me["id"], me["username"], "admin",
                     "更新资料目录（额外 " + str(len(cleaned)) + " 个，清理 " + str(removed) + " 条旧记录）",
                     "info", client_ip())
        threading.Thread(target=autoscan.run_once, args=("手动",), daemon=True).start()
        return jsonify({"ok": True, "source_roots": config.source_roots(), "removed": removed,
                        "note": "已保存，正在后台扫描新目录，稍等片刻刷新看看"})

    @app.post("/api/settings/ai")
    @auth.admin_required
    def api_settings_ai():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        base_url = str(body.get("base_url") or "").strip()
        if base_url and not re.match(r"^https?://", base_url):
            return jsonify({"ok": False, "error": "接口地址要以 http:// 或 https:// 开头"}), 400
        key = body.get("api_key")
        if key is None:
            key = config.ai_settings()["api_key"]
        current = config.apply_ai_settings(
            base_url=base_url or None,
            api_key=str(key),
            model_text=str(body.get("model_text") or "").strip() or None,
            model_vision=str(body.get("model_vision") or "").strip() or None,
        )
        audit.record(user["id"], user["username"], "admin",
                     "改 AI 接入：" + current["base_url"] + "（文本 " + current["model_text"]
                     + "，看图 " + current["model_vision"] + "）", "warn", client_ip())
        return jsonify({"ok": True, "note": "已经生效，可以直接点“测试连接”。",
                        "ai": {"base_url": current["base_url"], "has_key": bool(current["api_key"]),
                               "model_text": current["model_text"],
                               "model_vision": current["model_vision"]}})

    @app.get("/api/settings/ai")
    @auth.admin_required
    def api_settings_ai_get():
        conf = config.ai_settings()
        return jsonify({"ok": True, "ai": {
            "base_url": conf.get("base_url", ""),
            "model_text": conf.get("model_text", ""),
            "model_vision": conf.get("model_vision", ""),
            "has_key": bool(conf.get("api_key"))}})

    @app.post("/api/settings/ai/test")
    @auth.admin_required
    def api_settings_ai_test():
        body = request.get_json(silent=True) or {}
        override = {}
        for key in ("base_url", "model_text", "model_vision"):
            if body.get(key):
                override[key] = str(body[key]).strip()
        if body.get("api_key"):
            override["api_key"] = str(body["api_key"]).strip()
        if override.get("api_key"):
            base = config.ai_settings()
            conf = {"base_url": base.get("base_url", ""), "api_key": base.get("api_key") or "",
                    "model_text": base.get("model_text", ""), "model_vision": base.get("model_vision", "")}
            conf.update(override)
            ai.set_user_conf(conf)
            try:
                return jsonify({"ok": True, "result": ai.ping(),
                                "via": "按你刚填的地址测试（还没保存）"})
            finally:
                ai.set_user_conf(None)
        return jsonify({"ok": True, "result": ai.ping()})

    @app.post("/api/settings/ai/reset")
    @auth.admin_required
    def api_settings_ai_reset():
        current = config.apply_ai_settings(
            base_url=config.AI_DEFAULTS["base_url"], api_key="",
            model_text=config.AI_DEFAULTS["model_text"],
            model_vision=config.AI_DEFAULTS["model_vision"])
        return jsonify({"ok": True, "ai": {"base_url": current["base_url"],
                                           "model_text": current["model_text"],
                                           "model_vision": current["model_vision"]}})

    @app.post("/api/settings/registration")
    @auth.admin_required
    def api_settings_registration():
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        mode = str(body.get("mode") or "").strip().lower()
        if mode and mode not in config.REG_MODES:
            return jsonify({"ok": False, "error": "注册方式只能是“需要邀请码”或“开放注册”"}), 400
        code = body.get("invite_code")
        if body.get("regenerate"):
            code = config.new_invite_code()
        if code is not None and not str(code).strip():
            code = None
        conf = config.save_registration(mode=mode or None, invite_code=code)
        audit.record(me["id"], me["username"], "admin",
                     "注册方式改为 " + ("开放注册" if conf["open"] else "需要邀请码")
                     + ("（换了一个新邀请码）" if body.get("regenerate") else ""),
                     "warn", client_ip())
        return jsonify({"ok": True, "registration": {
            "mode": conf["mode"], "open": conf["open"], "invite_code": conf["invite_code"]}})

    @app.post("/api/settings/bridge")
    @auth.admin_required
    def api_settings_bridge():
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        conf = config.save_bridge(
            enabled=bool(body.get("enabled")) if "enabled" in body else None,
            token=body.get("token") if body.get("token") is not None else None,
            regenerate=bool(body.get("regenerate")))
        audit.record(me["id"], me["username"], "admin",
                     "公网版借用抓取：" + ("已开启" if conf["enabled"] else "已关闭")
                     + ("（换了新连接码）" if body.get("regenerate") else ""),
                     "warn", client_ip())
        return jsonify({"ok": True, "bridge": conf})

    @app.post("/api/settings/storage")
    @auth.admin_required
    def api_settings_storage():
        user = auth.current_user()
        body = request.get_json(silent=True) or {}
        raw = str(body.get("dir") or "").strip().strip('"')
        if not raw:
            return jsonify({"ok": False, "error": "请先选择或填写一个文件夹"}), 400
        target = Path(raw).expanduser()
        ok, err = config.check_data_dir(target)
        if not ok:
            return jsonify({"ok": False, "error": err}), 400
        if target.resolve() == config.DATA_DIR.resolve():
            return jsonify({"ok": True, "dir": str(config.DATA_DIR), "copied": 0,
                            "note": "已经在用这个位置了。"})
        copied = 0
        if body.get("copy"):
            try:
                copied = config.copy_data_to(target)
            except Exception as exc:
                return jsonify({"ok": False, "error": "复制数据时出错：" + str(exc)}), 500
        config.save_data_dir(target)
        audit.record(user["id"], user["username"], "storage",
                     "数据位置改为 " + str(target) + "（复制 " + str(copied) + " 个文件）",
                     "warn", client_ip())
        return jsonify({"ok": True, "dir": str(target), "copied": copied,
                        "note": "已保存。要重启服务才生效：先双击 停止.bat，再双击 启动.bat。"})

    @app.post("/api/settings/storage/pick")
    @auth.admin_required
    def api_settings_storage_pick():
        try:
            import tkinter
            from tkinter import filedialog
        except Exception as exc:
            return jsonify({"ok": False, "error": "这台机器上没有图形选择组件，请直接填写路径：" + str(exc)}), 400
        try:
            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            try:
                chosen = filedialog.askdirectory(title="选择数据存放位置", initialdir=str(config.DATA_DIR))
            finally:
                root.destroy()
        except Exception as exc:
            return jsonify({"ok": False, "error": "打不开选择窗口，请直接填写路径：" + str(exc)}), 400
        return jsonify({"ok": True, "picked": chosen or ""})

    # ---- 管理端接口 ----
    @app.get("/api/admin/users")
    @auth.admin_required
    def api_admin_users():
        conn = db.connect()
        stats = audit.user_stats()
        storage = audit.storage_by_user()
        violations = audit.violations()
        flags = {}
        for item in violations:
            flags[item["user_id"]] = flags.get(item["user_id"], 0) + 1
        rows = conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
        all_items = []
        for row in rows:
            base = auth.public_user(row)
            info = stats.get(row["id"], {})
            actions = info.get("actions") or {}
            used = storage.get(row["id"], 0)
            all_items.append(dict(base, uploads=info.get("uploads", 0), notes=info.get("notes", 0),
                                  favorites=info.get("favorites", 0), quizzes=info.get("quizzes", 0),
                                  actions_total=sum(actions.values()),
                                  logins=actions.get("login", 0),
                                  login_fails=actions.get("login_fail", 0),
                                  forbidden=actions.get("forbidden", 0),
                                  asks=actions.get("ask", 0),
                                  exports=actions.get("export", 0),
                                  bytes=used, bytes_label=human_size(used),
                                  quota_mb=auth.quota_mb(row["id"]),
                                  flags=flags.get(row["id"], 0)))
        total_bytes = sum(storage.values())
        # 账号多了以后一屏全列出来没法用：搜索 / 筛选 / 排序 / 分页都在后端做。
        need = str(request.args.get("q") or "").strip().lower()
        status = str(request.args.get("status") or "all").strip()
        sort = str(request.args.get("sort") or "id").strip()
        order = str(request.args.get("order") or "asc").strip()
        items = all_items
        if need:
            items = [i for i in items if need in str(i["username"]).lower()
                     or need in str(i.get("nickname") or "").lower()]
        if status == "active":
            items = [i for i in items if not i["disabled"]]
        elif status == "disabled":
            items = [i for i in items if i["disabled"]]
        elif status == "admin":
            items = [i for i in items if i["is_admin"]]
        elif status == "flagged":
            items = [i for i in items if i["flags"]]
        keys = {"id": lambda i: i["id"],
                "username": lambda i: str(i["username"]).lower(),
                "last_login": lambda i: str(i.get("last_login_at") or ""),
                "actions": lambda i: i["actions_total"],
                "bytes": lambda i: i["bytes"]}
        items = sorted(items, key=keys.get(sort, keys["id"]), reverse=(order == "desc"))
        try:
            size = max(1, min(200, int(request.args.get("size", 20))))
        except (TypeError, ValueError):
            size = 20
        pages = max(1, (len(items) + size - 1) // size)
        try:
            page = int(request.args.get("page", 1))
        except (TypeError, ValueError):
            page = 1
        page = max(1, min(page, pages))
        window = items[(page - 1) * size: page * size]
        return jsonify({"ok": True, "items": window, "violations": violations,
                        "page": page, "pages": pages, "size": size, "matched": len(items),
                        "totals": {"users": len(all_items),
                                   "disabled": sum(1 for i in all_items if i["disabled"]),
                                   "admins": sum(1 for i in all_items if i["is_admin"]),
                                   "flags": len(violations),
                                   "bytes": total_bytes, "bytes_label": human_size(total_bytes),
                                   "feedback_new": conn.execute(
                                       "SELECT COUNT(*) AS c FROM feedback WHERE status='new'").fetchone()["c"]}})

    @app.get("/api/admin/audit")
    @auth.admin_required
    def api_admin_audit():
        try:
            limit = min(500, max(1, int(request.args.get("limit", 150))))
        except (TypeError, ValueError):
            limit = 150
        user_id = request.args.get("user_id")
        items = audit.recent(limit=limit,
                             user_id=int(user_id) if str(user_id or "").isdigit() else None,
                             level=request.args.get("level") or "",
                             action=request.args.get("action") or "")
        for item in items:
            item["action_label"] = audit.ACTION_LABELS.get(item["action"], item["action"])
        return jsonify({"ok": True, "items": items})

    @app.get("/api/admin/violations")
    @auth.admin_required
    def api_admin_violations():
        return jsonify({"ok": True, "items": audit.violations()})

    @app.post("/api/admin/users/<int:user_id>/disable")
    @auth.admin_required
    def api_admin_disable(user_id):
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        disabled = bool(body.get("disabled"))
        target = auth.get_user(user_id)
        if not target:
            return jsonify({"ok": False, "error": "账号不存在"}), 404
        if target["id"] == me["id"]:
            return jsonify({"ok": False, "error": "不能停用自己"}), 400
        if disabled and target["is_admin"]:
            active = [u for u in auth.list_users_full() if u["is_admin"] and not u["disabled"]]
            if len(active) <= 1:
                return jsonify({"ok": False, "error": "至少要留一个能用的管理员"}), 400
        auth.set_disabled(user_id, disabled)
        audit.record(me["id"], me["username"], "admin",
                     ("停用" if disabled else "启用") + "账号 " + target["username"],
                     "warn", client_ip())
        return jsonify({"ok": True, "disabled": disabled})

    @app.post("/api/admin/users/<int:user_id>/password")
    @auth.admin_required
    def api_admin_password(user_id):
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        target = auth.get_user(user_id)
        if not target:
            return jsonify({"ok": False, "error": "账号不存在"}), 404
        err = auth.set_password(user_id, str(body.get("password") or ""))
        if err:
            return jsonify({"ok": False, "error": err}), 400
        audit.record(me["id"], me["username"], "admin",
                     "重置了 " + target["username"] + " 的密码", "warn", client_ip())
        return jsonify({"ok": True})

    @app.post("/api/admin/users/<int:user_id>/delete")
    @auth.admin_required
    def api_admin_delete(user_id):
        me = auth.current_user()
        target = auth.get_user(user_id)
        if not target:
            return jsonify({"ok": False, "error": "账号不存在"}), 404
        if target["id"] == me["id"]:
            return jsonify({"ok": False, "error": "不能删除自己"}), 400
        removed = auth.delete_user(user_id)
        audit.record(me["id"], me["username"], "admin",
                     "删除账号 " + target["username"] + "（连带 " + str(removed) + " 个上传文件）",
                     "warn", client_ip())
        return jsonify({"ok": True, "removed": removed})

    @app.post("/api/admin/users/bulk")
    @auth.admin_required
    def api_admin_users_bulk():
        """勾选一批账号一起处理：停用/启用、删除、重置密码、设/取消管理员、设配额。"""
        me = auth.current_user()
        body = request.get_json(silent=True) or {}
        action = str(body.get("action") or "").strip()
        if action not in ("disable", "enable", "delete", "reset_password", "set_admin",
                          "unset_admin", "quota"):
            return jsonify({"ok": False, "error": "不认识的批量操作"}), 400
        try:
            ids = [int(i) for i in (body.get("ids") or [])]
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "账号编号不正确"}), 400
        ids = [i for i in dict.fromkeys(ids)]
        if not ids:
            return jsonify({"ok": False, "error": "先勾选要处理的账号"}), 400
        if me["id"] in ids:
            return jsonify({"ok": False, "error": "不能对自己做这个操作，把你自己取消勾选"}), 400
        targets = [t for t in (auth.get_user(i) for i in ids) if t]
        if not targets:
            return jsonify({"ok": False, "error": "这些账号都不存在"}), 404
        # 会让管理员变少的操作先整批检查一遍，别做到一半才失败。
        if action in ("delete", "disable", "unset_admin"):
            touched = {t["id"] for t in targets if t["is_admin"] and not t["disabled"]}
            if touched:
                rest = [u for u in auth.list_users_full()
                        if u["is_admin"] and not u["disabled"] and u["id"] not in touched]
                if not rest:
                    return jsonify({"ok": False,
                                    "error": "至少要留一个能用的管理员，先把别的账号设为管理员"}), 400
        if action == "reset_password":
            password = str(body.get("password") or "")
            if len(password) < 6:
                return jsonify({"ok": False, "error": "密码至少 6 位"}), 400
            for t in targets:
                auth.set_password(t["id"], password)
            text = "批量把 " + str(len(targets)) + " 个账号的密码重置成同一个新密码"
        elif action == "quota":
            try:
                quota = max(0, int(body.get("quota_mb") or 0))
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "配额要填整数（MB，0 表示不限）"}), 400
            for t in targets:
                auth.set_quota(t["id"], quota)
            text = ("把 " + str(len(targets)) + " 个账号的服务器端配额设为 "
                    + ("不限" if not quota else str(quota) + " MB"))
        elif action in ("disable", "enable"):
            on = action == "disable"
            for t in targets:
                auth.set_disabled(t["id"], on)
            text = ("停用" if on else "启用") + "了 " + str(len(targets)) + " 个账号"
        elif action in ("set_admin", "unset_admin"):
            make_admin = action == "set_admin"
            for t in targets:
                auth.set_admin(t["id"], make_admin)
            text = ("设为管理员：" if make_admin else "取消管理员：") + str(len(targets)) + " 个账号"
        else:
            removed = 0
            for t in targets:
                removed += auth.delete_user(t["id"])
            text = "删除 " + str(len(targets)) + " 个账号（连带 " + str(removed) + " 个上传文件）"
        audit.record(me["id"], me["username"], "admin", text, "warn", client_ip())
        return jsonify({"ok": True, "done": len(targets), "note": text})

    @app.post("/api/admin/users/<int:user_id>/reset-code")
    @auth.admin_required
    def api_admin_reset_code(user_id):
        """给忘记密码的人生成一次性重置码（只显示这一次）。"""
        me = auth.current_user()
        target = auth.get_user(user_id)
        if not target:
            return jsonify({"ok": False, "error": "账号不存在"}), 404
        info = auth.make_reset_code(user_id)
        if not info:
            return jsonify({"ok": False, "error": "生成失败，请重试"}), 400
        audit.record(me["id"], me["username"], "admin",
                     "给 " + target["username"] + " 生成了一次性重置码", "warn", client_ip())
        return jsonify({"ok": True, "code": info["code"], "minutes": info["minutes"],
                        "expires_at": info["expires_at"], "username": info["username"]})

    @app.post("/api/auth/reset")
    def api_auth_reset():
        """忘记密码：用户名 + 管理员给的一次性重置码 + 新密码。"""
        body = request.get_json(silent=True) or {}
        username = str(body.get("username") or "").strip()
        uid, err = auth.use_reset_code(username, str(body.get("code") or ""),
                                       str(body.get("password") or ""))
        if err:
            audit.record(None, username, "reset_fail", err, "warn", client_ip())
            return jsonify({"ok": False, "error": err}), 400
        user = auth.get_user(uid)
        name = str(user["username"]) if user else username
        audit.record(uid, name, "reset", "用一次性重置码改了密码", "warn", client_ip())
        return jsonify({"ok": True, "username": name})

    # ---- 自检 ----
    @app.get("/api/selftest")
    @auth.admin_required
    def api_selftest():
        return jsonify({"ok": True, "source": _source_fingerprint(), "ai": ai.ping()})

    @app.get("/api/users")
    @auth.admin_required
    def api_users():
        return jsonify({"ok": True, "items": auth.list_users()})


app = create_app()
