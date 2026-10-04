"""扫描资料目录（只读）与上传目录，同步到 materials 表。"""
from __future__ import annotations

import os
from pathlib import Path

from . import config, db, extract

REL_SEP = "|"
SKIP_NAMES = {"Thumbs.db", "desktop.ini", ".DS_Store", "ehthumbs.db"}
SKIP_DIRS = {".git", ".obsidian", "__pycache__", "node_modules", ".venv", "$RECYCLE.BIN"}


def make_rel(source: str, rel: str) -> str:
    return source + REL_SEP + rel


def split_rel(rel_path: str):
    if REL_SEP in rel_path:
        source, rel = rel_path.split(REL_SEP, 1)
        return source, rel
    return "library", rel_path


def root_map() -> dict:
    """资料目录 id -> 绝对路径；默认目录的 id 固定是 library。"""
    out = {"library": config.SOURCE_ROOT}
    for node in config.source_roots():
        if node["id"]:
            out[node["id"]] = Path(node["path"])
    return out


def all_roots() -> list:
    """要扫描的目录，按顺序返回 [(数据库里的 source, 绝对路径)]，默认目录在最前。"""
    out = [("library", config.SOURCE_ROOT)]
    for node in config.source_roots():
        if node["id"] and node["enabled"]:
            out.append(("lib:" + node["id"], Path(node["path"])))
    return out


def abs_path_for(source: str, rel: str) -> Path:
    if source == "upload":
        return config.UPLOAD_DIR / Path(rel)
    if source.startswith("lib:"):
        root = root_map().get(source[4:])
        if root is not None:
            return root / Path(rel)
    return config.SOURCE_ROOT / Path(rel)


def resolve_material(row) -> Path:
    source, rel = split_rel(row["rel_path"])
    return abs_path_for(source, rel)


def _skip_name(name: str) -> bool:
    if name in SKIP_NAMES:
        return True
    return name.startswith("~$") or name.startswith(".")


def _walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(str(root)):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if _skip_name(name):
                continue
            full = Path(dirpath) / name
            try:
                st = full.stat()
            except OSError:
                continue
            if not full.is_file():
                continue
            yield full.relative_to(root).as_posix(), full, st


def _initial_states(kind: str):
    if kind in ("pdf", "word", "ppt", "excel", "text"):
        return "pending", "pending"
    if kind == "image":
        return "skip", "pending"
    return "skip", "skip"


def _apply_one(conn, source: str, rel: str, st, added_by=None) -> str:
    """插入或更新单条记录，返回 add / update / reset / same。"""
    from .auth import now_iso

    rel_path = make_rel(source, rel)
    parts = rel.split("/")
    subject = parts[0] if len(parts) > 1 else config.UNCLASSIFIED
    group_path = "/".join(parts[1:-1]) if len(parts) > 2 else ""
    name = parts[-1]
    ext = extract.ext_of(name)
    kind = extract.kind_of(ext)
    row = conn.execute("SELECT * FROM materials WHERE rel_path=?", (rel_path,)).fetchone()
    if row is None:
        text_state, vision_state = _initial_states(kind)
        owner_id = added_by if source == "upload" else None
        priority = 1 if source == "upload" else 0
        conn.execute(
            "INSERT INTO materials(source, rel_path, name, subject, group_path, ext, kind,"
            " size, mtime, text_state, vision_state, priority, added_by, owner_id, visibility,"
            " created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (source, rel_path, name, subject, group_path, ext, kind, st.st_size, st.st_mtime,
             text_state, vision_state, priority, added_by, owner_id, "private", now_iso(), now_iso()),
        )
        return "add"
    changed = (int(row["size"]) != int(st.st_size)) or (
        abs(float(row["mtime"]) - float(st.st_mtime)) > 1.0) or (row["kind"] != kind)
    if changed:
        text_state, vision_state = _initial_states(kind)
        conn.execute("DELETE FROM texts WHERE material_id=?", (row["id"],))
        conn.execute("DELETE FROM texts_fts WHERE material_id=?", (row["id"],))
        conn.execute(
            "UPDATE materials SET size=?, mtime=?, name=?, subject=?, group_path=?, ext=?,"
            " kind=?, text_state=?, vision_state=?, priority=1, updated_at=? WHERE id=?",
            (st.st_size, st.st_mtime, name, subject, group_path, ext, kind,
             text_state, vision_state, now_iso(), row["id"]),
        )
        return "reset"
    if row["subject"] != subject or row["group_path"] != group_path or row["name"] != name:
        conn.execute(
            "UPDATE materials SET subject=?, group_path=?, name=?, updated_at=? WHERE id=?",
            (subject, group_path, name, now_iso(), row["id"]),
        )
        return "update"
    return "same"


