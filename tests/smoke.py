"""端到端验收测试：对着运行中的服务跑，逐项断言。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config
try:
    import sys as _sys
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


BASE = "http://127.0.0.1:8787"
PASS = []
FAIL = []


def db_rows(sql, params=()):
    conn = sqlite3.connect(str(config.DB_PATH), timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params)]
    finally:
        conn.close()


def db_exec(sql, params=()):
    conn = sqlite3.connect(str(config.DB_PATH), timeout=20)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def invite():
    """当前注册方式如果是“需要邀请码”，注册时要带上它。"""
    try:
        conf = json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        conf = {}
    return str(conf.get("invite_code") or "")


def register_body(name, password):
    body = {"username": name, "password": password}
    code = invite()
    if code:
        body["invite"] = code
    return body


def uploads_snapshot():
    root = config.BASE_DIR / "data" / "uploads"
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (("  -> " + str(detail)) if detail else ""), flush=True)


def session():
    return requests.Session()


def wait_scan(client, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        data = client.get(BASE + "/api/index/status", timeout=10).json()
        status = data.get("status") or {}
        if status.get("total", 0) > 0:
            return status["total"]
        time.sleep(2)
    return 0


def main():
    suffix = uuid.uuid4().hex[:6]
    user_a = "admin_" + suffix
    user_b = "guest_" + suffix
    pw = "test123456"

    print("=== 0. service and scan ===", flush=True)
    me = session().get(BASE + "/api/me", timeout=10).json()
    check("empty user when not logged in", me.get("user") is None, me)
    check("protected api needs login",
          session().get(BASE + "/api/index/status", timeout=10).status_code == 401)

    print("\n=== 1. register / login ===", flush=True)
    sa = session()
    existing = db_rows("SELECT COUNT(*) AS c FROM users")[0]["c"]
    r = sa.post(BASE + "/api/register", json=register_body(user_a, pw), timeout=30)
    check("admin registered", r.status_code == 200 and r.json().get("ok"), r.text[:200])
    admin = r.json().get("user") or {}
    check("first account of an empty library is admin",
          existing > 0 or admin.get("is_admin") is True, {"existing": existing, "user": admin})
    if not admin.get("is_admin"):
        # 这台机器上已经有别人的账号了，把测试账号提权，好把管理端跑完。
        db_exec("UPDATE users SET is_admin=1 WHERE username=?", (user_a,))
        admin = dict(admin, is_admin=True)
        check("test admin promoted for this run",
              db_rows("SELECT is_admin FROM users WHERE username=?", (user_a,))[0]["is_admin"] == 1)
    total = wait_scan(sa)
    check("materials scanned", total > 1000, "total=" + str(total))

    sb = session()
    r = sb.post(BASE + "/api/register", json=register_body(user_b, pw), timeout=30)
    check("second account registered", r.status_code == 200 and r.json().get("ok"), r.text[:200])
    guest = r.json().get("user") or {}
    check("second account is not admin", guest.get("is_admin") is False, guest)

    r = session().post(BASE + "/api/login", json={"username": user_a, "password": "wrongpass"}, timeout=20)
    check("wrong password rejected", r.status_code == 400, r.status_code)

    print("\n=== 2. privacy: others cannot see my files ===", flush=True)
    ov_a = sa.get(BASE + "/api/overview", timeout=30).json()
    check("admin sees materials", ov_a["totals"]["files"] > 1000, ov_a["totals"])
    check("admin sees many subjects", len(ov_a["subjects"]) >= 10, len(ov_a["subjects"]))
    lib = sa.get(BASE + "/api/materials?limit=1", timeout=30).json()["items"][0]
    check("admin can open detail", sa.get(BASE + "/api/material/" + str(lib["id"]), timeout=20).status_code == 200)
    check("materials are private by default", lib["shared"] is False, lib["shared"])
    check("material marked as mine", lib["mine"] is True, lib["mine"])

    ov_b = sb.get(BASE + "/api/overview", timeout=20).json()
    check("guest sees zero materials", ov_b["totals"]["files"] == 0, ov_b["totals"])
    check("guest sees zero subjects", len(ov_b["subjects"]) == 0, ov_b["subjects"])
    check("guest blocked from detail",
          sb.get(BASE + "/api/material/" + str(lib["id"]), timeout=20).status_code == 404)
    check("guest blocked from file download",
          sb.get(BASE + "/api/file/" + str(lib["id"]), timeout=20).status_code == 404)
    check("guest blocked from thumbnail",
          sb.get(BASE + "/api/thumb/" + str(lib["id"]), timeout=20).status_code == 404)
    check("guest search returns nothing",
          len(sb.get(BASE + "/api/search?q=" + "概率", timeout=20).json()["hits"]) == 0)
    check("guest cannot generate summary",
          sb.post(BASE + "/api/material/" + str(lib["id"]) + "/summary", json={}, timeout=20).status_code == 404)
    check("guest cannot toggle visibility",
          sb.post(BASE + "/api/material/" + str(lib["id"]) + "/visibility",
                  json={"shared": True}, timeout=20).status_code == 403)

    # 站长可能自己在管理端开着"共用 AI"，这里先借用（关掉）再测门禁，测完原样还回去。
    shared_before = config.allow_shared_ai()
    if shared_before:
        config.save_allow_shared_ai(False)
    try:
        check("guest without a key is refused by AI",
              sb.post(BASE + "/api/ask", json={"question": "随便问问"}, timeout=20).status_code == 403)
        r = sb.post(BASE + "/api/me/ai",
                    json={"base_url": "http://127.0.0.1:9/v1", "api_key": "sk-own-test",
                          "model_text": "own-model", "model_vision": "own-model"}, timeout=20)
        check("guest can store his own ai key", r.status_code == 200 and r.json().get("ok"), r.text[:140])
        check("a stored own key counts as allowed (server proxy)",
              sb.post(BASE + "/api/ask", json={"question": "随便问问"}, timeout=30).status_code == 200)
        sb.post(BASE + "/api/me/ai/clear", json={}, timeout=20)
        check("clearing the own key closes the gate again",
              sb.post(BASE + "/api/ask", json={"question": "随便问问"}, timeout=20).status_code == 403)
    finally:
        if shared_before:
            config.save_allow_shared_ai(True)
        check("borrowed shared-ai switch is put back", config.allow_shared_ai() is shared_before,
              config.allow_shared_ai())
    check("guest cannot read the site ai config",
          sb.get(BASE + "/api/settings/ai", timeout=20).status_code == 403)

    print("\n=== 3. explicit sharing ===", flush=True)
    r = sa.post(BASE + "/api/material/" + str(lib["id"]) + "/visibility", json={"shared": True}, timeout=20)
    check("owner can share", r.status_code == 200 and r.json().get("shared") is True, r.text[:120])
    check("guest now sees exactly that one",
          sb.get(BASE + "/api/overview", timeout=20).json()["totals"]["files"] == 1)
    sa.post(BASE + "/api/material/" + str(lib["id"]) + "/visibility", json={"shared": False}, timeout=20)
    check("back to private hides it again",
          sb.get(BASE + "/api/overview", timeout=20).json()["totals"]["files"] == 0)

    print("\n=== 4. upload: only the admin writes to this computer ===", flush=True)
    content = "测试资料：古典概型的概率公式是 P(A)=A包含的基本事件数/总的基本事件数。"
    before = uploads_snapshot()
    r = sb.post(BASE + "/api/upload", data={"subject": "数学"},
                files={"files": ("测试资料" + suffix + ".txt", content.encode("utf-8"), "text/plain")},
                timeout=60)
    check("non-admin upload is refused by the server", r.status_code == 403, r.text[:160])
    check("refused upload wrote nothing to this computer",
          uploads_snapshot() == before, uploads_snapshot()[:3])
    before = uploads_snapshot()
    r = sa.post(BASE + "/api/upload", data={"subject": "数学"},
                files={"files": ("测试资料" + suffix + ".txt", content.encode("utf-8"), "text/plain")},
                timeout=60)
    check("admin upload ok", r.status_code == 200 and r.json().get("ok"), r.text[:200])
    up_id = (r.json().get("saved") or [{}])[0].get("id")
    check("upload returns material id", bool(up_id), up_id)
    check("admin upload really landed on this computer",
          len(uploads_snapshot()) == len(before) + 1, uploads_snapshot()[-2:])
    check("uploader sees own upload",
          sa.get(BASE + "/api/overview", timeout=20).json()["totals"]["files"] > 1000)
    r = sa.post(BASE + "/api/upload", data={"subject": "数学"},
                files={"files": ("测试资料" + suffix + ".txt", b"second", "text/plain")}, timeout=60)
    saved_name = (r.json().get("saved") or [{}])[0].get("name")
    check("duplicate name auto-renamed", saved_name != ("测试资料" + suffix + ".txt"), saved_name)

    print("\n=== 5. search ===", flush=True)

    def wait_indexed(client, material_id, timeout=240):
        end = time.time() + timeout
        while time.time() < end:
            detail = client.get(BASE + "/api/material/" + str(material_id), timeout=30).json()
            if detail.get("texts"):
                return True
            time.sleep(3)
        return False

    check("uploaded file got indexed", wait_indexed(sa, up_id))

    deadline = time.time() + 90
    hits = []
    while time.time() < deadline:
        hits = sa.get(BASE + "/api/search?q=" + "古典概型", timeout=30).json()["hits"]
        if hits:
            break
        time.sleep(2)
    check("chinese keyword search works", len(hits) > 0, "hits=" + str(len(hits)))
    check("snippet contains highlight markers", any("[[" in h["snippet"] for h in hits))
    check("uploader can search own upload",
          any(h["material_id"] == up_id for h in hits), len(hits))
    check("non-admin cannot see the admin's upload",
          all(h["material_id"] != up_id
              for h in sb.get(BASE + "/api/search?q=" + "古典概型", timeout=30).json()["hits"]))
    check("short query falls back to LIKE",
          len(sa.get(BASE + "/api/search?q=" + "概型", timeout=30).json()["hits"]) > 0)
    check("a whole question still finds the material",
          any(h["material_id"] == up_id
              for h in sa.get(BASE + "/api/search?q=" + "古典概型是什么？", timeout=30).json()["hits"]))

    print("\n=== 6. AI ===", flush=True)
    target = None
    for item in sa.get(BASE + "/api/materials?limit=300", timeout=30).json()["items"]:
        if item["has_text"] and item["kind"] in ("pdf", "word", "ppt", "excel", "text"):
            target = item
            break
    check("found an indexed text material", target is not None, target["name"] if target else "")
    if target:
        r = sa.post(BASE + "/api/material/" + str(target["id"]) + "/summary", json={}, timeout=300)
        check("AI summary works", r.status_code == 200 and bool(r.json().get("summary")),
              (r.json().get("summary") or r.text)[:150])
        r = sa.post(BASE + "/api/material/" + str(target["id"]) + "/quiz", json={}, timeout=300)
        quiz = r.json().get("quiz") if r.status_code == 200 else None
        check("AI quiz works", bool(quiz), ((quiz or [{}])[0].get("stem") or r.text)[:80])
        r = sa.post(BASE + "/api/ask", json={"question": "这份资料主要讲了什么？"}, timeout=300)
        check("AI ask works", r.status_code == 200 and bool(r.json().get("answer")),
              (r.json().get("answer") or r.text)[:150])

    print("\n=== 7. vision ===", flush=True)
    img = None
    for item in sa.get(BASE + "/api/materials?kind=image&limit=50", timeout=30).json()["items"]:
        img = item
        break
    check("found an image", img is not None, img["name"] if img else "")
    if img:
        sa.post(BASE + "/api/material/" + str(img["id"]) + "/index", json={"mode": "vision"}, timeout=30)
        deadline = time.time() + 240
        got = False
        while time.time() < deadline:
            if sa.get(BASE + "/api/material/" + str(img["id"]), timeout=30).json().get("texts"):
                got = True
                break
            time.sleep(4)
        check("image text recognised by AI", got)

    print("\n=== 8. export ===", flush=True)
    ids = [i["id"] for i in sa.get(BASE + "/api/materials?limit=3", timeout=30).json()["items"]]
    r = sa.post(BASE + "/api/export", json={"ids": ids, "title": "测试资料包", "mode": "single"}, timeout=300)
    check("single-file export ok", r.status_code == 200 and r.json().get("ok"), r.text[:160])
    if r.status_code == 200 and r.json().get("ok"):
        exp = r.json()
        dl = sa.get(BASE + "/api/export/" + str(exp["id"]) + "/download", timeout=60)
        check("single html downloadable", dl.status_code == 200 and dl.content[:15] == b"<!DOCTYPE html>",
              len(dl.content))
    r = sa.post(BASE + "/api/export", json={"ids": ids, "title": "测试打包", "mode": "bundle"}, timeout=900)
    ok = r.status_code == 200 and r.json().get("ok")
    check("bundle export ok", ok, r.text[:160])
    if ok:
        exp2 = r.json()
        dl = sa.get(BASE + "/api/export/" + str(exp2["id"]) + "/download", timeout=300)
        check("bundle downloadable and is zip",
              dl.status_code == 200 and dl.content[:2] == b"PK", len(dl.content))

    print("\n=== 9. per-user isolation ===", flush=True)
    sa.post(BASE + "/api/favorite/" + str(ids[0]), json={}, timeout=20)
    sa.post(BASE + "/api/notes/" + str(ids[0]), json={"content": "管理员的笔记"}, timeout=20)
    check("non-admin cannot write a note on the admin's material",
          sb.post(BASE + "/api/notes/" + str(ids[0]), json={"content": "游客的笔记"},
                  timeout=20).status_code == 404)
    da = sa.get(BASE + "/api/me/dashboard", timeout=30).json()
    dg = sb.get(BASE + "/api/me/dashboard", timeout=30).json()
    check("admin sees own favorite", len(da["favorites"]) == 1, len(da["favorites"]))
    check("admin note content correct", (da["notes"] or [{}])[0].get("content") == "管理员的笔记", da["notes"])
    check("guest sees no admin favorites", len(dg["favorites"]) == 0, len(dg["favorites"]))
    check("guest dashboard stays empty", len(dg["notes"]) == 0, dg["notes"])

    print("\n=== 10. read-only self test ===", flush=True)
    st = sa.get(BASE + "/api/selftest", timeout=900).json()
    src = st["source"]
    check("source fingerprint unchanged", src["unchanged"] is True,
          str(src["files"]) + " files, sha256=" + src["sha256"][:16])
    check("AI channel alive", st["ai"]["ok"] is True, st["ai"]["message"][:80])

    print("\n=== 11. collection and printable summary ===", flush=True)
    check("non-admin cannot collect into this computer",
          sb.post(BASE + "/api/collect/note",
                  json={"title": "越权", "subject": "未分类", "content": "越权"}, timeout=20).status_code == 403)
    r = sa.post(BASE + "/api/collect/note",
                json={"title": "我整理的概率小结", "subject": "我的笔记",
                      "content": "古典概型：样本空间有限且每个基本事件等可能。几何概型：与区域长度面积体积成比例。"},
                timeout=60)
    note_id = r.json().get("material_id") if r.status_code == 200 else None
    check("save pasted note", r.status_code == 200 and bool(note_id), r.text[:140])
    if note_id:
        check("collected note got indexed", wait_indexed(sa, note_id))
        found = sa.get(BASE + "/api/search?q=" + "样本空间有限", timeout=30).json()["hits"]
        check("collected note is searchable", any(h["material_id"] == note_id for h in found), len(found))
        check("non-admin cannot see it",
              all(h["material_id"] != note_id
                  for h in sb.get(BASE + "/api/search?q=" + "样本空间有限", timeout=30).json()["hits"]))

    fetch_ok = False
    fetch_detail = ""
    for candidate in ["https://www.runoob.com/", "https://www.cnblogs.com/", "https://www.example.com/"]:
        resp = sa.get(BASE + "/api/collect/preview?url=" + candidate, timeout=60)
        if resp.status_code == 200 and resp.json().get("ok"):
            fetch_ok = True
            fetch_detail = candidate + " -> " + str(resp.json().get("chars")) + " chars"
            break
        fetch_detail = candidate + " -> " + str(resp.json().get("error"))[:60]
    check("web page can be fetched", fetch_ok, fetch_detail)

    if fetch_ok:
        r = sa.post(BASE + "/api/collect/url",
                    json={"url": "https://www.runoob.com/", "subject": "网络收集",
                          "summarize": False, "quiz": False}, timeout=180)
        check("save collected web page", r.status_code == 200 and bool(r.json().get("material_id")),
              r.text[:160])

    r = sa.post(BASE + "/api/collect/topic",
                json={"topic": "古典概型", "subject": "网络收集", "limit": 3, "quiz": False},
                timeout=600)
    ok = r.status_code == 200 and bool(r.json().get("material_id"))
    check("collect knowledge by topic", ok, r.text[:200])
    if ok:
        topic_id = r.json()["material_id"]
        check("topic collection reports sources", len(r.json().get("sources") or []) > 0,
              "sources=" + str(len(r.json().get("sources") or []))
              + " full=" + str(r.json().get("full_count")))
        check("non-admin cannot see the collected topic",
              sb.get(BASE + "/api/material/" + str(topic_id), timeout=20).status_code == 404)

    r = sa.post(BASE + "/api/notes-export",
                json={"ids": [note_id or up_id], "title": "我的总结", "include_quiz": True,
                      "include_text": False}, timeout=180)
    check("printable summary export ok", r.status_code == 200 and r.json().get("ok"), r.text[:160])
    if r.status_code == 200 and r.json().get("ok"):
        dl = sa.get(BASE + "/api/export/" + str(r.json()["id"]) + "/download", timeout=60)
        body = dl.content.decode("utf-8", "ignore")
        check("printable summary downloads as html", dl.status_code == 200 and "<html" in body, len(dl.content))
        check("printable summary has print button", "打印" in body)

    r = sa.post(BASE + "/api/export",
                json={"ids": [note_id or up_id], "title": "带总结的资料包", "mode": "single"}, timeout=180)
    check("single export still works after changes", r.status_code == 200 and r.json().get("ok"), r.text[:140])

    print("\n=== 12. local html / model animation files ===", flush=True)
    web_items = sa.get(BASE + "/api/materials?kind=web&limit=50", timeout=30).json()["items"]
    check("html files are classified as web kind", len(web_items) >= 1,
          "count=" + str(len(web_items)))
    if web_items:
        wid = web_items[0]["id"]
        pg = sa.get(BASE + "/api/material/" + str(wid) + "/page", timeout=30)
        body = pg.content.decode("utf-8", "ignore")
        check("web page is served as html",
              pg.status_code == 200 and "text/html" in pg.headers.get("Content-Type", ""),
              str(pg.status_code) + " " + pg.headers.get("Content-Type", ""))
        check("relative assets resolve through a base tag",
              '<base href="/api/material/' + str(wid) + '/page/">' in body)
        check("web page keeps its own animation code",
              "<canvas" in body.lower() or "<script" in body.lower(),
              str(len(body)) + " bytes")
        check("path traversal outside the material folder is blocked",
              sa.get(BASE + "/api/material/" + str(wid) + "/page/%2e%2e%2f%2e%2e%2f%2e%2e%2fWindows%2fwin.ini",
                     timeout=30).status_code in (400, 404))
        check("admin library page is private to others",
              sb.get(BASE + "/api/material/" + str(wid) + "/page", timeout=20).status_code == 404)
        check("web material needs no indexing",
              web_items[0]["has_text"] is False)
    pdf_items = sa.get(BASE + "/api/materials?kind=pdf&limit=1", timeout=30).json()["items"]
    if pdf_items:
        check("non-web material has no in-site page view",
              sa.get(BASE + "/api/material/" + str(pdf_items[0]["id"]) + "/page",
                     timeout=20).status_code == 404)

    print("\n=== 13. admin console / ai settings / share site ===", flush=True)
    check("guest cannot read settings",
          sb.get(BASE + "/api/settings", timeout=20).status_code == 403)
    check("guest cannot list accounts",
          sb.get(BASE + "/api/admin/users", timeout=20).status_code == 403)
    check("guest cannot read the audit log",
          sb.get(BASE + "/api/admin/audit", timeout=20).status_code == 403)
    check("guest cannot read the violation list",
          sb.get(BASE + "/api/admin/violations", timeout=20).status_code == 403)
    check("guest cannot share someone else's material as a site",
          sb.post(BASE + "/api/share/site", json={"ids": [lib["id"]], "title": "x"},
                  timeout=60).status_code == 403)

    page = sa.get(BASE + "/admin", timeout=20)
    check("admin console is served as its own page",
          page.status_code == 200 and "管理端" in page.content.decode("utf-8", "ignore"),
          page.status_code)
    check("guest is bounced away from /admin",
          sb.get(BASE + "/admin", allow_redirects=False, timeout=20).status_code in (301, 302, 303, 307, 308))

    users = sa.get(BASE + "/api/admin/users", timeout=30).json()
    check("admin sees the account list", users["ok"] and len(users["items"]) >= 2,
          len(users.get("items", [])))
    check("account list carries activity counters",
          all("uploads" in u and "flags" in u and "forbidden" in u for u in users["items"]))
    check("account list carries the violation summary", isinstance(users.get("violations"), list))
    check("the account list is paged and reports the grand total",
          users.get("page") == 1 and users.get("pages", 0) >= 1
          and users.get("totals", {}).get("users", 0) >= 2, users.get("totals"))
    # 列表现在分页了：要找自己的账号用搜索，不能指望它在第一页。
    mine_row = sa.get(BASE + "/api/admin/users?q=" + user_a, timeout=20).json()["items"][0]
    guest_row = sa.get(BASE + "/api/admin/users?q=" + user_b, timeout=20).json()["items"][0]
    check("test admin is marked as administrator", mine_row["is_admin"] is True)
    check("guest is a plain active user",
          guest_row["is_admin"] is False and guest_row["disabled"] is False)

    r = sa.post(BASE + "/api/admin/users/" + str(guest_row["id"]) + "/disable",
                json={"disabled": True}, timeout=20)
    check("admin can disable an account", r.status_code == 200 and r.json().get("disabled") is True)
    check("disabled account is kicked out of the api",
          sb.get(BASE + "/api/overview", timeout=20).status_code == 401)
    r = session().post(BASE + "/api/login", json={"username": user_b, "password": pw}, timeout=20)
    check("disabled account cannot log back in",
          r.status_code == 400 and "停用" in r.text, r.status_code)
    sa.post(BASE + "/api/admin/users/" + str(guest_row["id"]) + "/disable",
            json={"disabled": False}, timeout=20)
    check("admin can re-enable an account",
          sb.post(BASE + "/api/login", json={"username": user_b, "password": pw},
                  timeout=20).status_code == 200)
    check("admin cannot disable himself",
          sa.post(BASE + "/api/admin/users/" + str(mine_row["id"]) + "/disable",
                  json={"disabled": True}, timeout=20).status_code == 400)

    check("admin can reset a password",
          sa.post(BASE + "/api/admin/users/" + str(guest_row["id"]) + "/password",
                  json={"password": "newpass123"}, timeout=20).status_code == 200)
    check("the new password works",
          session().post(BASE + "/api/login", json={"username": user_b, "password": "newpass123"},
                         timeout=20).status_code == 200)
    check("too-short password is refused",
          sa.post(BASE + "/api/admin/users/" + str(guest_row["id"]) + "/password",
                  json={"password": "123"}, timeout=20).status_code == 400)

    vio = sa.get(BASE + "/api/admin/violations", timeout=30).json()
    check("violation endpoint returns a list", vio["ok"] and isinstance(vio["items"], list),
          len(vio.get("items", [])))
    audit = sa.get(BASE + "/api/admin/audit?limit=80", timeout=30).json()
    check("audit log records what happened", audit["ok"] and len(audit["items"]) >= 5,
          len(audit.get("items", [])))
    check("audit rows carry a human label",
          all(i.get("action_label") for i in audit["items"]))
    seen_actions = {i["action"] for i in audit["items"]}
    check("audit log has login or upload entries",
          bool(seen_actions & {"login", "upload", "register"}), sorted(seen_actions))
    only_guest = sa.get(BASE + "/api/admin/audit?user_id=" + str(guest_row["id"]) + "&limit=20",
                        timeout=20).json()["items"]
    check("audit log can be filtered by account",
          all(i["user_id"] == guest_row["id"] for i in only_guest), len(only_guest))
    forbidden = sa.get(BASE + "/api/admin/audit?action=forbidden&limit=20", timeout=20).json()["items"]
    check("peeking at a private file is recorded as a violation",
          len(forbidden) >= 1, "forbidden=" + str(len(forbidden)))

    cfg = sa.get(BASE + "/api/settings", timeout=30).json()
    check("settings expose the provider presets", cfg["ok"] and len(cfg["ai"]["presets"]) >= 3)
    check("settings never hand out the stored key", "api_key" not in cfg["ai"], sorted(cfg["ai"]))
    check("storage settings report free disk space", cfg["storage"]["free"] > 0,
          cfg["storage"].get("free_label"))
    check("a bad ai address is refused",
          sa.post(BASE + "/api/settings/ai", json={"base_url": "ftp://nope"},
                  timeout=20).status_code == 400)
    keep_url = cfg["ai"]["base_url"]
    keep_text = cfg["ai"]["model_text"]
    keep_vision = cfg["ai"]["model_vision"]
    # 原样存回去：这里只验证“能存、能保持”，绝不改动这台电脑上正在用的模型。
    r = sa.post(BASE + "/api/settings/ai",
                json={"base_url": keep_url, "model_text": keep_text,
                      "model_vision": keep_vision}, timeout=20)
    check("ai settings can be saved", r.status_code == 200 and r.json().get("ok"), r.text[:140])
    after = sa.get(BASE + "/api/settings", timeout=20).json()
    check("ai settings are kept after saving",
          after["ai"]["base_url"] == keep_url and after["ai"]["model_text"] == keep_text
          and after["ai"]["model_vision"] == keep_vision, after["ai"])
    r = sa.get(BASE + "/api/settings/ai", timeout=20)
    check("admin can read the ai config but never the key",
          r.status_code == 200 and "api_key" not in r.json().get("ai", {})
          and r.json()["ai"]["base_url"] == keep_url, r.text[:160])
    # has_key 只表示「有没有存密钥」，不能假设它一定是 True：
    # 默认的「本机代理」就是免密钥的，这时它本来就该是 False。
    # 所以拿真实配置对一下，而不是把环境当成固定条件。
    stored_key = bool(str(config.ai_settings().get("api_key") or "").strip())
    check("admin ai config reports whether a key is stored",
          r.json()["ai"]["has_key"] is stored_key, r.json()["ai"])
    check("a relative storage folder is refused",
          sa.post(BASE + "/api/settings/storage", json={"dir": "这不是一个绝对路径"},
                  timeout=20).status_code == 400)

    r = sa.post(BASE + "/api/share/site", json={"ids": [], "title": "离线学习站"}, timeout=180)
    check("share site works with no materials picked",
          r.status_code == 200 and r.json().get("ok"), r.text[:160])
    if r.status_code == 200 and r.json().get("ok"):
        body = sa.get(BASE + "/api/export/" + str(r.json()["id"]) + "/download",
                      timeout=60).content.decode("utf-8", "ignore")
        check("share site downloads as one html file", body.startswith("<!DOCTYPE html>"))
        check("share site brings the model animations along", "动量守恒" in body, len(body))
        check("share site has no login form", "退出登录" not in body)
        check("share site does not leak the sharer's name", user_a not in body)
        check("share site says it holds no personal data", "个人数据" in body)
    r = sa.post(BASE + "/api/share/site", json={"ids": [lib["id"]], "title": "带一份资料的分享页"},
                timeout=180)
    check("share site can carry picked materials",
          r.status_code == 200 and r.json().get("count") == 1, r.text[:160])
    if r.status_code == 200 and r.json().get("ok"):
        body = sa.get(BASE + "/api/export/" + str(r.json()["id"]) + "/download",
                      timeout=60).content.decode("utf-8", "ignore")
        check("the shared material really is inside", lib["name"][:10] in body, lib["name"])

    custom = sa.get(BASE + "/api/models/custom", timeout=30).json()
    check("custom model list answers", custom["ok"] and isinstance(custom["items"], list))
    check("generating a model without a name is refused",
          sa.post(BASE + "/api/models/generate", json={"category": "测试", "title": ""},
                  timeout=30).status_code == 400)
    check("deleting someone else's model is refused",
          sa.post(BASE + "/api/models/custom/999999/delete", json={}, timeout=20).status_code == 404)

    sr = sa.get(BASE + "/api/search?q=" + "概率", timeout=60).json()
    hit_ids = [h["material_id"] for h in sr["hits"]]
    check("search results never repeat the same material",
          len(hit_ids) == len(set(hit_ids)), hit_ids[:12])
    check("each search hit reports its own match count",
          all(h.get("matches", 0) >= 1 for h in sr["hits"]))

    print("\n=== 14. invite code / ai gate / public single-file build ===", flush=True)
    info = session().get(BASE + "/api/register/info", timeout=20).json()
    check("registration asks for an invite code", info.get("need_invite") is True, info)
    r = session().post(BASE + "/api/register",
                       json={"username": "guest_noinvite_" + suffix, "password": pw}, timeout=20)
    check("register without an invite code is refused",
          r.status_code == 400 and r.json().get("need_invite") is True, r.text[:140])
    r = session().post(BASE + "/api/register",
                       json={"username": "guest_badcode_" + suffix, "password": pw,
                             "invite": "WRONGCODE"}, timeout=20)
    check("wrong invite code is refused", r.status_code == 400, r.text[:140])
    fails = db_rows("SELECT COUNT(*) AS c FROM audit_log WHERE action='register_fail'")[0]["c"]
    check("refused registrations are logged", fails >= 2, fails)
    sc = session()
    r = sc.post(BASE + "/api/register",
                json={"username": "guest_invited_" + suffix, "password": pw, "invite": invite()}, timeout=30)
    check("register with the right invite code works", r.status_code == 200 and r.json().get("ok"),
          r.text[:140])
    check("guest cannot change the registration mode",
          sb.post(BASE + "/api/settings/registration", json={"mode": "open"}, timeout=20).status_code == 403)
    check("guest cannot flip the shared-ai switch",
          sb.post(BASE + "/api/settings/shared-ai", json={"allow": True}, timeout=20).status_code == 403)
    check("guest cannot see progress of the admin's library",
          sb.get(BASE + "/api/index/status", timeout=20).status_code == 403)
    check("guest cannot run the source self test",
          sb.get(BASE + "/api/selftest", timeout=20).status_code == 403)
    check("home overview hides the library path and size from a guest",
          sb.get(BASE + "/api/overview", timeout=20).json()["source"]["root"] == ""
          and sb.get(BASE + "/api/overview", timeout=20).json()["index"]["total"] == 0)
    lib = sa.get(BASE + "/api/materials?limit=1", timeout=30).json()["items"][0]
    check("guest cannot spend the admin's ai credit",
          sb.post(BASE + "/api/material/" + str(lib["id"]) + "/summary", json={},
                  timeout=20).status_code in (403, 404))
    wb = sa.get(BASE + "/api/webbuild/info", timeout=30).json()
    check("public build info answers", wb.get("ok") is True and "share_code" in wb, list(wb.keys()))
    check("guest cannot build the public page",
          sb.post(BASE + "/api/webbuild", json={}, timeout=30).status_code == 403)
    r = sa.post(BASE + "/api/webbuild", json={"title": "验收测试公网版"}, timeout=900)
    check("public single-file page is built",
          r.status_code == 200 and r.json().get("ok"), r.text[:200])
    if r.status_code == 200 and r.json().get("ok"):
        dl = sa.get(BASE + "/api/webbuild/download", timeout=300)
        body = dl.content.decode("utf-8", "ignore")
        check("built page downloads as one html file",
              dl.status_code == 200 and body.startswith("<!DOCTYPE html>"), len(body))
        check("built page carries no material from this library",
              lib["name"][:12] not in body, lib["name"][:12])
        # 不写死任何本机串：拿配置里的资料目录 + 「公网版禁用词」列表来判定
        leak_tokens = [str(config.SOURCE_ROOT)] + config.webbuild_forbidden()
        check("built page carries no account or path data",
              user_a not in body and "study.db" not in body
              and all(t not in body for t in leak_tokens), leak_tokens)

    print("\n=== 15. public build borrows the local server (bridge) ===", flush=True)
    check("guest cannot open the bridge",
          sb.post(BASE + "/api/settings/bridge", json={"enabled": True}, timeout=20).status_code == 403)
    br = sa.post(BASE + "/api/settings/bridge", json={"enabled": True}, timeout=20).json()
    check("admin can turn the bridge on and gets a connection code",
          br.get("ok") is True and len((br.get("bridge") or {}).get("token") or "") >= 8, br)
    btoken = (br.get("bridge") or {}).get("token") or ""
    check("bridge stays shut without the code",
          requests.get(BASE + "/api/bridge/ping", timeout=20).status_code == 403)
    check("bridge refuses a wrong code",
          requests.get(BASE + "/api/bridge/ping", headers={"X-Study-Key": "WRONGCODE99"},
                       timeout=20).status_code == 403)
    r = requests.get(BASE + "/api/bridge/ping", headers={"X-Study-Key": btoken}, timeout=20)
    check("bridge answers with the right code",
          r.status_code == 200 and r.json().get("ok"), r.text[:120])
    r = requests.get(BASE + "/api/bridge/ping",
                     headers={"X-Study-Key": btoken, "Origin": "null"}, timeout=20)
    check("bridge lets the single-file page call it across origins",
          r.headers.get("Access-Control-Allow-Origin") == "null",
          r.headers.get("Access-Control-Allow-Origin"))
    r = requests.options(BASE + "/api/bridge/search?q=x",
                         headers={"Origin": "null", "Access-Control-Request-Method": "GET",
                                  "Access-Control-Request-Headers": "x-study-key"}, timeout=20)
    check("bridge answers the browser preflight",
          r.status_code == 204 and "x-study-key" in r.headers.get("Access-Control-Allow-Headers", "").lower(),
          r.status_code)
    before_rows = db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"]
    before_up = uploads_snapshot()
    r = requests.get(BASE + "/api/bridge/page?url="
                     + quote("https://www.runoob.com/python/python-intro.html", safe=""),
                     headers={"X-Study-Key": btoken}, timeout=90)
    check("bridge fetches a real page for the visitor",
          r.status_code == 200 and len(r.json().get("text", "")) > 500, r.text[:160])
    check("bridge only fetches, it never stores anything here",
          db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"] == before_rows
          and uploads_snapshot() == before_up)
    hr = requests.get(BASE + "/api/bridge/search?q=" + quote("古典概型", safe=""),
                      headers={"X-Study-Key": btoken}, timeout=90)
    check("bridge can search the web for the visitor",
          hr.status_code == 200 and len(hr.json().get("hits", [])) >= 1, hr.text[:160])
    off = sa.post(BASE + "/api/settings/bridge", json={"enabled": False}, timeout=20).json()
    check("admin can turn the bridge back off",
          off.get("ok") is True and (off.get("bridge") or {}).get("enabled") is False, off)
    check("bridge is refused again after turning it off",
          requests.get(BASE + "/api/bridge/ping", headers={"X-Study-Key": btoken},
                       timeout=20).status_code == 403)

    print("\n=== 16. data backup (admin only) ===", flush=True)
    check("guest cannot read backup info",
          sb.get(BASE + "/api/admin/backup/info", timeout=20).status_code == 403)
    check("guest cannot download the database",
          sb.get(BASE + "/api/admin/backup/db", timeout=60).status_code == 403)
    check("guest cannot download the manifest",
          sb.get(BASE + "/api/admin/backup/manifest", timeout=20).status_code == 403)

    binfo = sa.get(BASE + "/api/admin/backup/info", timeout=30).json()["info"]
    live_materials = db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"]
    check("backup info reports the database and the library",
          binfo["db"]["bytes"] > 0 and binfo["db"]["materials"] == live_materials, binfo["db"])
    check("backup info lists the uploads folder",
          binfo["uploads"]["count"] >= 1 and binfo["uploads"]["dir"], binfo["uploads"]["dir"])
    check("backup info reports free disk space", binfo["disk_free"] > 0, binfo["disk_free_label"])

    r = sa.get(BASE + "/api/admin/backup/db", timeout=300)
    blob = r.content
    check("database snapshot downloads as one sqlite file",
          r.status_code == 200 and blob[:15] == b"SQLite format 3", len(blob))
    check("snapshot gets a dated file name",
          "study-" in str(r.headers.get("Content-Disposition", "")),
          r.headers.get("Content-Disposition"))
    snap = Path(os.environ.get("TEMP", ".")) / ("smoke_snapshot_" + suffix + ".db")
    snap.write_bytes(blob)
    try:
        conn = sqlite3.connect(str(snap))
        got = conn.execute("SELECT COUNT(*) FROM materials").fetchone()[0]
        got_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        conn.close()
    finally:
        snap.unlink()
    check("snapshot holds the same library as the live database", got == live_materials, (got, live_materials))
    check("snapshot carries the accounts too",
          got_users == db_rows("SELECT COUNT(*) AS c FROM users")[0]["c"], got_users)

    r = sa.get(BASE + "/api/admin/backup/manifest", timeout=60)
    man = r.json()
    check("manifest downloads as json with the same library",
          r.status_code == 200 and man.get("tables", {}).get("materials") == live_materials,
          man.get("generated_at"))
    check("manifest lists the uploads files",
          isinstance(man.get("uploads", {}).get("items"), list) and man["uploads"]["count"] >= 1,
          man["uploads"]["count"])
    # 站点自己配的密钥（可能为空，比如走免密钥本机代理时）不应该出现在清单里。
    admin_key = str(config.ai_settings().get("api_key") or "").strip()
    key_leaked = len(admin_key) >= 8 and admin_key[:8] in r.text
    check("manifest never carries a secret",
          "api_key" not in r.text and not key_leaked, sorted(man.keys()))
    kept = sorted((config.DATA_DIR / "backups").glob("study-*.db"))
    check("only the newest snapshot stays on disk", len(kept) <= 1, [p.name for p in kept])

    print("\n=== 17. auto scan (admin setting) ===", flush=True)
    before_scan = json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8")).get("scan") or {}
    check("guest cannot read the settings",
          sb.get(BASE + "/api/settings", timeout=20).status_code == 403)
    check("guest cannot change the auto scan switch",
          sb.post(BASE + "/api/settings/scan", json={"enabled": True}, timeout=20).status_code == 403)
    info = sa.get(BASE + "/api/settings", timeout=30).json()
    check("settings carry the auto scan switch",
          isinstance(info.get("scan"), dict) and "scan_last" in info, info.get("scan"))
    check("auto scan is off unless the admin turned it on",
          before_scan.get("enabled") in (None, False), before_scan)
    r = sa.post(BASE + "/api/settings/scan", json={"enabled": True, "minutes": 2}, timeout=30).json()
    check("an interval below the floor is raised to 5 minutes", r["scan"]["minutes"] == 5, r["scan"])
    r = sa.post(BASE + "/api/settings/scan", json={"enabled": True, "minutes": 99999}, timeout=30).json()
    check("an interval above the ceiling is capped at 1440 minutes", r["scan"]["minutes"] == 1440, r["scan"])
    r = sa.post(BASE + "/api/settings/scan", json={"minutes": "abc"}, timeout=30)
    check("a non-numeric interval is rejected", r.status_code == 400, r.text[:120])
    live = db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"]
    r = sa.post(BASE + "/api/settings/scan", json={"now": True}, timeout=600).json()
    check("scan now runs and reports the library", r.get("ok") and r.get("note"), r.get("note"))
    check("scan now reports the same library size as the database",
          ("资料共 " + str(live) + " 条") in str(r.get("note")), (r.get("note"), live))
    check("the last scan is remembered for the page",
          bool(r["last"]["at"]) and r["last"]["result"] == "ok", r.get("last"))
    sa.post(BASE + "/api/settings/scan",
            json={"enabled": bool(before_scan.get("enabled")),
                  "minutes": before_scan.get("minutes") or 30}, timeout=30)
    after = json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8")).get("scan") or {}
    check("the borrowed auto scan switch is put back",
          bool(after.get("enabled")) == bool(before_scan.get("enabled")), after)

    # 调度逻辑本身：把心跳和间隔调到毫秒级，看它是不是“到点才跑、反复地跑”。
    import threading as _threading
    from core import autoscan as _autoscan
    hits = []
    real_run, real_tick, real_conf = _autoscan.run_once, _autoscan.TICK, config.scan_settings

    def fake_run(trigger="自动"):
        hits.append(trigger)
        if len(hits) >= 5:
            raise SystemExit
        return {"ok": True, "text": "", "stats": {}}

    try:
        _autoscan.TICK = 0.05
        _autoscan.run_once = fake_run
        config.scan_settings = lambda: {"enabled": True, "minutes": 0.005, "dir": "",
                                        "min_minutes": 5, "max_minutes": 1440}
        _threading.Thread(target=_autoscan._loop, daemon=True).start()
        time.sleep(2.0)
    finally:
        _autoscan.TICK, _autoscan.run_once, config.scan_settings = real_tick, real_run, real_conf
    check("the scheduler fires again and again at the configured interval",
          len(hits) >= 3, len(hits))

    print("\n=== 18. remember me ===", flush=True)
    keeper = session()
    # 13 节把 guest 的密码重置成了 newpass123，这里要用新的。
    r = keeper.post(BASE + "/api/login",
                    json={"username": user_b, "password": "newpass123", "remember": True}, timeout=20)
    head = r.headers.get("Set-Cookie", "")
    check("remember me keeps you signed in after the browser closes",
          r.status_code == 200 and ("Expires=" in head or "Max-Age" in head), head[:80])
    skimmer = session()
    r = skimmer.post(BASE + "/api/login",
                     json={"username": user_b, "password": "newpass123", "remember": False}, timeout=20)
    head2 = r.headers.get("Set-Cookie", "")
    check("without remember me the cookie dies with the browser",
          r.status_code == 200 and ("Expires=" not in head2 and "Max-Age" not in head2), head2[:80])
    who = skimmer.get(BASE + "/api/me", timeout=20).json().get("user") or {}
    check("both logins still work", who.get("username") == user_b, who.get("username"))

    print("\n=== 19. extra read-only library folders ===", flush=True)
    import shutil as _shutil
    import tempfile as _tempfile
    tmp_root = Path(_tempfile.mkdtemp(prefix="study_srcroot_"))
    extra = tmp_root / "extra_library"
    (extra / "历史").mkdir(parents=True, exist_ok=True)
    marker = extra / "历史" / "笔记.txt"
    marker.write_text("卢沟桥事变发生在 1937 年 7 月 7 日。", encoding="utf-8")
    (extra / "历史" / "材料.md").write_text("# 历史补充材料\n这是额外的只读资料目录。", encoding="utf-8")
    mtime_before = marker.stat().st_mtime_ns
    saved_roots = json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8")).get("source_roots") or []
    count_before = db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"]
    try:
        check("guest cannot read the source folder settings",
              sb.get(BASE + "/api/settings", timeout=20).status_code == 403)
        check("guest cannot change the source folders",
              sb.post(BASE + "/api/settings/source-roots", json={"roots": []},
                      timeout=20).status_code == 403)
        info = sa.get(BASE + "/api/settings", timeout=30).json()
        roots = info.get("source_roots")
        check("settings list the default folder first",
              isinstance(roots, list) and roots and roots[0].get("id") == "" and roots[0].get("path"),
              str(roots)[:200])
        r = sa.post(BASE + "/api/settings/source-roots",
                    json={"roots": [{"name": "nope", "path": "relative" + chr(92) + "nope", "enabled": True}]},
                    timeout=30)
        check("a relative path is refused", r.status_code == 400, r.text[:160])
        r = sa.post(BASE + "/api/settings/source-roots",
                    json={"roots": [{"name": "drive", "path": "C:" + chr(92), "enabled": True}]}, timeout=30)
        check("a whole drive is refused", r.status_code == 400, r.text[:160])
        r = sa.post(BASE + "/api/settings/source-roots",
                    json={"roots": [{"name": "dup", "path": str(config.SOURCE_ROOT), "enabled": True}]},
                    timeout=30)
        check("adding the default folder again is refused", r.status_code == 400, r.text[:160])
        r = sa.post(BASE + "/api/settings/source-roots",
                    json={"roots": [{"name": "临时资料", "path": str(extra), "enabled": True}]}, timeout=60)
        data = r.json()
        check("a real extra folder is accepted", r.status_code == 200 and data.get("ok"), r.text[:200])
        rid = ""
        for node in (data.get("source_roots") or []):
            if node.get("id"):
                rid = node["id"]
        check("the extra folder gets its own id", bool(rid), rid)
        source_key = "lib:" + str(rid)

        def rows_of_extra():
            return db_rows("SELECT name, subject, source FROM materials WHERE source=?", (source_key,))

        deadline = time.time() + 90
        while time.time() < deadline and not rows_of_extra():
            time.sleep(1)
        found = rows_of_extra()
        check("files in the extra folder are indexed", len(found) == 2, found)
        check("the top-level folder becomes the subject",
              bool(found) and all(row["subject"] == "历史" for row in found), found)
        check("the library grew by the new files",
              db_rows("SELECT COUNT(*) AS c FROM materials")[0]["c"] >= count_before + 2)
        hits = []
        deadline = time.time() + 120
        while time.time() < deadline:
            hits = sa.get(BASE + "/api/search?q=" + quote("卢沟桥事变"), timeout=60).json().get("hits") or []
            if any(h.get("name") == "笔记.txt" for h in hits):
                break
            time.sleep(2)
        check("text in the extra folder is searchable",
              any(h.get("name") == "笔记.txt" for h in hits), str([h.get("name") for h in hits])[:200])
        extra_ids = db_rows("SELECT id FROM materials WHERE source=?", (source_key,))
        if extra_ids:
            guest_code = sb.get(BASE + "/api/material/" + str(extra_ids[0]["id"]), timeout=20).status_code
            check("a guest cannot open a file from the extra folder", guest_code == 404, guest_code)
        ov_a = sa.get(BASE + "/api/overview", timeout=30).json()
        check("an admin sees the extra folder in the source list",
              any(n.get("path") == str(extra) for n in (ov_a.get("source", {}).get("roots") or [])),
              ov_a.get("source"))
        ov_b = sb.get(BASE + "/api/overview", timeout=30).json()
        check("a guest still sees none of the private library",
              ov_b["totals"]["files"] == 0, ov_b["totals"])
        check("the extra folder was never written to",
              marker.stat().st_mtime_ns == mtime_before
              and marker.read_text(encoding="utf-8").startswith("卢沟桥事变"), marker.stat().st_mtime_ns)
        r = sa.post(BASE + "/api/settings/source-roots", json={"roots": []}, timeout=60).json()
        check("removing the folder clears its records",
              r.get("ok") and (r.get("removed") or 0) >= 2, r.get("removed"))
        check("no records are left behind",
              db_rows("SELECT COUNT(*) AS c FROM materials WHERE source=?", (source_key,))[0]["c"] == 0)
    finally:
        sa.post(BASE + "/api/settings/source-roots", json={"roots": saved_roots}, timeout=60)
        _shutil.rmtree(str(tmp_root), ignore_errors=True)

    print("\n=== 20. admin feedback reply ===", flush=True)
    web = config.WEB_DIR
    ui_js = (web / "ui.js").read_text(encoding="utf-8")
    check("in-page dialog helper exists",
          "window.UI" in ui_js and "prompt:" in ui_js and "confirm:" in ui_js
          and "ui-mask" in ui_js)
    for page in ("index.html", "admin.html"):
        html = (web / page).read_text(encoding="utf-8")
        check(page + " loads the dialog helper", "/static/ui.js" in html)
    for js in ("app.js", "admin.js"):
        src = (web / js).read_text(encoding="utf-8")
        check(js + " no longer uses native dialogs",
              "window.prompt(" not in src and "window.confirm(" not in src)
    hdr = sa.get(BASE + "/api/feedback", timeout=20).headers
    check("api responses are not cached by the browser",
          hdr.get("Cache-Control") == "no-store", hdr.get("Cache-Control"))
    r = sb.post(BASE + "/api/feedback",
                json={"kind": "suggestion", "content": "冒烟：求回复", "page": "#/me"}, timeout=20)
    fb = r.json()
    check("a user can submit feedback", r.status_code == 200 and fb.get("id"), r.text[:200])
    fb_id = fb.get("id")
    r = sb.post(BASE + "/api/feedback/" + str(fb_id) + "/status",
                json={"status": "done", "reply": "自己回复自己"}, timeout=20)
    check("a normal user cannot reply to feedback", r.status_code in (401, 403), r.status_code)
    r = sa.post(BASE + "/api/feedback/" + str(fb_id) + "/status",
                json={"status": "done", "reply": "冒烟：收到啦"}, timeout=20)
    check("an admin can reply to feedback", r.status_code == 200 and r.json().get("ok"), r.text[:200])
    rows = (sb.get(BASE + "/api/feedback", timeout=20).json().get("items") or [])
    row = [x for x in rows if x.get("id") == fb_id]
    check("the user sees the admin reply",
          bool(row) and row[0].get("reply") == "冒烟：收到啦" and row[0].get("status") == "done", row[:1])
    r = sa.post(BASE + "/api/feedback/" + str(fb_id) + "/delete", json={}, timeout=20)
    check("the test feedback is cleaned up", r.status_code == 200 and r.json().get("ok"), r.text[:200])

    print("\n=== 21. folder-mode content feeds search + ask ===", flush=True)
    folder_js = (web / "folder.js").read_text(encoding="utf-8")
    store_js = (web / "store.js").read_text(encoding="utf-8")
    app_js = (web / "app.js").read_text(encoding="utf-8")
    sw_js = (web / "sw.js").read_text(encoding="utf-8")
    check("folder index exposes its text to the searcher",
          "searchSources" in folder_js and "indexPending" in folder_js)
    wdt = folder_js.split("async function writeDocTexts")[1].split("async function saveDocRecord")[0]
    check("folder texts are removed by key instead of a full-table scan",
          "text_keys" in wdt and "idbAll" not in wdt)
    check("browser search merges folder + locally uploaded material",
          "folderSources" in store_js and "contexts: localContexts" in store_js)
    check("search page renders folder hits as openable local files", "data-fopen" in app_js)
    check("the admin search also merges browser-only material",
          "path.indexOf('/api/search') !== 0" in app_js)
    check("ask ships browser-only material as extra context",
          "askLocalExtra" in app_js and "body.extra" in app_js)
    check("service worker cache was bumped", "study-shell-v6" in sw_js)
    check("browser errors are turned into Chinese, cancel is not an error",
          "AbortError" in folder_js and "friendlyError" in folder_js and "folderToast" in app_js)
    from app import extra_contexts
    ex = extra_contexts([{"material_id": "f:物理/a.pdf", "title": "a.pdf", "subject": "物理", "text": "动量守恒"},
                         {"title": "", "text": "   "}, "坏数据", {"material_id": "f:x", "text": "第二条"}])
    check("extra contexts are normalised (junk dropped, source id kept)",
          [x["material_id"] for x in ex] == ["f:物理/a.pdf", "f:x"], ex)
    check("extra context text is capped",
          len(extra_contexts([{"title": "t", "text": "好" * 3000}])[0]["text"]) == 1500)
    check("extra context count is capped",
          len(extra_contexts([{"title": "t" + str(i), "text": "x"} for i in range(9)])) == 4)
    app_py = (config.BASE_DIR / "app.py").read_text(encoding="utf-8")
    check("folder pick asks for read only, write permission is requested lazily",
          "mode: 'read'" in folder_js and "ensureWritable" in folder_js)
    check("a picker that never opened says so instead of blaming the user",
          "noDialog" in folder_js and "没有打开“选文件夹”的窗口" in folder_js)
    check("folder pick failures are logged for later inspection",
          "/api/folder/diag" in folder_js and "/api/folder/diag" in app_py
          and "folder_diag.log" in app_py)
    check("an embedded browser that cannot open the picker is named as such",
          "embedderAbort" in folder_js and "Failed to execute 'showDirectoryPicker' on 'Window'" in folder_js)
    check("the diag says whether a real dialog ever took focus",
          "lostFocus" in folder_js and "lost_focus" in app_py)
    check("the reason a pick failed is shown on the page, not only in a toast",
          "foWhy" in app_js and "showFolderWhy" in app_js)
    check("a picker that never opened is not reported as a user cancel",
          "e.noDialog" in app_js and "!(e && e.noDialog)" in app_js)


    print("\n=== 22. v2 wrap-up: streaming ask, folder compat scan, admin bulk, PWA ===", flush=True)
    ai_src = (config.BASE_DIR / "core" / "ai.py").read_text(encoding="utf-8")
    admin_js = (web / "admin.js").read_text(encoding="utf-8")
    check("streaming ask is wired end to end",
          "ask_stream" in ai_src and "_post_stream" in ai_src and "_ask_prompt" in ai_src
          and "_stream_ask" in app_py and "text/event-stream" in app_py
          and 'body.get("stream")' in app_py)
    check("the ask page consumes the server-sent events",
          "getReader" in app_js and "type === 'answer'" in app_js and "askStream" in app_js
          and "canAskStream" in app_js)
    check("folder compat scan works without a directory handle",
          "compatScan" in folder_js and "compatPickFiles" in folder_js
          and "compat_snapshot" in folder_js and "compat_root" in folder_js
          and "sessionFile" in folder_js)
    check("a failed pick points the user at the compat scan instead of echoing english",
          "点「兼容扫描」就能用" in folder_js)
    check("the account list has paging, sorting and bulk actions",
          "data-bulk" in admin_js and "data-pick" in admin_js and "uPage" in admin_js
          and "uSort" in admin_js and "uStatus" in admin_js)
    check("forgot-password reset code is wired on both sides",
          "/api/auth/reset" in app_py and "/reset-code" in app_py
          and "/api/auth/reset" in app_js and "/reset-code" in admin_js
          and "password_resets" in (config.BASE_DIR / "core" / "db.py").read_text(encoding="utf-8"))
    check("quotas are stored per account",
          "quota_mb" in (config.BASE_DIR / "core" / "db.py").read_text(encoding="utf-8")
          and "quota_mb" in admin_js)
    check("the install prompt is captured for the PWA entry",
          "beforeinstallprompt" in app_js and "pwaGo" in app_js)
    check("the service worker ships an offline fallback page",
          "OFFLINE_HTML" in sw_js and "study-shell-v6" in sw_js)

    print("\n" + "=" * 60, flush=True)
    for name in FAIL:
        print("  FAILED: " + name, flush=True)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
