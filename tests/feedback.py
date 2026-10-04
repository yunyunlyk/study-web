"""用户反馈的接口回归：提交 / 只看自己的 / 管理员处理 / 权限边界。"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import auth, db  # noqa: E402

BASE = "http://127.0.0.1:8787"
PWD = "fb_pass_1234"
PASS = []
FAIL = []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (("  -> " + str(detail)[:160]) if detail else ""), flush=True)


def ensure(username, admin=False):
    db.init_db()
    conn = db.connect()
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if row:
        conn.execute("UPDATE users SET is_admin=?, disabled=0 WHERE id=?", (1 if admin else 0, row["id"]))
        conn.commit()
        return row["id"]
    with db.tx() as tx:
        cur = tx.execute("INSERT INTO users(username, password_hash, is_admin, created_at) VALUES(?,?,?,?)",
                         (username, auth.hash_password(PWD), 1 if admin else 0, auth.now_iso()))
    return cur.lastrowid


def login(username):
    s = requests.Session()
    r = s.post(BASE + "/api/login", json={"username": username, "password": PWD}, timeout=20)
    assert r.status_code == 200, r.text[:200]
    return s


def main():
    ensure("ui_fb_a")
    ensure("ui_fb_b")
    admin_id = ensure("ui_fb_admin", admin=True)

    anon = requests.post(BASE + "/api/feedback", json={"content": "x"}, timeout=20)
    check("没登录不能提交反馈", anon.status_code in (401, 403), anon.status_code)

    a = login("ui_fb_a")
    bad = a.post(BASE + "/api/feedback", json={"content": "   "}, timeout=20)
    check("空内容被拒绝", bad.status_code == 400, bad.text[:120])
    long_text = "长" * 2001
    over = a.post(BASE + "/api/feedback", json={"content": long_text}, timeout=20)
    check("超长内容被拒绝", over.status_code == 400, over.text[:120])

    r = a.post(BASE + "/api/feedback",
               json={"kind": "bug", "content": "反馈回归：搜索有时重复。", "contact": "a@example.com",
                     "page": "#/search"}, timeout=20)
    check("普通用户可以提交反馈", r.status_code == 200 and r.json().get("id"), r.text[:160])
    fid = r.json()["id"]

    mine = a.get(BASE + "/api/feedback", timeout=20).json()
    check("提交后能查到自己的反馈", any(i["id"] == fid for i in mine["items"]), len(mine["items"]))
    check("普通用户看不到全局未读数", mine.get("new_count") == 0, mine.get("new_count"))
    item = [i for i in mine["items"] if i["id"] == fid][0]
    check("新反馈状态是 new", item["status"] == "new", item["status"])

    b = login("ui_fb_b")
    other = b.get(BASE + "/api/feedback", timeout=20).json()
    check("别人的反馈看不到", not any(i["id"] == fid for i in other["items"]), len(other["items"]))
    for act, url in (("改状态", BASE + "/api/feedback/" + str(fid) + "/status"),
                     ("删除", BASE + "/api/feedback/" + str(fid) + "/delete")):
        rr = b.post(url, json={"status": "done"}, timeout=20)
        check("普通用户不能" + act + "反馈", rr.status_code == 403, rr.status_code)

    adm = login("ui_fb_admin")
    board = adm.get(BASE + "/api/feedback", timeout=20).json()
    check("管理员能看到全部反馈", any(i["id"] == fid for i in board["items"]))
    check("管理员能看到未读数量", board.get("new_count", 0) >= 1, board.get("new_count"))

    sr = adm.post(BASE + "/api/feedback/" + str(fid) + "/status",
                  json={"status": "done", "reply": "已收到，下个版本修。"}, timeout=20)
    check("管理员可以回复并标记已处理", sr.status_code == 200, sr.text[:120])

    after = a.get(BASE + "/api/feedback", timeout=20).json()
    done = [i for i in after["items"] if i["id"] == fid][0]
    check("用户能看到管理员回复", done["reply"] == "已收到，下个版本修。", done["reply"])
    check("用户能看到已处理状态", done["status"] == "done" and done["handled_at"], done["status"])

    filt = adm.get(BASE + "/api/feedback?status=done", timeout=20).json()
    check("按状态筛选生效", all(i["status"] == "done" for i in filt["items"]), len(filt["items"]))

    dr = adm.post(BASE + "/api/feedback/" + str(fid) + "/delete", json={}, timeout=20)
    gone = a.get(BASE + "/api/feedback", timeout=20).json()
    check("管理员可以删除反馈", dr.status_code == 200 and not any(i["id"] == fid for i in gone["items"]))
    check("不存在的反馈返回 404",
          adm.post(BASE + "/api/feedback/" + str(fid) + "/status", json={"status": "done"},
                   timeout=20).status_code == 404)

    print("\n" + "=" * 60)
    for name in FAIL:
        print("  FAILED: " + name)
    print("feedback 测试：共 %d 项，失败 %d 项" % (len(PASS) + len(FAIL), len(FAIL)))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
