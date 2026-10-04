"""疑问解答区的接口回归：提问 / 共享可见 / 权限边界 / 管理员解答。"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import auth, db  # noqa: E402

BASE = "http://127.0.0.1:8787"
PWD = "qa_pass_1234"
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
    ensure("ui_qa_a")
    ensure("ui_qa_b")
    ensure("ui_qa_admin", admin=True)

    check("没登录看不到疑问解答",
          requests.get(BASE + "/api/qa", timeout=20).status_code in (401, 403))

    a = login("ui_qa_a")
    check("空问题被拒绝", a.post(BASE + "/api/qa", json={"question": "  "}, timeout=20).status_code == 400)
    check("超长问题被拒绝",
          a.post(BASE + "/api/qa", json={"question": "问" * 1001}, timeout=20).status_code == 400)

    r = a.post(BASE + "/api/qa", json={"question": "QA 回归：为什么平抛运动的水平方向是匀速的？"}, timeout=20)
    check("可以提问", r.status_code == 200 and r.json()["item"]["id"], r.text[:140])
    qid = r.json()["item"]["id"]
    check("新问题标记为自己提的", r.json()["item"]["mine"] is True)
    check("新问题还没有解答", r.json()["item"]["answer"] == "")

    listing = a.get(BASE + "/api/qa", timeout=20).json()
    check("提问后能查到", any(i["id"] == qid for i in listing["items"]))
    check("列表带统计", isinstance(listing.get("total"), int) and isinstance(listing.get("open"), int),
          (listing.get("total"), listing.get("open")))

    b = login("ui_qa_b")
    shared = b.get(BASE + "/api/qa", timeout=20).json()
    check("别人也能看到问题（共享解答区）", any(i["id"] == qid for i in shared["items"]))
    mine_flag = [i for i in shared["items"] if i["id"] == qid][0]["mine"]
    check("别人的问题不会标成自己的", mine_flag is False)
    check("别人不能删我的提问",
          b.post(BASE + "/api/qa/" + str(qid) + "/delete", json={}, timeout=20).status_code == 403)
    check("别人不能让 AI 解答我的提问",
          b.post(BASE + "/api/qa/" + str(qid) + "/ai", json={}, timeout=20).status_code == 403)
    check("普通用户不能直接写解答",
          b.post(BASE + "/api/qa/" + str(qid) + "/answer", json={"answer": "x"}, timeout=20).status_code == 403)

    adm = login("ui_qa_admin")
    ar = adm.post(BASE + "/api/qa/" + str(qid) + "/answer",
                  json={"answer": "因为水平方向不受力，加速度为零。"}, timeout=20)
    check("管理员可以解答", ar.status_code == 200 and ar.json()["item"]["answer_source"] == "admin", ar.text[:140])

    back = a.get(BASE + "/api/qa", timeout=20).json()
    done = [i for i in back["items"] if i["id"] == qid][0]
    check("提问者能看到管理员解答", done["answer"] == "因为水平方向不受力，加速度为零。", done["answer"])
    check("解答人记录下来", done["answered_by"] == "ui_qa_admin" and done["answered_at"], done["answered_by"])

    found = b.get(BASE + "/api/qa?q=" + "平抛", timeout=20).json()
    check("搜索能在问题里找到", any(i["id"] == qid for i in found["items"]))
    found2 = b.get(BASE + "/api/qa?q=" + "不受力", timeout=20).json()
    check("搜索能在解答里找到", any(i["id"] == qid for i in found2["items"]))

    check("提问者可以删自己的提问",
          a.post(BASE + "/api/qa/" + str(qid) + "/delete", json={}, timeout=20).status_code == 200)
    check("删掉之后看不到", not any(i["id"] == qid for i in
                                    a.get(BASE + "/api/qa", timeout=20).json()["items"]))
    check("删不存在的问题返回 404",
          adm.post(BASE + "/api/qa/" + str(qid) + "/answer", json={"answer": "x"}, timeout=20).status_code == 404)

    print("\n" + "=" * 60)
    for name in FAIL:
        print("  FAILED: " + name)
    print("qa 测试：共 %d 项，失败 %d 项" % (len(PASS) + len(FAIL), len(FAIL)))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
