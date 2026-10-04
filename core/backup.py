"""管理端数据备份：数据库快照 + 资料清单。

快照用 SQLite 自己的 VACUUM INTO 生成：WAL 模式下也是一致的，而且顺带压缩，
不需要停服务。快照只在磁盘上留最近一份，免得白占用户的硬盘。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config, db

TZ = timezone(timedelta(hours=8))
KEEP = 1
BACKUP_DIR = config.DATA_DIR / "backups"
TABLES = ("users", "materials", "texts", "summaries", "notes", "favorites",
          "quiz_attempts", "exports", "qa", "feedback", "ai_jobs")


def human_bytes(num) -> str:
    n = float(num or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024
    return "%.1f GB" % n


def _now_text() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


def _stamp() -> str:
    return datetime.now(TZ).strftime("%Y%m%d-%H%M%S")


def snapshots() -> list:
    if not BACKUP_DIR.exists():
        return []
    files = [p for p in BACKUP_DIR.glob("study-*.db") if p.is_file()]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def snapshot() -> Path:
    """生成一份一致的数据库快照，返回文件路径（只保留最近 KEEP 份）。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / ("study-" + _stamp() + ".db")
    extra = 1
    while target.exists():
        extra += 1
        target = BACKUP_DIR / ("study-" + _stamp() + "-" + str(extra) + ".db")
    conn = sqlite3.connect(str(config.DB_PATH), timeout=60)
    try:
        conn.execute("VACUUM INTO ?", (str(target),))
    finally:
        conn.close()
    for old in snapshots()[KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass
    return target


def last_backup():
    files = snapshots()
    if not files:
        return None
    st = files[0].stat()
    return {"name": files[0].name, "size": st.st_size, "size_label": human_bytes(st.st_size),
            "at": datetime.fromtimestamp(st.st_mtime, TZ).strftime("%Y-%m-%d %H:%M:%S")}


def uploads_inventory(limit: int = 0) -> dict:
    root = config.UPLOAD_DIR
    items = []
    count = 0
    total = 0
    if root.exists():
        for f in sorted(root.rglob("*")):
            if not f.is_file():
                continue
            st = f.stat()
            count += 1
            total += st.st_size
            if not limit or len(items) < limit:
                items.append({"path": f.relative_to(root).as_posix(), "size": st.st_size,
                              "size_label": human_bytes(st.st_size),
                              "at": datetime.fromtimestamp(st.st_mtime, TZ).strftime("%Y-%m-%d %H:%M")})
    return {"dir": str(root), "count": count, "bytes": total, "items": items}


def _db_bytes() -> int:
    try:
        return config.DB_PATH.stat().st_size
    except OSError:
        return 0


def info() -> dict:
    conn = db.connect()
    row = conn.execute("SELECT COUNT(*) AS c, SUM(size) AS b FROM materials").fetchone()
    up = uploads_inventory(limit=60)
    try:
        free = shutil.disk_usage(str(config.DATA_DIR)).free
    except OSError:
        free = 0
    return {
        "db": {"path": str(config.DB_PATH), "bytes": _db_bytes(),
               "size_label": human_bytes(_db_bytes()),
               "materials": row["c"], "library_bytes": row["b"] or 0,
               "library_label": human_bytes(row["b"] or 0)},
        "uploads": {"dir": up["dir"], "count": up["count"], "bytes": up["bytes"],
                    "size_label": human_bytes(up["bytes"]), "items": up["items"]},
        "backup_dir": str(BACKUP_DIR),
        "last": last_backup(),
        "keep": KEEP,
        "disk_free": free,
        "disk_free_label": human_bytes(free),
        "note": "数据库里是账号、笔记、收藏、做题记录和资料索引；资料原文件在 uploads 目录里，"
                "备份时把那个文件夹一起拷走才是完整的。",
    }


def manifest() -> dict:
    conn = db.connect()
    tables = {}
    for name in TABLES:
        try:
            tables[name] = conn.execute("SELECT COUNT(*) AS c FROM " + name).fetchone()["c"]
        except sqlite3.Error:
            tables[name] = None
    subjects = [{"subject": r["subject"], "files": r["c"], "bytes": r["b"] or 0,
                 "size_label": human_bytes(r["b"] or 0)}
                for r in conn.execute("SELECT subject, COUNT(*) AS c, SUM(size) AS b FROM materials"
                                      " GROUP BY subject ORDER BY subject ASC")]
    up = uploads_inventory(limit=5000)
    return {
        "generated_at": _now_text(),
        "site": dict(config.site_settings()),
        "database": {"path": str(config.DB_PATH), "bytes": _db_bytes(),
                     "size_label": human_bytes(_db_bytes())},
        "tables": tables,
        "library": {"files": sum(s["files"] for s in subjects),
                    "bytes": sum(s["bytes"] for s in subjects), "subjects": subjects},
        "uploads": {"dir": up["dir"], "count": up["count"], "bytes": up["bytes"],
                    "size_label": human_bytes(up["bytes"]), "items": up["items"]},
        "note": "这个清单里没有任何密钥。资料原文件在 uploads 目录里，做完整备份时请连它一起拷走。",
    }
