r"""管理端账号管理的隔离测试：分页/排序/筛选、批量操作、配额、一次性重置码。

在临时目录里跑一个独立的 Flask app 实例（自己的空库），不碰线上数据库、
不碰本机资料目录里的任何文件。
运行：.venv\Scripts\python.exe tests\admin_bulk.py
"""
from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from core import config

_TMP = Path(tempfile.mkdtemp(prefix="study_admin_test_"))
config.DATA_DIR = _TMP / "data"
config.UPLOAD_DIR = config.DATA_DIR / "uploads"
config.THUMB_DIR = config.DATA_DIR / "thumbs"
config.CACHE_DIR = config.DATA_DIR / "cache"
config.EXPORT_DIR = config.DATA_DIR / "exports"
config.DB_PATH = config.DATA_DIR / "study.db"
config.SECRET_PATH = config.DATA_DIR / "secret.key"
config.BASELINE_PATH = config.DATA_DIR / "baseline_source.txt"
config.SETTINGS_PATH = _TMP / "storage.json"

import app as appmod  # noqa: E402  （必须在改完 config 之后再导入）
from core import auth, db  # noqa: E402

PW = "test123456"
NEWPW = "newpass_1234"
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (("  -> " + str(detail)) if detail else ""))


def mkuser(name, is_admin=0, disabled=0):
    with db.tx() as tx:
        tx.execute(
            "INSERT INTO users(username, password_hash, is_admin, disabled, created_at)"
            " VALUES(?,?,?,?,?)",
            (name, auth.hash_password(PW), is_admin, disabled, auth.now_iso()),
        )
        return int(tx.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()["id"])


def users_of(client, **params):
    return client.get("/api/admin/users", query_string=params).get_json()


admin = appmod.app.test_client()
r = admin.post("/api/register", json={"username": "root_admin", "password": PW})
check("the first account is an admin", r.status_code == 200 and r.json["user"]["is_admin"] is True,
      r.status_code)
admin_id = r.json["user"]["id"]

u1 = mkuser("verify_u1")
u2 = mkuser("verify_u2")
u3 = mkuser("verify_u3")
mkuser("verify_dis", disabled=1)

# ---- 分页 / 排序 / 筛选 ----
d = users_of(admin, page=1, size=2)
check("paged response carries page/size/pages/matched/totals",
      all(k in d for k in ("page", "size", "pages", "matched", "items", "totals")), sorted(d.keys()))
check("size caps the rows on one page", len(d["items"]) == 2, len(d["items"]))
check("a second page returns different rows", len(users_of(admin, page=2, size=2)["items"]) == 2)
check("totals.users counts every account", d["totals"]["users"] == 5, d["totals"]["users"])
check("each row reports server storage and quota",
      "bytes" in d["items"][0] and "bytes_label" in d["items"][0] and "quota_mb" in d["items"][0])

names = [u["username"] for u in users_of(admin, size=50)["items"]]
check("sort desc by username puts the last name first",
      users_of(admin, size=1, sort="username", order="desc")["items"][0]["username"] == sorted(names)[-1],
      names)

f = users_of(admin, q="verify_u1", size=50)
check("search by username narrows to one row", f["matched"] == 1 and f["items"][0]["username"] == "verify_u1",
      f["matched"])
check("search with no match returns zero", users_of(admin, q="zzz_nobody", size=50)["matched"] == 0)
check("status=disabled shows only the stopped account",
      users_of(admin, status="disabled", size=50)["matched"] == 1)
check("status=admin shows only admins", users_of(admin, status="admin", size=50)["matched"] == 1)
check("page/size are clamped, not accepted blindly",
      users_of(admin, page=0, size=99999)["size"] == 200)

# ---- 批量操作 ----
r = admin.post("/api/admin/users/bulk", json={"action": "disable", "ids": [u1, u2]})
check("bulk disable hits exactly the selected accounts",
      r.status_code == 200 and r.get_json()["done"] == 2 and users_of(admin, status="disabled", size=50)["matched"] == 3,
      r.get_json())
r = admin.post("/api/admin/users/bulk", json={"action": "enable", "ids": [u1, u2]})
check("bulk enable undoes it", r.get_json()["done"] == 2 and users_of(admin, status="disabled", size=50)["matched"] == 1)
check("a bulk action never touches an unselected account",
      users_of(admin, q="verify_u3", size=5)["items"][0]["disabled"] is False)

check("the admin cannot bulk-act on themselves",
      admin.post("/api/admin/users/bulk", json={"action": "disable", "ids": [admin_id]}).status_code == 400)
check("an unknown bulk action is refused",
      admin.post("/api/admin/users/bulk", json={"action": "nuke", "ids": [u1]}).status_code == 400)
check("an empty selection is refused",
      admin.post("/api/admin/users/bulk", json={"action": "disable", "ids": []}).status_code == 400)