def _sync(conn, source: str, root: Path, added_by=None) -> dict:
    stats = {"add": 0, "reset": 0, "update": 0, "same": 0}
    for rel, full, st in _walk(root):
        stats[_apply_one(conn, source, rel, st, added_by)] += 1
    return stats


def scan_all() -> dict:
    conn = db.connect()
    stats = {}
    for source, root in all_roots():
        if root.exists():
            stats[source] = _sync(conn, source, root)
        else:
            stats[source] = {"error": "资料目录不存在：" + str(root)}
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stats["upload"] = _sync(conn, "upload", config.UPLOAD_DIR)
    conn.commit()
    stats["total"] = conn.execute("SELECT COUNT(*) AS c FROM materials").fetchone()["c"]
    return stats


def register_one(source: str, rel: str, added_by=None):
    if source == "upload":
        root = config.UPLOAD_DIR
    elif source.startswith("lib:"):
        root = root_map().get(source[4:])
        if root is None:
            return None
    else:
        root = config.SOURCE_ROOT
    full = root / Path(rel)
    if not full.exists() or not full.is_file():
        return None
    conn = db.connect()
    _apply_one(conn, source, rel, full.stat(), added_by)
    conn.commit()
    return conn.execute(
        "SELECT * FROM materials WHERE rel_path=?", (make_rel(source, rel),)
    ).fetchone()


def purge_root_materials(sources) -> int:
    """移除资料目录时，把该目录下的资料记录一起清掉（不动磁盘上的文件）。"""
    keys = [str(x) for x in (sources or []) if str(x or "").strip()]
    if not keys:
        return 0
    conn = db.connect()
    removed = 0
    for source in keys:
        rows = conn.execute("SELECT id FROM materials WHERE source=?", (source,)).fetchall()
        for row in rows:
            conn.execute("DELETE FROM texts WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM texts_fts WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM summaries WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM notes WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM favorites WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM quiz_attempts WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM progress WHERE material_id=?", (row["id"],))
            conn.execute("DELETE FROM materials WHERE id=?", (row["id"],))
            removed += 1
    conn.commit()
    return removed


def subjects() -> list:
    conn = db.connect()
    rows = conn.execute(
        "SELECT subject, COUNT(*) AS total, SUM(size) AS bytes FROM materials"
        " GROUP BY subject ORDER BY subject ASC"
    ).fetchall()
    return [{"name": r["subject"], "count": r["total"], "bytes": r["bytes"] or 0} for r in rows]


def safe_component(value: str) -> str:
    text = (value or "").strip() or config.UNCLASSIFIED
    for ch in "/\x5c:*?\"<>|":
        text = text.replace(ch, "_")
    text = text.replace("..", "_")
    return text[:80]


def unique_upload_path(subject: str, filename: str) -> Path:
    target_dir = config.UPLOAD_DIR / safe_component(subject)
    target_dir.mkdir(parents=True, exist_ok=True)
    base = Path(filename).name
    stem = Path(base).stem
    suffix = Path(base).suffix
    candidate = target_dir / base
    index = 1
    while candidate.exists():
        candidate = target_dir / (stem + " (" + str(index) + ")" + suffix)
        index += 1
    return candidate
