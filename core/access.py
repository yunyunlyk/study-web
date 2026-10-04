"""访问控制：默认私有，只有本人（或共享/导出）才能看到资料。"""
from __future__ import annotations

from . import db


def visible_clause(user, alias: str = "m"):
    """返回 (SQL 片段, 参数列表)。管理员能看到自己文件夹（owner_id 为空）的资料。"""
    if user and user.get("is_admin"):
        return ("(" + alias + ".visibility='shared' OR " + alias + ".owner_id=? OR "
                + alias + ".owner_id IS NULL)"), [user["id"]]
    return ("(" + alias + ".visibility='shared' OR " + alias + ".owner_id=?)"), [user["id"]]


def can_view(user, row) -> bool:
    if not user or row is None:
        return False
    if row["visibility"] == "shared":
        return True
    owner = row["owner_id"]
    if owner is None:
        return bool(user.get("is_admin"))
    return int(owner) == int(user["id"])


def can_manage(user, row) -> bool:
    """谁可以改动共享状态：资料归属人，或管理员对无归属的资料。"""
    if not user or row is None:
        return False
    owner = row["owner_id"]
    if owner is None:
        return bool(user.get("is_admin"))
    return int(owner) == int(user["id"])


def set_visibility(user, material_id: int, shared: bool):
    row = db.connect().execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
    if row is None:
        return False, "资料不存在"
    if not can_manage(user, row):
        return False, "只有资料的归属人可以修改共享状态"
    with db.tx() as tx:
        tx.execute("UPDATE materials SET visibility=? WHERE id=?",
                   ("shared" if shared else "private", material_id))
    return True, ""
