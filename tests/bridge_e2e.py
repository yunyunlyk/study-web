r"""公网单文件版「连接服务器」验收：在真浏览器里跨域跑一遍收集。

前置：服务已经开在 127.0.0.1:8787，并且这台机器能上网。
用法：.venv\Scripts\python.exe tests\bridge_e2e.py
"""
from __future__ import annotations

import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config, webbuild

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = "http://127.0.0.1:8787"
PAGE_PORT = 8897
RESULT_PORT = 8899
SKIP_EXIT = 77


def _find_chrome() -> str:
    """按顺序找可用的 Chrome / Edge（环境变量 STUDY_CHROME 优先）。

    找不到时以 77 退出，而不是 0 —— 退出码 0 会被当成"验收通过"。
    """
    candidates = [os.environ.get("STUDY_CHROME") or ""]
    candidates += [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return ""


CHROME = _find_chrome()
PROFILE = Path(os.environ.get("TEMP", ".")) / "chromeprof_study_bridge"
PAGE_NAME = "product.html"
DRIVER_NAME = "driver.html"

PASS = []
FAIL = []
result = {}
done = threading.Event()
CORS = [("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "*")]


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("[" + ("PASS" if ok else "FAIL") + "] " + name
          + (("  -> " + str(detail)) if detail else ""), flush=True)


class Collector(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS:
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace")
        if self.path.endswith("/done"):
            result["body"] = raw
            done.set()
        self.send_response(200)
        for k, v in CORS:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


DRIVER = '''<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<iframe id="f" src="/__PAGE__" style="width:1300px;height:1000px;border:0"></iframe>
<script>
var log = [];
function say(s) { log.push(String(s)); }
function report() {
  return fetch('http://127.0.0.1:__RP__/done', { method: 'POST', body: JSON.stringify({ lines: log }) });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var f = document.getElementById('f');
function D() { try { return f.contentDocument; } catch (e) { return null; } }
function W() { return f.contentWindow; }
function txt() { try { return D().body.innerText || ''; } catch (e) { return ''; } }
function waitFor(fn, ms) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function tick() { var v = false; try { v = fn(); } catch (e) { v = false; }
      if (v) { res(v); return; } if (Date.now() - t0 > ms) { rej(new Error('timeout')); return; } setTimeout(tick, 200); })();
  });
}
(async function () {
  try {
    var hdr = { 'X-Study-Key': '__BT__' };
    var ping = await fetch('http://127.0.0.1:8787/api/bridge/ping', { headers: hdr });
    say('BRIDGE_CORS_PING:' + (ping.ok ? 'ok' : 'bad'));
    var sr = await fetch('http://127.0.0.1:8787/api/bridge/search?q=' + encodeURIComponent('动量守恒'), { headers: hdr });
    var sj = await sr.json();
    say('BRIDGE_CORS_SEARCH:' + ((sj.hits || []).length ? 'ok' : 'bad'));

    await waitFor(function () { return D() && D().getElementById('gateCode'); }, 60000);
    D().getElementById('gateCode').value = '__SHARE__';
    D().getElementById('gateGo').click();
    await waitFor(function () { return D().getElementById('topbar') && txt().indexOf('资料库总览') >= 0; }, 60000);
    say('PRODUCT_GATE_OK:ok');

    W().location.hash = '#/collect';
    await waitFor(function () { return D().getElementById('colSrvUrl'); }, 40000);
    D().getElementById('colSrvUrl').value = 'http://127.0.0.1:8787';
    D().getElementById('colSrvKey').value = '__BT__';
    D().getElementById('colSrvSave').click();
    await waitFor(function () {
      var o = D().getElementById('colSrvOut');
      return o && o.textContent && o.textContent.indexOf('已连上服务器') >= 0;
    }, 60000);
    say('PRODUCT_CONNECT_OK:ok');

    D().getElementById('colNoteTitle').value = '公网版验收笔记';
    D().getElementById('colNoteBody').value = '这是公网版保存在自己浏览器里的笔记：动量守恒定律。';
    D().getElementById('colNoteBtn').click();
    await waitFor(function () {
      var o = D().getElementById('colOut');
      return o && o.innerText.indexOf('已保存') >= 0;
    }, 40000);
    say('PRODUCT_NOTE_SAVED:ok');

    var dbg = await new Promise(function (res) {
      var req = W().indexedDB.open('study_local');
      req.onsuccess = function () {
        var db = req.result;
        var all = db.transaction('docs', 'readonly').objectStore('docs').getAll();
        all.onsuccess = function () {
          res(all.result.map(function (d) {
            return d.name + ' ext=' + d.ext + ' kind=' + d.kind + ' has_text=' + d.has_text
              + ' state=' + d.text_state + ' pages=' + d.pages + ' note=' + (d.text_note || '');
          }).join(' || '));
        };
        all.onerror = function () { res('read-error'); };
      };
      req.onerror = function () { res('open-error'); };
    });
    say('docs in browser ' + String(dbg).replace(/:/g, ' ').slice(0, 400));
    say('PRODUCT_NOTE_INDEXED:' + (String(dbg).indexOf('has_text=true') >= 0 ? 'ok' : 'bad'));

    D().getElementById('colTopic').value = '古典概型';
    D().getElementById('colLimit').value = '3';
    D().getElementById('colTopicBtn').click();
    await waitFor(function () {
      var o = D().getElementById('colOut');
      return o && (o.innerText.indexOf('收集完成') >= 0 || o.innerText.indexOf('收集失败') >= 0);
    }, 300000);
    var out = D().getElementById('colOut').innerText;
    say('topic output ' + out.replace(/:/g, ' ').slice(0, 400));
    say('PRODUCT_TOPIC_SAVED:' + (out.indexOf('收集完成') >= 0 ? 'ok' : 'bad'));

    var oldDoc = D();
    W().location.reload();
    await sleep(5000);
    await waitFor(function () { return D() && D() !== oldDoc && D().readyState === 'complete'; }, 90000);
    await waitFor(function () {
      return (D().getElementById('gateCode') || D().getElementById('colSrvUrl')
              || D().getElementById('uName')) ? true : false;
    }, 90000);
    say('GATE_REMEMBERED:' + (D().getElementById('gateCode') ? 'bad' : 'ok'));
    if (D().getElementById('gateCode')) {
      D().getElementById('gateCode').value = '__SHARE__';
      D().getElementById('gateGo').click();
      await sleep(3000);
    }
    W().location.hash = '#/';
    await sleep(6000);
    say('home page says ' + txt().replace(/:/g, ' ').slice(0, 400));
    await waitFor(function () { return txt().indexOf('公网版验收笔记') >= 0; }, 90000);
    say('PRODUCT_RELOAD_KEEPS_DATA:ok');
    await report();
  } catch (err) {
    say('ERROR:' + (err && err.message));
    await report();
  }
})();
</script>
</body></html>
'''


def main() -> int:
    if not CHROME:
        print("找不到 Chrome / Edge —— 这次验收没有真正执行，退出码 77（不当作通过）。")
        print("装一个 Chrome 或 Edge，或者设环境变量 STUDY_CHROME 后重跑。")
        return SKIP_EXIT
    try:
        requests.get(BASE + "/api/register/info", timeout=10)
    except Exception:
        print("服务没在跑，先启动服务")
        return 2

    conf = config.save_bridge(enabled=True)
    token = conf["token"]
    built = webbuild.build()
    share = built["share_code"]
    print("bridge token =", token, "| share code =", share, "| size =", built["size"], flush=True)

    tmp = Path(tempfile.mkdtemp(prefix="study_bridge_"))
    (tmp / PAGE_NAME).write_bytes(Path(built["path"]).read_bytes())
    (tmp / DRIVER_NAME).write_text(
        DRIVER.replace("__PAGE__", PAGE_NAME).replace("__RP__", str(RESULT_PORT))
              .replace("__BT__", token).replace("__SHARE__", share), encoding="utf-8")

    handler = functools.partial(QuietHandler, directory=str(tmp))
    pages = http.server.ThreadingHTTPServer(("127.0.0.1", PAGE_PORT), handler)
    threading.Thread(target=pages.serve_forever, daemon=True).start()
    coll = http.server.ThreadingHTTPServer(("127.0.0.1", RESULT_PORT), Collector)
    threading.Thread(target=coll.serve_forever, daemon=True).start()

    if PROFILE.exists():
        shutil.rmtree(PROFILE, ignore_errors=True)
    proc = None
    try:
        proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
                                 "--window-size=1400,1100", "--user-data-dir=" + str(PROFILE),
                                 "http://127.0.0.1:%d/%s" % (PAGE_PORT, DRIVER_NAME)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not done.wait(420):
            check("公网版连接服务器验收跑完", False, "超时")
        else:
            for line in json.loads(result["body"])["lines"]:
                if line.startswith("ERROR:"):
                    check("公网版连接服务器验收跑完", False, line)
                elif ":" in line:
                    name, value = line.split(":", 1)
                    check(name, value == "ok", value)
                else:
                    print("  note: " + line, flush=True)
    finally:
        if proc is not None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            time.sleep(1)
            if proc.poll() is None:
                proc.kill()
        pages.shutdown()
        coll.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
        config.save_bridge(enabled=False)
        check("验收跑完把借用开关关回去", config.bridge_settings()["enabled"] is False)

    print("\npassed " + str(len(PASS)) + ", failed " + str(len(FAIL)))
    for name in FAIL:
        print("  FAILED: " + name)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
