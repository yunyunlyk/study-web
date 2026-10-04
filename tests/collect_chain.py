r"""公网版收集链路验收：服务器 → 免费代理 → AI 联网搜索，三级降级都要真跑通。

前置：服务已经开在 127.0.0.1:8787。
用法：.venv\Scripts\python.exe tests\collect_chain.py
"""
from __future__ import annotations

import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = "http://127.0.0.1:8787"
RESULT_PORT = 8899
SITE_PORT = 8897
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
PROFILE = Path(os.environ.get("TEMP", ".")) / "chromeprof_study_collect"
DRIVER_NAME = "_collect_e2e.html"

PASS = []
FAIL = []
result = {}
done = threading.Event()
MODEL_CALLS = []
CORS = [("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "POST, GET, OPTIONS"),
        ("Access-Control-Allow-Headers", "*")]

FAKE_PAGE = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>示例学习页面</title></head><body>
<h1>动量和冲量的复习要点</h1>
<p>动量守恒定律说的是：系统不受外力或者所受外力的矢量和为零时，系统的总动量保持不变。</p>
<p>弹性碰撞的恢复系数等于一，动能也守恒；完全非弹性碰撞的恢复系数等于零，碰后两物体速度相同。</p>
<p>冲量等于力与作用时间的乘积，它等于动量的变化量，这就是动量定理的内容。</p>
</body></html>"""


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (("  -> " + str(detail)) if detail else ""), flush=True)


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
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class FakeSite(http.server.BaseHTTPRequestHandler):
    """既是「一个能抓的网页」，又假装一个带联网搜索的 OpenAI 兼容模型。"""

    def _cors(self):
        for k, v in CORS:
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/page.html") or self.path == "/":
            raw = FAKE_PAGE.encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8", "replace") or "{}")
        MODEL_CALLS.append({"has_tools": bool(body.get("tools")), "model": body.get("model")})
        payload = {
            "id": "fake", "model": body.get("model") or "fake",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant",
                                     "content": "FAKE-联网答案：动量守恒定律说的是系统不受外力时总动量不变。"}}],
        }
        if body.get("tools"):
            payload["web_search"] = [
                {"content": "动量守恒定律的内容与成立条件，适用于碰撞和爆炸等过程。", "icon": "",
                 "link": "https://example.org/momentum", "media": "示例物理网",
                 "publish_date": "2024-03-01", "refer": "ref_1", "title": "动量守恒定律"},
                {"content": "冲量与动量定理的推导，以及常见的易错点整理。", "icon": "",
                 "link": "https://example.org/impulse", "media": "示例学习站",
                 "publish_date": "2023-11-20", "refer": "ref_2", "title": "冲量与动量定理"},
            ]
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


DRIVER_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<iframe id="f" src="/" style="width:1280px;height:1000px;border:0"></iframe>
<script>
var log = [];
function say(s) { log.push(String(s)); }
function report() { return fetch('http://127.0.0.1:__RP__/done', { method: 'POST', body: JSON.stringify({ lines: log }) }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var F = document.getElementById('f');
function D() { try { return F.contentDocument; } catch (e) { return null; } }
function W() { return F.contentWindow; }
function txt() { try { return D().body.innerText || ''; } catch (e) { return ''; } }
function waitFor(fn, ms) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function tick() { var v = false; try { v = fn(); } catch (e) { v = false; }
      if (v) { res(v); return; } if (Date.now() - t0 > ms) { rej(new Error('timeout')); return; } setTimeout(tick, 250); })();
  });
}

var FAKE_HTML = '<!DOCTYPE html><html><head><title>代理抓到的页面</title></head><body>'
  + '<h1>代理通道返回的正文</h1>'
  + '<p>这是一段足够长的正文，用来证明第三方免费抓取代理这条路真的能把网页正文取回来。</p>'
  + '<p>第二段内容也要足够长，确保提取出来的文字超过八十个字符的阈值要求。</p></body></html>';

function patchFetch(mode) {
  var w = W();
  if (!w.__origFetch) { w.__origFetch = w.fetch; }
  var orig = w.__origFetch;
  w.fetch = function (url, opts) {
    var u = String(url);
    var isProxy = u.indexOf('api.cors.lol') >= 0 || u.indexOf('allorigins') >= 0 || u.indexOf('codetabs') >= 0;
    if (isProxy) {
      if (mode === 'proxy-ok') {
        return Promise.resolve(new (w.Response)(FAKE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } }));
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return orig.call(w, u, opts);
  };
}

function setStore(key, value) { return W().StudyStore.settingsSet(key, value); }

async function collectUrl(url) {
  W().location.hash = '#/collect';
  await waitFor(function () { return D() && D().getElementById('colUrl'); }, 40000);
  await sleep(400);
  D().getElementById('colUrl').value = url;
  D().getElementById('colUrlBtn').click();
  await waitFor(function () {
    var o = D().getElementById('colOut');
    if (!o) { return false; }
    var t = o.innerText || '';
    return t.indexOf('正在抓取') < 0 && t.length > 4;
  }, 180000);
  return D().getElementById('colOut').innerText;
}

(async function () {
  try {
    await waitFor(function () { return D() && D().getElementById('uName'); }, 40000);
    D().getElementById('uName').value = '__USER__';
    D().getElementById('uPass').value = '__PW__';
    D().getElementById('btnGo').click();
    await waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);

    W().location.hash = '#/me';
    await waitFor(function () { return D().getElementById('lsBase'); }, 40000);
    D().getElementById('lsBase').value = 'http://127.0.0.1:__SITE__/v1';
    D().getElementById('lsKey').value = 'fake-key';
    D().getElementById('lsModels').value = 'fake-chat';
    D().getElementById('lsSave').click();
    await sleep(1200);
    // 「我的」页按设计只放设置项，不再写"解释系统怎么工作"的灰色小字（见 README 第 25 节），
    // 所以「联网搜索支持哪些模型」这句话在「收集」页的通道说明里 —— 去那儿验证。
    W().location.hash = '#/collect';
    await waitFor(function () { return D() && D().getElementById('colUrl'); }, 40000);
    await sleep(400);
    say('COLLECT_NOTES_WEBSEARCH:' + (txt().indexOf('联网搜索') >= 0 ? 'ok' : 'bad'));

    await setStore('bridge', { url: 'http://127.0.0.1:8787', key: '__TOKEN__' });
    var out1 = await collectUrl('http://127.0.0.1:__SITE__/page.html');
    say('CH1_SERVER:' + (out1.indexOf('已保存') >= 0 && out1.indexOf('你电脑上的服务器') >= 0 ? 'ok' : 'bad:' + out1.slice(0, 140)));

    W().location.hash = '#/search?q=' + encodeURIComponent('恢复系数');
    await waitFor(function () {
      var n = D().getElementById('sRes');
      return n && n.innerText.indexOf('示例学习页面') >= 0;
    }, 60000).then(function () {
      say('CH1_SAVED_AND_SEARCHABLE:ok');
    }, function () {
      say('CH1_SAVED_AND_SEARCHABLE:bad');
    });

    await setStore('bridge', { url: '', key: '' });
    patchFetch('proxy-ok');
    var out2 = await collectUrl('https://example.org/from-proxy');
    say('CH2_PROXY:' + (out2.indexOf('已保存') >= 0 && out2.indexOf('免费代理') >= 0 ? 'ok' : 'bad:' + out2.slice(0, 180)));

    patchFetch('proxy-dead');
    var out3 = await collectUrl('https://example.org/from-ai');
    say('CH3_AI:' + (out3.indexOf('已保存') >= 0 && out3.indexOf('AI 联网搜索') >= 0 ? 'ok' : 'bad:' + out3.slice(0, 180)));

    await setStore('ai', { base_url: '', api_key: '', model_text: '', model_vision: '' });
    var out4 = await collectUrl('https://example.org/all-dead');
    say('CH4_ALLDEAD:' + (out4.indexOf('已尝试') >= 0 && out4.indexOf('3 个通道') >= 0 ? 'ok' : 'bad:' + out4.slice(0, 240)));

    await setStore('ai', { base_url: 'http://127.0.0.1:__SITE__/v1', api_key: 'fake-key',
                           model_text: 'fake-chat', model_vision: 'fake-chat' });
    patchFetch('proxy-ok');
    W().location.hash = '#/collect';
    await waitFor(function () { return D().getElementById('colTopic'); }, 40000);
    await sleep(400);
    D().getElementById('colTopic').value = '动量守恒';
    D().getElementById('colTopicBtn').click();
    await waitFor(function () {
      var o = D().getElementById('colOut');
      var t = o ? (o.innerText || '') : '';
      return t.indexOf('收集完成') >= 0 || t.indexOf('收集失败') >= 0;
    }, 240000);
    var node5 = D().getElementById('colOut');
    var out5 = node5.innerText;
    var html5 = node5.innerHTML;
    say('CH5_TOPIC_AI:' + (out5.indexOf('收集完成') >= 0
        && html5.indexOf('example.org/momentum') >= 0 && html5.indexOf('example.org/impulse') >= 0
        ? 'ok' : 'bad:' + out5.slice(0, 240)));
    say('CH5_SOURCE_SITE:' + (out5.indexOf('示例物理网') >= 0 ? 'ok' : 'bad'));
    say('CH5_USED_AI:' + (out5.indexOf('AI 联网搜索') >= 0 ? 'ok' : 'bad'));

    await report();
  } catch (err) {
    say('ERROR:' + (err && err.message));
    await report();
  }
})();
</script>
</body></html>
"""


def make_account():
    user = "guest_collect_" + uuid.uuid4().hex[:6]
    pw = "test123456"
    body = {"username": user, "password": pw}
    code = str(json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8")).get("invite_code") or "")
    if code:
        body["invite"] = code
    r = requests.post(BASE + "/api/register", json=body, timeout=30)
    if not r.ok:
        raise SystemExit("注册测试账号失败：" + r.text[:200])
    return user, pw


def main() -> int:
    if not CHROME:
        print("找不到 Chrome / Edge —— 这次验收没有真正执行，退出码 77（不当作通过）。")
        print("装一个 Chrome 或 Edge，或者设环境变量 STUDY_CHROME 后重跑。")
        return SKIP_EXIT
    if requests.get(BASE + "/api/register/info", timeout=10).status_code != 200:
        print("服务没在跑，先启动服务")
        return 2
    user, pw = make_account()

    before = config.bridge_settings()
    if not before.get("enabled"):
        config.save_bridge(True, before.get("token") or "")
    token = config.bridge_settings().get("token") or ""

    server = http.server.ThreadingHTTPServer(("127.0.0.1", RESULT_PORT), Collector)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    site = http.server.ThreadingHTTPServer(("127.0.0.1", SITE_PORT), FakeSite)
    threading.Thread(target=site.serve_forever, daemon=True).start()

    page = (DRIVER_TEMPLATE.replace("__USER__", user).replace("__PW__", pw)
            .replace("__RP__", str(RESULT_PORT)).replace("__SITE__", str(SITE_PORT))
            .replace("__TOKEN__", token))
    target = config.WEB_DIR / DRIVER_NAME
    target.write_text(page, encoding="utf-8")
    if PROFILE.exists():
        shutil.rmtree(PROFILE, ignore_errors=True)

    proc = None
    try:
        proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
                                 "--window-size=1300,1050", "--user-data-dir=" + str(PROFILE),
                                 BASE + "/static/" + DRIVER_NAME],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not done.wait(420):
            check("收集链路验收跑完", False, "超时")
        else:
            for line in json.loads(result["body"])["lines"]:
                if line.startswith("ERROR:"):
                    check("收集链路验收跑完", False, line)
                elif ":" in line:
                    name, value = line.split(":", 1)
                    check(name, value == "ok", value)
        check("假模型收到了带联网搜索的请求", any(c["has_tools"] for c in MODEL_CALLS), MODEL_CALLS[:4])
    finally:
        if proc is not None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            time.sleep(1)
            if proc.poll() is None:
                proc.kill()
        server.shutdown()
        site.shutdown()
        if target.exists():
            target.unlink()
        if not before.get("enabled"):
            config.save_bridge(False, before.get("token") or "")

    print("\npassed " + str(len(PASS)) + ", failed " + str(len(FAIL)))
    for name in FAIL:
        print("  FAILED: " + name)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
