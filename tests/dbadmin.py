"""测试数据管理：wipe 清空数据库，cleanup 只删测试账号留下的东西。"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config, db

TEST_PREFIXES = ("admin_", "guest_", "verify_", "verifyadm", "smokeadmin", "tmp", "dbg_", "ui_")


def wipe():
    for suffix in ("", "-wal", "-shm"):
        target = Path(str(config.DB_PATH) + suffix)
        if target.exists():
            target.unlink()
    for folder in (config.UPLOAD_DIR, config.EXPORT_DIR, config.THUMB_DIR):
        if folder.exists():
            for child in folder.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
    print("已清空数据库、上传、导出与缩略图缓存")


def _sweep_orphan_logs(conn) -> int:
    """清掉指向已删账号的操作日志。更早版本的清理只删账号、没删它的日志，会留下孤儿行。

    注意 user_id 为 NULL 的那些是「匿名注册失败」等正常记录，NOT IN 对 NULL 不成立，
    所以这里不会误删它们。
    """
    orphans = conn.execute(
        "SELECT COUNT(*) AS c FROM audit_log WHERE user_id IS NOT NULL"
        " AND user_id NOT IN (SELECT id FROM users)").fetchone()["c"]
    if orphans:
        with db.tx() as tx:
            tx.execute("DELETE FROM audit_log WHERE user_id IS NOT NULL"
                       " AND user_id NOT IN (SELECT id FROM users)")
    return orphans


def prune():
    """清掉指向「文件已经不在了」的导出记录（旧版清理脚本误删过成品，会留下这种死记录）。"""
    conn = db.connect()
    rows = conn.execute("SELECT id, file_name FROM exports").fetchall()
    dead = []
    for row in rows:
        target = (config.EXPORT_DIR / str(row["file_name"])).resolve()
        try:
            target.relative_to(config.EXPORT_DIR.resolve())
        except ValueError:
            continue
        if not target.exists():
            dead.append(row["id"])
    if dead:
        marks = ",".join("?" * len(dead))
        with db.tx() as tx:
            tx.execute("DELETE FROM exports WHERE id IN (" + marks + ")", dead)
    print("清掉 " + str(len(dead)) + " 条「成品已不存在」的导出记录，剩下 "
          + str(len(rows) - len(dead)) + " 条文件都还在")


def cleanup():
    conn = db.connect()
    rows = conn.execute("SELECT id, username FROM users").fetchall()
    test_ids = [r["id"] for r in rows if str(r["username"]).startswith(TEST_PREFIXES)]
    # 孤儿日志的清理跟「有没有测试账号」无关，所以放在前面，别被下面的提前返回跳过。
    orphans = _sweep_orphan_logs(conn)
    if orphans:
        print("清掉 " + str(orphans) + " 行指向已删账号的孤儿操作日志")
    if not test_ids:
        print("没有发现测试账号")
        return
    marks = ",".join("?" * len(test_ids))
    uploads = conn.execute(
        "SELECT id, rel_path FROM materials WHERE owner_id IN (" + marks + ")", test_ids
    ).fetchall()
    removed_files = 0
    for row in uploads:
        source, rel = (row["rel_path"].split("|", 1) + [""])[:2]
        if source != "upload" or not rel:
            continue
        path = (config.UPLOAD_DIR / Path(rel)).resolve()
        try:
            path.relative_to(config.UPLOAD_DIR.resolve())
        except ValueError:
            continue
        if path.exists():
            path.unlink()
            removed_files += 1
    export_rows = conn.execute(
        "SELECT file_name FROM exports WHERE user_id IN (" + marks + ")", test_ids
    ).fetchall()
    for row in export_rows:
        target = (config.EXPORT_DIR / row["file_name"]).resolve()
        try:
            target.relative_to(config.EXPORT_DIR.resolve())
        except ValueError:
            continue
        target.unlink(missing_ok=True)
    upload_ids = [r["id"] for r in uploads]
    with db.tx() as tx:
        if upload_ids:
            u_marks = ",".join("?" * len(upload_ids))
            tx.execute("DELETE FROM texts_fts WHERE material_id IN (" + u_marks + ")", upload_ids)
            tx.execute("DELETE FROM texts WHERE material_id IN (" + u_marks + ")", upload_ids)
            # 只删「测试账号自己上传的那些资料」的 AI 笔记。
            # 这里以前是不带条件的 DELETE FROM summaries —— 会把整张表清空，
            # 等于顺手删掉站长自己资料上的全部 AI 笔记，跟「只清测试数据」完全不符。
            tx.execute("DELETE FROM summaries WHERE material_id IN (" + u_marks + ")", upload_ids)
            tx.execute("DELETE FROM materials WHERE id IN (" + u_marks + ")", upload_ids)
        tx.execute("DELETE FROM favorites WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM notes WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM progress WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM quiz_attempts WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM exports WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM audit_log WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM password_resets WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM feedback WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM qa WHERE user_id IN (" + marks + ")", test_ids)
        tx.execute("DELETE FROM users WHERE id IN (" + marks + ")", test_ids)
    # 导出成品按上面的 exports 表逐条删过了，不再按文件名通配删。
    # 以前这里还会 glob 掉 data/exports 下所有 study-*/notes-*/share-*，
    # 连站长自己导出的成品一起删掉。
    remaining_users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    remaining_materials = conn.execute("SELECT COUNT(*) AS c FROM materials").fetchone()["c"]
    print("已删除测试账号 " + str(len(test_ids)) + " 个、上传文件 " + str(removed_files)
          + " 个，以及它们自己的笔记/收藏/做题/导出记录")
    print("剩余账号 " + str(remaining_users) + " 个，剩余资料 " + str(remaining_materials) + " 条")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "wipe":
        wipe()
    elif action == "cleanup":
        cleanup()
    elif action == "prune":
        prune()
    else:
        print("用法：python tests/dbadmin.py wipe|cleanup|prune")
        raise SystemExit(2)
