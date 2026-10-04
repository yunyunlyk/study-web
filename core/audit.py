"""操作留痕与异常行为检查：管理端用来看谁在干什么、有没有不对劲。"""
from __future__ import annotations

from . import db
from .auth import now_iso

LEVELS = ("info", "warn", "alert")

# 这些后缀属于可执行/脚本类，正常学习资料里不该出现
RISKY_EXTS = {
    "exe", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "scr", "msi", "msp", "dll", "com", "pif", "reg", "jar", "hta", "cpl", "lnk",
}

ACTION_LABELS = {
    "register": "注册账号",
    "register_fail": "注册被拒（邀请码不对）",
    "login": "登录",
    "login_fail": "登录失败",
    "logout": "退出登录",
    "upload": "上传资料",
    "download": "下载原文件",
    "export": "导出资料",
    "collect": "网上收集",
    "ask": "AI 问答",
    "index": "手动索引",
    "storage": "修改数据位置",
    "forbidden": "越权访问",
    "admin": "管理操作",
    "feedback": "提交反馈",
    "qa": "疑问解答",
    "reset": "用重置码改密码",
    "reset_fail": "重置码不对/过期",
}


def record(user_id, username: str, action: str, detail: str = "", level: str = "info", ip: str = "") -> None:
    if level not in LEVELS:
        level = "info"
    try:
        with db.tx() as conn:
            conn.execute(
                "INSERT INTO audit_log(user_id, username, action, level, detail, ip, created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (user_id, username or "", action, level, str(detail)[:500], ip or "", now_iso()),
            )
    except Exception:
        pass


def recent(limit: int = 200, user_id=None, level: str = "", action: str = "") -> list:
    sql = "SELECT * FROM audit_log WHERE 1=1"
    params = []
    if user_id:
        sql += " AND user_id=?"
        params.append(user_id)
    if level:
        sql += " AND level=?"
        params.append(level)
    if action:
        sql += " AND action=?"
        params.append(action)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit))
    rows = db.connect().execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def _window(minutes: int) -> str:
    return "datetime('now','-" + str(int(minutes)) + " minutes')"


def _grouped(action: str, minutes: int, minimum: int, group_by: str = "user_id") -> list:
    rows = db.connect().execute(
        "SELECT user_id, username, COUNT(*) AS c, MAX(created_at) AS last_at"
        " FROM audit_log WHERE action=? AND datetime(created_at) >= " + _window(minutes) +
        " GROUP BY " + group_by + " HAVING c >= ?",
        (action, minimum),
    ).fetchall()
    return [dict(r) for r in rows]


def _risky_uploads() -> list:
    rows = db.connect().execute(
        "SELECT m.owner_id AS user_id, u.username AS username, COUNT(*) AS c,"
        " MAX(m.created_at) AS last_at, GROUP_CONCAT(DISTINCT m.ext) AS kinds"
        " FROM materials m LEFT JOIN users u ON u.id = m.owner_id"
        " WHERE m.source='upload' AND m.owner_id IS NOT NULL AND m.ext IN ("
        + ",".join("?" * len(RISKY_EXTS)) + ")"
        " GROUP BY m.owner_id",
        tuple(sorted(RISKY_EXTS)),
    ).fetchall()
    return [dict(r) for r in rows]


RULES = (
    ("login_fail_burst", "alert", "短时间内反复登录失败（疑似试密码）", 5),
    ("forbidden_burst", "alert", "反复尝试打开别人的私密资料（都被拦下了）", 5),
    ("ai_burst", "warn", "短时间内大量调用 AI（疑似脚本刷接口）", 200),
    ("register_fail_burst", "warn", "反复拿邀请码试注册", 5),
)

# 规则名 -> (动作, 时间窗口分钟)
#
# 故意只管「安全性」行为：
#   · 反复试别人的密码
#   · 反复去戳别人的私密资料
#   · 用脚本猛刷 AI 接口
#   · 上传可执行 / 脚本类文件（见 RISKY_EXTS）
# 上传数量本身**不做限制**，一次传几百个文件也正常，不算违规。
RULE_SOURCE = {
    "login_fail_burst": ("login_fail", 30),
    "forbidden_burst": ("forbidden", 60),
    "ai_burst": ("ask", 60),
    "register_fail_burst": ("register_fail", 30),
}


def violations() -> list:
    """把所有异常行为汇总成一张表，供管理端展示。"""
    found = []
    for name, level, label, minimum in RULES:
        action, minutes = RULE_SOURCE[name]
        for row in _grouped(action, minutes, minimum):
            found.append({
                "rule": name,
                "level": level,
                "label": label,
                "user_id": row["user_id"],
                "username": row["username"] or ("#%s" % row["user_id"]),
                "count": row["c"],
                "window_minutes": minutes,
                "last_at": row["last_at"],
                "detail": "近 " + str(minutes) + " 分钟内 " + str(row["c"]) + " 次",
            })
    for row in _risky_uploads():
        found.append({
            "rule": "risky_upload",
            "level": "alert",
            "label": "上传了可执行/脚本类文件",
            "user_id": row["user_id"],
            "username": row["username"] or ("#%s" % row["user_id"]),
            "count": row["c"],
            "window_minutes": 0,
            "last_at": row["last_at"],
            "detail": "涉及后缀：" + str(row["kinds"] or ""),
        })
    order = {"alert": 0, "warn": 1}
    found.sort(key=lambda item: (order.get(item["level"], 2), -(item["count"] or 0)))
    return found


def storage_by_user() -> dict:
    """每个账号在服务器上占了多少字节（只有上传到服务器的文件才算；浏览器里的算不到）。"""
    rows = db.connect().execute(
        "SELECT owner_id, COALESCE(SUM(size), 0) AS n FROM materials"
        " WHERE source='upload' AND owner_id IS NOT NULL GROUP BY owner_id")
    return {int(r["owner_id"]): int(r["n"] or 0) for r in rows}


def user_stats() -> dict:
    """每个账号的活动概览。"""
    conn = db.connect()
    stats = {}
    for row in conn.execute(
        "SELECT user_id, action, COUNT(*) AS c FROM audit_log GROUP BY user_id, action"
    ):
        stats.setdefault(row["user_id"], {})[row["action"]] = row["c"]
    uploads = {r["owner_id"]: r["c"] for r in conn.execute(
        "SELECT owner_id, COUNT(*) AS c FROM materials WHERE source='upload' AND owner_id IS NOT NULL"
        " GROUP BY owner_id")}
    notes = {r["user_id"]: r["c"] for r in conn.execute(
        "SELECT user_id, COUNT(*) AS c FROM notes GROUP BY user_id")}
    favs = {r["user_id"]: r["c"] for r in conn.execute(
        "SELECT user_id, COUNT(*) AS c FROM favorites GROUP BY user_id")}
    quizzes = {r["user_id"]: r["c"] for r in conn.execute(
        "SELECT user_id, COUNT(*) AS c FROM quiz_attempts GROUP BY user_id")}
    out = {}
    for user_id, actions in stats.items():
        out[user_id] = {
            "uploads": uploads.get(user_id, 0),
            "notes": notes.get(user_id, 0),
            "favorites": favs.get(user_id, 0),
            "quizzes": quizzes.get(user_id, 0),
            "actions": actions,
        }
    return out