admin.post("/api/admin/users/bulk", json={"action": "quota", "ids": [u1], "quota_mb": 7})
check("quota is stored as megabytes",
      users_of(admin, q="verify_u1", size=5)["items"][0]["quota_mb"] == 7)
admin.post("/api/admin/users/bulk", json={"action": "quota", "ids": [u1, u2], "quota_mb": 0})
check("quota 0 means unlimited again",
      users_of(admin, q="verify_u1", size=5)["items"][0]["quota_mb"] == 0)
check("a non-integer quota is refused",
      admin.post("/api/admin/users/bulk", json={"action": "quota", "ids": [u1], "quota_mb": "abc"}).status_code == 400)

admin.post("/api/admin/users/bulk", json={"action": "set_admin", "ids": [u3]})
check("bulk set_admin promotes", users_of(admin, q="verify_u3", size=5)["items"][0]["is_admin"] == 1)
admin.post("/api/admin/users/bulk", json={"action": "unset_admin", "ids": [u3]})
check("bulk unset_admin demotes", users_of(admin, q="verify_u3", size=5)["items"][0]["is_admin"] == 0)

# ---- 至少要留一个能用的管理员 ----
admin2 = mkuser("verify_admin2", is_admin=1)
s2 = appmod.app.test_client()
check("the second admin can log in",
      s2.post("/api/login", json={"username": "verify_admin2", "password": PW}).status_code == 200)
admin.post("/api/admin/users/bulk", json={"action": "disable", "ids": [admin2]})
r = s2.post("/api/admin/users/bulk", json={"action": "unset_admin", "ids": [admin_id]})
check("the last usable admin cannot be demoted",
      r.status_code == 400 and "管理员" in r.get_json()["error"], r.get_json())
check("the still-working admin is untouched",
      users_of(admin, q="verify_admin2", size=5)["items"][0]["is_admin"] == 1)
admin.post("/api/admin/users/bulk", json={"action": "enable", "ids": [admin2]})

# ---- 一次性重置码 ----
r = admin.post("/api/admin/users/%d/reset-code" % u2, json={})
code = (r.get_json() or {}).get("code")
check("a reset code is issued and shown once",
      r.status_code == 200 and isinstance(code, str) and len(code) == 8
      and r.get_json()["minutes"] == 15, r.get_json())
check("the code is not readable from the account list",
      code not in str(users_of(admin, size=50)), "leak")

anon = appmod.app.test_client()
bad = anon.post("/api/auth/reset", json={"username": "verify_u2", "code": "ZZZZZZZZ", "password": NEWPW})
check("a wrong code is rejected", bad.status_code == 400, bad.get_json())
weak = anon.post("/api/auth/reset", json={"username": "verify_u2", "code": code, "password": "123"})
check("a too-short password is rejected", weak.status_code == 400, weak.get_json())
expired = admin.post("/api/admin/users/%d/reset-code" % u3, json={}).get_json()["code"]
with db.tx() as tx:
    tx.execute("UPDATE password_resets SET expires_at=? WHERE username=? AND used_at=''",
               ((datetime.now(timezone.utc).astimezone() - timedelta(minutes=1)).isoformat(timespec="seconds"),
                "verify_u3"))
late = anon.post("/api/auth/reset", json={"username": "verify_u3", "code": expired, "password": NEWPW})
check("an expired code is rejected", late.status_code == 400 and "过期" in late.get_json()["error"],
      late.get_json())
good = anon.post("/api/auth/reset", json={"username": "verify_u2", "code": code, "password": NEWPW})
check("a valid code sets the new password", good.status_code == 200, good.get_json())
check("the new password works",
      appmod.app.test_client().post("/api/login",
                                    json={"username": "verify_u2", "password": NEWPW}).status_code == 200)
check("the old password is dead",
      appmod.app.test_client().post("/api/login",
                                    json={"username": "verify_u2", "password": PW}).status_code in (400, 401))
again = anon.post("/api/auth/reset", json={"username": "verify_u2", "code": code, "password": "other_1234"})
check("the code cannot be used twice", again.status_code == 400, again.get_json())

# ---- 删除 ----
r = admin.post("/api/admin/users/bulk", json={"action": "delete", "ids": [u3]})
check("bulk delete removes the selected account",
      r.get_json()["done"] == 1 and users_of(admin, q="verify_u3", size=5)["matched"] == 0, r.get_json())

failed = [n for n, ok in results if not ok]
print("\npassed " + str(len(results) - len(failed)) + ", failed " + str(len(failed)))
for n in failed:
    print("  FAILED: " + n)
if failed:
    print("\n（未删除临时库，便于排查）" + str(_TMP))
    sys.exit(1)
try:
    import shutil as _shutil
    _shutil.rmtree(str(_TMP), ignore_errors=True)
except Exception:
    pass
