r"""浏览器端验收：用无头 Chrome 真跑一遍普通账号（上传只落浏览器、自带密钥的 AI、刷新后数据还在）。

前置：服务已经开在 127.0.0.1:8787。
用法：.venv\Scripts\python.exe tests\browser_e2e.py
"""
from __future__ import annotations

import http.server
import json
import os
import shutil
import sqlite3
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
    import sys as _sys
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _find_chrome() -> str:
    """按顺序找可用的 Chrome / Edge：环境变量 STUDY_CHROME 优先，然后常见安装路径。

    以前这里把路径写死成 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe，
    找不到就 print 一句"跳过"然后 return 0 —— 退出码 0 会被当成"验收通过"，
    等于一条都没测却报成功。现在找不到就按 77（跳过）退出，不会被误认为通过。
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


BASE = "http://127.0.0.1:8787"
RESULT_PORT = 8899
FAKE_PORT = 8898
CHROME = _find_chrome()
SKIP_EXIT = 77
# 每次跑都用新的 profile：上一轮万一没杀干净，旧目录会锁住 Chrome，让它直接起不来
# （表现出来就是"超时"却没有任何报错，排查过一次）。
PROFILE = Path(os.environ.get("TEMP", ".")) / ("chromeprof_study_e2e_" + uuid.uuid4().hex[:6])
DRIVER_NAME = "_e2e.html"

PASS = []
FAIL = []
result = {}
done = threading.Event()
FAKE_CALLS = []
PROGRESS = []
CORS = [("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "*")]


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
        elif self.path.endswith("/progress"):
            try:
                lines = json.loads(raw or "{}").get("lines") or []
            except Exception:
                lines = []
            if lines:
                PROGRESS.append(lines[-1])
                print("  [进度] 跑到：" + str(lines[-1])[:120], flush=True)
        self.send_response(200)
        for k, v in CORS:
            self.send_header(k, v)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class FakeModel(http.server.BaseHTTPRequestHandler):
    """假装一个允许跨域的 OpenAI 兼容服务，用来证明“普通账号自带密钥”这条路真的能通。"""

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS:
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8", "replace") or "{}")
        FAKE_CALLS.append({"model": body.get("model"),
                           "has_auth": bool(self.headers.get("Authorization"))})
        answer = "FAKE-模型回答-OK：动量守恒定律说的是系统不受外力时总动量不变。"
        out = json.dumps({"id": "fake", "model": body.get("model") or "fake",
                          "choices": [{"index": 0, "finish_reason": "stop",
                                       "message": {"role": "assistant", "content": answer}}]}).encode("utf-8")
        self.send_response(200)
        for k, v in CORS:
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


DRIVER_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<iframe id="f" src="/" style="width:1280px;height:1000px;border:0"></iframe>
<script>
var log = [];
function say(s) {
  log.push(String(s));
  // 顺便把进度发给收集端：万一后面卡住，超时的时候至少能看到走到哪一步了。
  try {
    fetch('http://127.0.0.1:__RP__/progress', { method: 'POST', body: JSON.stringify({ lines: log }) })['catch'](function () {});
  } catch (e) {}
}
function report() { return fetch('http://127.0.0.1:__RP__/done', { method: 'POST', body: JSON.stringify({ lines: log }) }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var f = document.getElementById('f');
function D() { try { return f.contentDocument; } catch (e) { return null; } }
function W() { return f.contentWindow; }
function txt() { try { return D().body.innerText || ''; } catch (e) { return ''; } }
function loginAs(name, pw) {
  return W().fetch('/api/logout', { method: 'POST' }).then(function () {
    W().location.href = '/';
    return waitFor(function () { return D() && D().getElementById('uName'); }, 40000);
  }).then(function () {
    D().getElementById('uName').value = name;
    D().getElementById('uPass').value = pw;
    D().getElementById('btnGo').click();
    return waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);
  }).then(function () {
    W().location.hash = '#/me';
    return waitFor(function () { return txt().indexOf('反馈') >= 0; }, 40000);
  });
}
function waitFor(fn, ms) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function tick() { var v = false; try { v = fn(); } catch (e) { v = false; }
      if (v) { res(v); return; } if (Date.now() - t0 > ms) { rej(new Error('timeout')); return; } setTimeout(tick, 200); })();
  });
}
(async function () {
  try {
    await waitFor(function () { return D() && D().getElementById('uName'); }, 40000);
    // 回归：需要邀请码时注册页必须真的出现邀请码输入框
    // （曾经因为匿名 /api/me 返回 200 而不是报错，这段信息永远没被拉取，输入框一直不显示）
    var needInvite = false;
    try {
      var regInfo = await W().fetch('/api/register/info').then(function (r) { return r.json(); });
      needInvite = !!regInfo.need_invite;
    } catch (e) { needInvite = false; }
    D().getElementById('tabReg').click();
    await sleep(1200);
    var hasInvite = !!D().getElementById('uInvite');
    say('REGISTER_OFFERS_INVITE_FIELD:' + ((needInvite ? hasInvite : true) ? 'ok' : 'bad'));
    say('LOGIN_PAGE_HAS_ANIMATED_BACKDROP:' + (D().querySelectorAll('.login-page .lp-bg i').length >= 3 && !!D().querySelector('.lp-bg .lp-grid') ? 'ok' : 'bad'));
    say('LOGIN_PAGE_HAS_BRAND_MARK:' + (D().querySelector('.login-mark svg') ? 'ok' : 'bad'));
    say('LOGIN_PAGE_NO_SUBJECT_CHIPS:' + (D().querySelectorAll('.login .chip,.login-logo').length === 0 ? 'ok' : 'bad'));
    say('LOGIN_PAGE_HAS_PASSWORD_TOGGLE:' + (D().getElementById('pwEye') ? 'ok' : 'bad'));
    D().getElementById('tabLogin').click();
    await sleep(400);
    D().getElementById('uName').value = '__USER__';
    D().getElementById('uPass').value = '__PW__';
    // 回归：服务没在跑时，登录失败要给人话，而不是英文的 "Failed to fetch"
    var downMsg = 'bad';
    try {
      var realFetch = W().fetch;
      W().fetch = function () { return Promise.reject(new TypeError('Failed to fetch')); };
      D().getElementById('btnGo').click();
      await sleep(900);
      var toastText = D().getElementById('toast').innerText || '';
      downMsg = (toastText.indexOf('连接不上服务器') >= 0 && toastText.indexOf('Failed to fetch') < 0) ? 'ok' : ('bad:' + toastText);
      W().fetch = realFetch;
      D().getElementById('toast').innerHTML = '';
    } catch (e) { downMsg = 'bad:' + (e && e.message); }
    say('LOGIN_SAYS_SERVER_DOWN_IN_CHINESE:' + downMsg);
    D().getElementById('btnGo').click();
    await waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);
    var home = txt();
    // 检查首页有没有泄露「本机痕迹」：禁用词列表（storage.json 里配的）+ 资料目录的文件夹名。
    // 以前这里写死了自己的用户名和资料夹名字，代码一公开等于把它们一起发出去了。
    var leakTokens = __LEAKTOKENS__;
    var homeLeak = leakTokens.some(function (t) { return t && home.indexOf(t) >= 0; });
    say('HOME_NO_PATH_LEAK:' + (homeLeak ? 'bad' : 'ok'));
    say('HOME_SAYS_MINE:' + (home.indexOf('你自己的资料库') >= 0 ? 'ok' : 'bad'));
    // 普通账号的首页不该出现管理员的资料库规模；数字从接口实时取，不写死
    var sizeTokens = __SIZETOKENS__;
    var sizeLeak = sizeTokens.some(function (t) { return t && home.indexOf(t) >= 0; });
    say('HOME_NO_LIBRARY_SIZE:' + (sizeLeak ? 'bad' : 'ok'));
    // 动画：登录页 300ms ease-out 淡入；登录成功后内容从下方 20px 滑入
    var anim1 = 'bad';
    try {
      var loginRule = null;
      var sheets = D().styleSheets;
      for (var si = 0; si < sheets.length; si++) {
        var rules = sheets[si].cssRules || [];
        for (var ri = 0; ri < rules.length; ri++) {
          if (rules[ri].selectorText === '.overlay.login-page') { loginRule = rules[ri].style; }
        }
      }
      anim1 = (loginRule && loginRule.animationDuration === '0.3s'
        && loginRule.animationTimingFunction === 'ease-out'
        && loginRule.animationName === 'loginFade')
        ? 'ok' : ('bad:' + (loginRule ? (loginRule.animationName + '/' + loginRule.animationDuration + '/'
            + loginRule.animationTimingFunction) : 'no-rule'));
    } catch (e) { anim1 = 'bad:' + (e && e.message); }
    say('LOGIN_PAGE_FADE_IN_300MS_EASE_OUT:' + anim1);
    var anim2 = 'bad';
    try {
      var wrapEl = D().querySelector('#app > .wrap');
      var wcs = W().getComputedStyle(wrapEl);
      anim2 = ((' ' + wrapEl.className + ' ').indexOf(' page-enter ') >= 0
        && wcs.animationName === 'pageIn' && wcs.animationDuration === '0.3s')
        ? 'ok' : ('bad:' + wrapEl.className + '/' + wcs.animationName + '/' + wcs.animationDuration);
    } catch (e) { anim2 = 'bad:' + (e && e.message); }
    say('POST_LOGIN_CONTENT_SLIDES_UP_20PX:' + anim2);
    // PWA：可安装（manifest + 图标）+ 离线壳注册成功
    await sleep(1500);
    var pwa = 'bad';
    try {
      var man = await W().fetch('/static/manifest.webmanifest').then(function (r) { return r.json(); });
      var iconOk = await W().fetch('/static/icons/icon-192.png').then(function (r) { return r.ok; });
      var maskable = await W().fetch('/static/icons/icon-maskable-512.png').then(function (r) { return r.ok; });
      var apple = !!D().querySelector('link[rel="apple-touch-icon"]');
      var meta = D().querySelector('meta[name="theme-color"]');
      var regs = await W().navigator.serviceWorker.getRegistrations();
      pwa = (man.icons && man.icons.length >= 3 && iconOk && maskable && apple && !!meta && regs.length >= 1)
        ? 'ok' : ('bad:' + JSON.stringify({ icons: (man.icons || []).length, icon192: iconOk,
            maskable: maskable, apple: apple, meta: !!meta, sw: regs.length }));
    } catch (e) { pwa = 'bad:' + (e && e.message); }
    say('PWA_MANIFEST_ICONS_AND_OFFLINE_SHELL:' + pwa);
    // 状态栏颜色要跟着主题变（装到桌面后才协调）
    var tcolor = 'bad';
    try {
      var metaTag = D().querySelector('meta[name="theme-color"]');
      var beforeColor = metaTag.getAttribute('content');
      W().StudyTheme.apply({ preset: 'dark' });
      await sleep(200);
      var afterColor = metaTag.getAttribute('content');
      W().StudyTheme.reset();
      tcolor = (beforeColor && afterColor && beforeColor !== afterColor && afterColor === '#12161c')
        ? 'ok' : ('bad:' + beforeColor + '->' + afterColor);
    } catch (e) { tcolor = 'bad:' + (e && e.message); }
    say('PWA_THEME_COLOR_FOLLOWS_THEME:' + tcolor);
    // 底部导航给安全区留了位置（刘海屏 / 手势条）
    var safe = 'bad';
    try {
      var tab = D().getElementById('tabbar');
      safe = tab ? 'ok' : 'bad:no-tabbar';
    } catch (e) { safe = 'bad:' + (e && e.message); }
    say('PWA_BOTTOM_TAB_BAR:' + safe);
    // 深色主题下不能出现“白底浅字”（管理端标签栏踩过这个坑）
    var contrast = 'bad:no-theme';
    try {
      W().StudyTheme.apply({ preset: 'dark' });
      var lum = function (c) { var m = String(c).match(/[0-9.]+/g) || []; return 0.2126 * (+m[0] || 0) + 0.7152 * (+m[1] || 0) + 0.0722 * (+m[2] || 0); };
      var bgOf = function (node) {
        var el = node;
        while (el) {
          var c = W().getComputedStyle(el).backgroundColor;
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { return c; }
          el = el.parentElement;
        }
        return 'rgb(255,255,255)';
      };
      var bar = D().getElementById('topbar');
      contrast = Math.abs(lum(bgOf(bar)) - lum(W().getComputedStyle(bar).color)) > 60 ? 'ok' : 'bad';
      W().StudyTheme.reset();
    } catch (e) { contrast = 'bad:' + (e && e.message); }
    say('DARK_THEME_TOP_BAR_CONTRAST:' + contrast);
    // 回归：登录后拉取“账号主题”（账号主题里没有壁纸）不能把本机壁纸冲掉
    var wallCheck = 'bad';
    try {
      var wt = { preset: 'dark', accent: '', bg: '', card: '', fg: '', radius: 14, scale: 100, compact: false, follow: false, wallpaper: 'data:image/png;base64,AAAA-WALL-XYZ' };
      W().localStorage.setItem('study_theme_v1', JSON.stringify(wt));
      W().StudyTheme.apply(wt);
      W().StudyTheme.apply({ preset: 'dark', accent: '', bg: '', card: '', fg: '', radius: 14, scale: 100, compact: false, follow: false, wallpaper: '' });
      var bg2 = D().body.style.backgroundImage || '';
      wallCheck = (bg2.indexOf('AAAA-WALL-XYZ') >= 0 && D().documentElement.getAttribute('data-theme') === 'dark') ? 'ok' : 'bad';
      W().localStorage.removeItem('study_theme_v1');
      W().localStorage.removeItem('study_wallpaper_v1');
      W().StudyTheme.reset();
    } catch (e) { wallCheck = 'bad:' + (e && e.message); }
    say('WALLPAPER_SURVIVES_ACCOUNT_THEME:' + wallCheck);
    var nav = D().getElementById('topbar').innerText;
    say('NAV_NO_INDEX:' + (nav.indexOf('索引进度') < 0 ? 'ok' : 'bad'));
    say('NAV_NO_ADMIN:' + (nav.indexOf('管理端') < 0 ? 'ok' : 'bad'));
    say('NAV_HAS_COLLECT:' + (nav.indexOf('收集') >= 0 ? 'ok' : 'bad'));

    // 按钮按下的水波
    function navLink(label) {
      var links = D().querySelectorAll('#topbar a.nav');
      for (var i = 0; i < links.length; i++) {
        if ((links[i].innerText || '').indexOf(label) >= 0) { return links[i]; }
      }
      return null;
    }
    var ripple = 'bad';
    try {
      var searchLink = navLink('搜索');
      if (!searchLink) { ripple = 'bad:no-link'; } else {
        var lr = searchLink.getBoundingClientRect();
        searchLink.dispatchEvent(new (W().PointerEvent)('pointerdown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: lr.left + lr.width / 2, clientY: lr.top + lr.height / 2
        }));
        var dot = searchLink.querySelector('.ripple');
        ripple = (dot && W().getComputedStyle(dot).animationName === 'rippleOut')
          ? 'ok' : ('bad:' + (dot ? W().getComputedStyle(dot).animationName : 'no-ripple'));
      }
    } catch (e) { ripple = 'bad:' + (e && e.message); }
    say('BUTTON_PRESS_RIPPLE:' + ripple);
    // 点后面的标签：内容从右边滑入
    var meLink = navLink('我的');
    if (meLink) { meLink.click(); } else { W().location.hash = '#/me'; }
    await sleep(1400);
    var dirRight = 'bad';
    try {
      var elR = D().querySelector('#app > .page-enter-right');
      var rcs = elR ? W().getComputedStyle(elR) : null;
      dirRight = (rcs && rcs.animationName === 'slideFromRight' && rcs.animationDuration === '0.35s')
        ? 'ok' : ('bad:' + (elR ? (elR.className + '/' + rcs.animationName + '/' + rcs.animationDuration) : 'none'));
    } catch (e) { dirRight = 'bad:' + (e && e.message); }
    say('PAGE_SLIDES_IN_FROM_RIGHT:' + dirRight);
    // 再点前面的标签：内容从左边滑入
    var backLink = navLink('搜索');
    if (backLink) { backLink.click(); } else { W().location.hash = '#/search'; }
    await sleep(1400);
    var dirLeft = 'bad';
    try {
      var elL = D().querySelector('#app > .page-enter-left');
      var lcs = elL ? W().getComputedStyle(elL) : null;
      dirLeft = (lcs && lcs.animationName === 'slideFromLeft' && lcs.animationDuration === '0.35s')
        ? 'ok' : ('bad:' + (elL ? (elL.className + '/' + lcs.animationName + '/' + lcs.animationDuration) : 'none'));
    } catch (e) { dirLeft = 'bad:' + (e && e.message); }
    say('PAGE_SLIDES_IN_FROM_LEFT:' + dirLeft);

    W().location.hash = '#/me';
    await waitFor(function () { return D().getElementById('lsBase'); }, 40000);
    say('ME_HAS_AI_PANEL:ok');
    var meText = D().getElementById('app').innerText;
    say('ME_NO_STORAGE_QUOTA_LINE:' + (meText.indexOf('浏览器给的空间上限') < 0 && meText.indexOf('本机已存') < 0 ? 'ok' : 'bad'));
    say('ME_TALKS_TO_USER_NOT_OWNER:' + (meText.indexOf('站长') < 0 ? 'ok' : 'bad'));
    // 昵称不能再和密码框凑成一对，否则浏览器会把别人的登录信息自动填进昵称。
    var nick = D().getElementById('pfNick');
    say('ME_PROFILE_FIELD_NOT_AUTOFILLED:' + (nick.getAttribute('autocomplete') === 'off'
      && nick.value === '' && nick.name.indexOf('user') < 0 ? 'ok' : 'bad'));
    var pwCard = null;
    Array.prototype.forEach.call(D().querySelectorAll('#app .card'), function (c) {
      if (c.querySelector('#pwOld')) { pwCard = c; }
    });
    say('ME_PASSWORD_IS_OWN_CARD:' + (pwCard && pwCard.querySelector('h2').textContent === '改密码'
      && !pwCard.querySelector('#pfNick') && D().getElementById('pwOld').getAttribute('autocomplete') === 'off' ? 'ok' : 'bad'));
    D().getElementById('lsBase').value = 'http://127.0.0.1:__FK__/v1';
    D().getElementById('lsModels').value = 'fake-chat';
    D().getElementById('lsVision').value = 'fake-chat';
    D().getElementById('lsSave').click();
    await sleep(1200);
    D().getElementById('lsTest').click();
    await waitFor(function () {
      var o = D().getElementById('lsOut');
      return o && o.textContent && o.textContent.indexOf('正在测试') < 0;
    }, 60000);
    say('AI_TEST_OWN_KEY:' + (D().getElementById('lsOut').textContent.indexOf('通了') >= 0 ? 'ok' : 'bad'));

    W().location.hash = '#/upload';
    await waitFor(function () { return D().getElementById('drop') && D().getElementById('hiddenFile').onchange; }, 40000);
    say('UPLOAD_SAYS_WHERE_IT_GOES:' + (String((D().getElementById('upWhere') || {}).innerText).length > 10 ? 'ok' : 'bad'));
    var file = new (W().File)(['浏览器验收：动量守恒定律的内容。'], '浏览器验收资料.txt', { type: 'text/plain' });
    var dt = new (W().DataTransfer)();
    dt.items.add(file);
    var inp = D().getElementById('hiddenFile');
    inp.files = dt.files;
    inp.dispatchEvent(new (W().Event)('change'));
    await waitFor(function () {
      var t = D().getElementById('upList');
      return t && (t.textContent || '').indexOf('已保存 1 / 1') >= 0;
    }, 60000);
    say('UPLOAD_TO_BROWSER:ok');

    W().location.hash = '#/search?q=' + encodeURIComponent('动量守恒');
    await waitFor(function () {
      var n = D().getElementById('sRes');
      return n && n.innerText.indexOf('浏览器验收资料') >= 0;
    }, 40000);
    say('SEARCH_OWN_FILE:ok');

    W().location.hash = '#/ask';
    await waitFor(function () { return D().getElementById('askQ'); }, 30000);
    D().getElementById('askQ').value = '动量守恒是什么？';
    D().getElementById('askBtn').click();
    await waitFor(function () {
      var o = D().getElementById('askOut');
      return o && o.innerText.indexOf('FAKE-模型回答') >= 0;
    }, 90000);
    say('ASK_WITH_OWN_KEY:ok');
    say('ASK_CITES_SOURCE:' + (D().getElementById('askOut').innerText.indexOf('浏览器验收资料') >= 0 ? 'ok' : 'bad'));

    var oldDoc = D();
    W().location.reload();
    await sleep(5000);
    await waitFor(function () { return D() && D() !== oldDoc && D().readyState === 'complete'; }, 60000);
    await waitFor(function () { return D().getElementById('btnLogout'); }, 40000);
    W().location.hash = '#/';
    await waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);
    say('AFTER_RELOAD_FILE_STILL_THERE:' + (txt().indexOf('浏览器验收资料') >= 0 ? 'ok' : 'bad'));

    // 管理员也要能在“我的”里看到 AI 接入（这里填的是全站统一配置）
    await W().fetch('/api/logout', { method: 'POST' });
    W().location.href = '/';
    await sleep(4000);
    await waitFor(function () { return D() && D().getElementById('uName'); }, 40000);
    D().getElementById('uName').value = '__ADMIN__';
    D().getElementById('uPass').value = '__ADMINPW__';
    D().getElementById('btnGo').click();
    await waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);
    W().location.hash = '#/me';
    await waitFor(function () { return D().getElementById('lsBase'); }, 40000);
    var admCard = '';
    Array.prototype.forEach.call(D().querySelectorAll('#app .card'), function (c) {
      var h = c.querySelector('h2');
      if (h && h.textContent.indexOf('AI 接入') >= 0) { admCard = c.innerText; }
    });
    say('ADMIN_ME_HAS_AI_PANEL:' + (admCard.indexOf('全站统一配置') >= 0 ? 'ok' : 'bad'));
    say('ADMIN_ME_AI_PANEL_PREFILLED:' + (String(D().getElementById('lsBase').value).indexOf('http') === 0 ? 'ok' : 'bad'));
    say('ADMIN_ME_AI_PANEL_NO_STORE_CHOICE:' + (D().querySelectorAll('input[name=aiStore]').length === 0 ? 'ok' : 'bad'));
    // 管理员回复用户反馈：页内回复框 + 页内确认框 + 用户端真能看到回复。
    // 反馈由这条用例的普通账号提前提交（见 main()），反馈 id 从 __FBID__ 传进来。
    try {
      var fid = '__FBID__';
      W().location.href = '/admin';
      await waitFor(function () { return D() && D().getElementById('admTabs'); }, 40000);
      await sleep(700);
      var usedNative = false;
      W().prompt = function () { usedNative = true; return null; };
      W().confirm = function () { usedNative = true; return false; };
      var atabs = D().querySelectorAll('#admTabs button');
      for (var ti = 0; ti < atabs.length; ti++) {
        if (atabs[ti].textContent.indexOf('用户反馈') >= 0) { atabs[ti].click(); }
      }
      var selReply = '[data-fbact="reply"][data-id="' + fid + '"]';
      await waitFor(function () { return D().querySelector(selReply); }, 40000);
      D().querySelector(selReply).click();
      await waitFor(function () { var b = D().getElementById('fbBox' + fid); return b && !b.hidden; }, 10000);
      var fta = D().getElementById('fbText' + fid);
      if (fta) { fta.value = '浏览器验收：收到啦'; }
      D().querySelector('[data-fbsend="' + fid + '"]').click();
      var shownOnPage = false;
      try {
        await waitFor(function () { return txt().indexOf('浏览器验收：收到啦') >= 0; }, 15000);
        shownOnPage = true;
      } catch (e1) {}
      var fdr = await W().fetch('/api/feedback', { cache: 'no-store' }).then(function (r) { return r.json(); });
      var saved = ((fdr.items || []).filter(function (x) { return String(x.id) === fid; })[0]) || {};
      var replyOk = (shownOnPage && saved.reply === '浏览器验收：收到啦' && saved.status === 'done' && !usedNative);
      say('ADMIN_FEEDBACK_REPLY_INLINE:' + (replyOk ? 'ok' : ('bad:' + JSON.stringify({ shown: shownOnPage,
        saved: saved.reply, status: saved.status, usedNative: usedNative }))));
      // 换成提反馈的那个普通账号，确认「我的 → 反馈」里真的看得到这条回复
      await loginAs('__USER__', '__PW__');
      var userSees = false;
      try {
        await waitFor(function () { return txt().indexOf('管理员回复') >= 0
          && txt().indexOf('浏览器验收：收到啦') >= 0; }, 25000);
        userSees = true;
      } catch (e4) {}
      say('USER_SEES_ADMIN_REPLY:' + (userSees ? 'ok' : ('bad:' + txt().slice(0, 160))));
      // 回到管理员，用页内确认框把这条测试反馈删掉
      await loginAs('__ADMIN__', '__ADMINPW__');
      W().location.href = '/admin';
      await waitFor(function () { return D() && D().getElementById('admTabs'); }, 40000);
      await sleep(700);
      var dtabs = D().querySelectorAll('#admTabs button');
      for (var di = 0; di < dtabs.length; di++) {
        if (dtabs[di].textContent.indexOf('用户反馈') >= 0) { dtabs[di].click(); }
      }
      var selDel = '[data-fbact="del"][data-id="' + fid + '"]';
      await waitFor(function () { return D().querySelector(selDel); }, 30000);
      D().querySelector(selDel).click();
      await waitFor(function () { return D().querySelector('.ui-mask.on'); }, 10000);
      var maskText = D().querySelector('.ui-mask.on').innerText || '';
      D().querySelector('.ui-mask.on .btn.primary').click();
      var maskClosed = false;
      try {
        await waitFor(function () { return !D().querySelector('.ui-mask.on'); }, 10000);
        maskClosed = true;
      } catch (e2) {}
      var gone = false;
      var ft0 = Date.now();
      while (Date.now() - ft0 < 15000) {
        var fdd = await W().fetch('/api/feedback', { cache: 'no-store' }).then(function (r) { return r.json(); });
        if (!((fdd.items || []).filter(function (x) { return String(x.id) === fid; }).length)) { gone = true; break; }
        await sleep(500);
      }
      say('ADMIN_DELETE_USES_INPAGE_CONFIRM:' + ((maskText.indexOf('删除') >= 0 && maskClosed && gone && !usedNative)
        ? 'ok' : ('bad:' + JSON.stringify({ mask: maskText, maskClosed: maskClosed, gone: gone, usedNative: usedNative }))));
    } catch (e) {
      say('ADMIN_FEEDBACK_REPLY_INLINE:bad:' + (e && e.message));
    }
    // ---- 文件夹模式：里面的资料要能进「搜索」和「AI 问答」（管理员身份，覆盖“管理员不回填”的老毛病）----
    try {
      W().location.href = '/';
      await waitFor(function () { return D() && D().getElementById('app'); }, 40000);
      await waitFor(function () { return txt().indexOf('资料库总览') >= 0; }, 40000);
      var FREL = '浏览器验收文件夹/FOLDER-E2E-动量守恒笔记.pdf';
      var FTEXT = '动量守恒：系统不受外力时总动量保持不变。';
      var seeded = await new Promise(function (res, rej) {
        var rq = W().indexedDB.open('study_folder_v1', 3);
        rq.onupgradeneeded = function () {
          var db0 = rq.result;
          if (!db0.objectStoreNames.contains('state')) { db0.createObjectStore('state'); }
          if (!db0.objectStoreNames.contains('docs')) { db0.createObjectStore('docs'); }
          if (!db0.objectStoreNames.contains('texts')) { db0.createObjectStore('texts'); }
        };
        rq.onerror = function () { rej(rq.error); };
        rq.onsuccess = function () {
          var db = rq.result;
          var tx = db.transaction(['docs', 'texts'], 'readwrite');
          var doc = { id: 'f:' + FREL, name: 'FOLDER-E2E-动量守恒笔记.pdf', subject: '浏览器验收文件夹',
                      kind: 'pdf', ext: 'pdf', size: 1000, mtime: 1, relPath: FREL, origin: 'folder',
                      has_text: true, pages: 1, text_keys: ['f:' + FREL + ':1'], text_state: 'done' };
          tx.objectStore('docs').put(doc, doc.id);
          tx.objectStore('texts').put({ key: 'f:' + FREL + ':1', material_id: doc.id, page: 1,
                                        origin: 'extract', content: FTEXT }, 'f:' + FREL + ':1');
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { rej(tx.error); };
        };
      });
      say('FOLDER_INDEX_SEEDED:' + (seeded ? 'ok' : 'bad'));
      W().location.hash = '#/search?q=' + encodeURIComponent('动量守恒');
      var sawFolderHit = false;
      try {
        await waitFor(function () {
          var n = D().getElementById('sRes');
          return n && n.querySelector('[data-fopen]');
        }, 40000);
        sawFolderHit = true;
      } catch (e5) {}
      var resBox = D().getElementById('sRes');
      var resTxt = (resBox && resBox.innerText) || '';
      say('FOLDER_HIT_IN_SEARCH:' + ((sawFolderHit && resTxt.indexOf('文件夹') >= 0
        && resTxt.indexOf('FOLDER-E2E-动量守恒笔记.pdf') >= 0) ? 'ok' : ('bad:' + resTxt.slice(0, 160))));
      var fbtn = D().querySelector('[data-fopen]');
      say('FOLDER_HIT_OPENS_LOCAL_FILE:' + ((fbtn && fbtn.getAttribute('data-fopen') === FREL) ? 'ok'
        : ('bad:' + (fbtn ? fbtn.getAttribute('data-fopen') : 'no-button'))));
      var asked = null;
      var realFetch2 = W().fetch;
      W().fetch = function (url, opt) {
        if (String(url).indexOf('/api/ask') === 0) {
          asked = JSON.parse((opt && opt.body) || '{}');
          return Promise.resolve({ ok: true, status: 200, json: function () {
            return Promise.resolve({ ok: true, answer: 'FAKE-文件夹回答', reasoning: '', deep: false, model: 'fake',
              sources: [{ index: 1, material_id: 'f:' + FREL, name: 'FOLDER-E2E-动量守恒笔记.pdf',
                          subject: '浏览器验收文件夹' }] });
          } });
        }
        return realFetch2.call(W(), url, opt);
      };
      W().location.hash = '#/ask';
      await waitFor(function () { return D().getElementById('askQ'); }, 30000);
      D().getElementById('askQ').value = '动量守恒是什么？';
      D().getElementById('askBtn').click();
      await waitFor(function () { return asked !== null; }, 30000);
      var ex = (asked && asked.extra) || [];
      var folderEx = ex.filter(function (e) { return e.material_id === 'f:' + FREL; })[0];
      say('ASK_SENDS_FOLDER_CONTEXT:' + ((folderEx && String(folderEx.text).indexOf('动量守恒') >= 0
        && ex.length <= 4) ? 'ok' : ('bad:' + JSON.stringify(ex))));
      var citedFolder = false;
      try {
        await waitFor(function () {
          var o = D().getElementById('askOut');
          return o && o.querySelector('[data-fopen]');
        }, 20000);
        citedFolder = true;
      } catch (e6) {}
      say('ASK_CITES_FOLDER_SOURCE:' + (citedFolder ? 'ok' : 'bad'));
      W().fetch = realFetch2;
      // 选文件夹：只申请读权限（不再连带弹“允许修改文件”那个确认框）
      W().location.hash = '#/folder';
      await waitFor(function () { return D().getElementById('foPick'); }, 30000);
      var realPicker = W().showDirectoryPicker;
      var DOMExc = W().DOMException;
      var seenOpts = null;
      W().showDirectoryPicker = function (opts) {
        seenOpts = opts;
        return Promise.reject(new DOMExc('The user aborted a request.', 'AbortError'));
      };
      D().getElementById('toast').innerHTML = '';
      D().getElementById('foPick').click();
      await sleep(1500);
      say('FOLDER_PICK_ASKS_READ_ONLY:' + ((seenOpts && seenOpts.mode === 'read')
        ? 'ok' : ('bad:' + JSON.stringify(seenOpts))));
      // 窗口根本没弹出来（内置浏览器常见）：要说清是浏览器没弹窗，并给出 Edge/Chrome 的出路
      var toastBox = D().getElementById('toast');
      var ttext = (toastBox && toastBox.innerText) || '';
      var whyBox = D().getElementById('foWhy');
      var whyTxt = (whyBox && whyBox.innerText) || '';
      say('FOLDER_NO_DIALOG_IS_HONEST:' + (((ttext.indexOf('Edge') >= 0 || ttext.indexOf('Chrome') >= 0)
        && ttext.indexOf('aborted') < 0 && ttext.indexOf('没有选中文件夹') < 0)
        ? 'ok' : ('bad:' + ttext.slice(0, 200))));
      say('FOLDER_WHY_ON_PAGE:' + ((whyTxt.indexOf('Edge') >= 0 || whyTxt.indexOf('Chrome') >= 0)
        ? 'ok' : ('bad:' + whyTxt.slice(0, 200))));
      var pickBtn = D().getElementById('foPick');
      say('FOLDER_CANCEL_FREES_THE_BUTTON:' + ((pickBtn && !pickBtn.disabled
        && pickBtn.textContent.indexOf('选择文件夹') >= 0) ? 'ok'
        : ('bad:' + (pickBtn ? pickBtn.textContent + '/disabled=' + pickBtn.disabled : 'no-button'))));
      // 用户真的点了“取消”（弹窗开了几百毫秒才关）：说人话，并告诉怎么才算选中
      W().showDirectoryPicker = function () {
        return new Promise(function (res, rej) {
          setTimeout(function () { rej(new DOMExc('The user aborted a request.', 'AbortError')); }, 600);
        });
      };
      D().getElementById('toast').innerHTML = '';
      var pickBtn2 = D().getElementById('foPick');
      if (pickBtn2) { pickBtn2.disabled = false; pickBtn2.click(); }
      await sleep(1800);
      var ttext2 = (D().getElementById('toast').innerText) || '';
      say('FOLDER_CANCEL_SAYS_CHINESE:' + ((ttext2.indexOf('没有选中文件夹') >= 0
        && ttext2.indexOf('选择文件夹') >= 0 && ttext2.indexOf('aborted') < 0)
        ? 'ok' : ('bad:' + ttext2.slice(0, 200))));
      W().showDirectoryPicker = realPicker;
    } catch (e) {
      say('FOLDER_INDEX_SEEDED:bad:' + (e && e.message));
    }
    // ---- AI 问答流式（SSE）：边收边显示、思考可折叠、服务端不支持时自动回退 ----
    try {
      W().location.hash = '#/ask';
      await waitFor(function () { return D().getElementById('askQ'); }, 30000);
      var realFetch3 = W().fetch;
      var enc = new (W().TextEncoder)();
      var sse = [
        { type: 'sources', sources: [{ index: 1, material_id: 'f:' + FREL,
            name: 'FOLDER-E2E-动量守恒笔记.pdf', subject: '浏览器验收文件夹' }], deep: false },
        { type: 'reasoning', text: '先看动量守恒的定义，再核对条件。' },
        { type: 'answer', text: '动量守恒：' },
        { type: 'answer', text: '系统不受外力时总动量保持不变。' },
        { type: 'model', text: 'fake-stream' },
        { type: 'done' }
      ].map(function (e) { return 'data: ' + JSON.stringify(e) + String.fromCharCode(10, 10); });
      var sent = 0;
      W().fetch = function (url, opt) {
        if (String(url).indexOf('/api/ask') === 0) {
          var i = 0;
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: function (k) { return String(k).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : ''; } },
            body: { getReader: function () { return { read: function () {
              return new Promise(function (res) {
                setTimeout(function () {
                  if (i >= sse.length) { res({ done: true, value: undefined }); return; }
                  var v = enc.encode(sse[i]); i++; sent = i;
                  res({ done: false, value: v });
                }, 450);
              });
            } }; } }
          });
        }
        return realFetch3.call(W(), url, opt);
      };
      D().getElementById('askQ').value = '动量守恒是什么？';
      D().getElementById('askBtn').click();
      var paintedEarly = false;
      try {
        await waitFor(function () {
          var o = D().getElementById('askOut');
          return o && o.innerText.indexOf('动量守恒：') >= 0;
        }, 25000);
        paintedEarly = sent < sse.length;   // 流还没发完就先显示出来了
      } catch (e7) {}
      say('ASK_STREAMS_BEFORE_FINISH:' + (paintedEarly ? 'ok' : ('bad:' + sent + '/' + sse.length)));
      await waitFor(function () {
        var o = D().getElementById('askOut');
        return o && o.innerText.indexOf('系统不受外力时总动量保持不变') >= 0;
      }, 30000);
      var askOutTxt = D().getElementById('askOut').innerText;
      say('ASK_STREAM_FULL_ANSWER:' + (askOutTxt.indexOf('动量守恒：系统不受外力时总动量保持不变') >= 0
        ? 'ok' : ('bad:' + askOutTxt.slice(0, 160))));
      say('ASK_STREAM_COLLAPSIBLE_THINKING:' + (D().querySelector('#askOut details.think') ? 'ok' : 'bad'));
      var fsrc = D().querySelector('#askOut [data-fopen]');
      say('ASK_STREAM_SOURCE_LINK:' + ((fsrc && fsrc.getAttribute('data-fopen') === FREL) ? 'ok'
        : ('bad:' + (fsrc ? fsrc.getAttribute('data-fopen') : 'no-button'))));
      var sawModel = false;
      try {
        await waitFor(function () {
          return D().getElementById('askOut').innerText.indexOf('fake-stream') >= 0;
        }, 20000);
        sawModel = true;
      } catch (e13) {}
      say('ASK_STREAM_SHOWS_MODEL:' + (sawModel ? 'ok' : ('bad:' + D().getElementById('askOut').innerText.slice(0, 120))));
      var btnBack = false;
      try {
        await waitFor(function () { return D().getElementById('askBtn').disabled === false; }, 25000);
        btnBack = true;
      } catch (e8) {}
      say('ASK_BUTTON_RECOVERED_AFTER_STREAM:' + (btnBack ? 'ok' : 'bad'));
      // 服务端没按流式回（老接口 / 没开流式）：自动退回一次性返回，行为跟以前一样
      var fallbackHit = false;
      var askCalls = 0;
      var lastBody = '';
      W().fetch = function (url, opt) {
        if (String(url).indexOf('/api/ask') === 0) {
          askCalls++;
          lastBody = String((opt && opt.body) || '');
          var body = {};
          try { body = JSON.parse((opt && opt.body) || '{}'); } catch (e9) {}
          if (body.stream) {
            return Promise.resolve({ ok: true, status: 200,
              headers: { get: function () { return 'application/json'; } },
              json: function () { return Promise.resolve({ ok: true, answer: 'NOPE' }); } });
          }
          fallbackHit = true;
          return Promise.resolve({ ok: true, status: 200,
            headers: { get: function () { return 'application/json'; } },
            json: function () { return Promise.resolve({ ok: true, answer: 'FALLBACK-非流式回答',
              reasoning: '', deep: false, model: 'fallback', sources: [] }); } });
        }
        return realFetch3.call(W(), url, opt);
      };
      D().getElementById('askQ').value = '再问一次';
      D().getElementById('askBtn').click();
      var fellBack = false;
      try {
        await waitFor(function () {
          var o = D().getElementById('askOut');
          return o && o.innerText.indexOf('FALLBACK-非流式回答') >= 0;
        }, 30000);
        fellBack = true;
      } catch (e10) {}
      say('ASK_FALLS_BACK_WHEN_NO_STREAM:' + ((fellBack && fallbackHit) ? 'ok'
        : ('bad:' + fellBack + '/' + fallbackHit + '/calls' + askCalls + '/body' + lastBody.slice(0, 40)
          + '/out' + ((D().getElementById('askOut') || {}).innerText || '').slice(0, 90))));
      W().fetch = realFetch3;

      // ---- 兼容扫描：内置浏览器没有句柄接口时的兜底（注入一个假的 webkitdirectory 目录） ----
      try { await W().StudyFolder.forget(); } catch (e11) {}
      W().location.hash = '#/upload';
      await sleep(400);
      W().location.hash = '#/folder';
      await waitFor(function () { return D() && D().getElementById('foCompat'); }, 30000);
      var realCompat = W().StudyFolder.compatPickFiles;
      W().StudyFolder.compatPickFiles = function () {
        function mk(rel, text) {
          var f = new (W().File)([text], rel.split('/').pop(), { type: 'text/plain' });
          Object.defineProperty(f, 'webkitRelativePath', { value: rel });
          return f;
        }
        return Promise.resolve([
          mk('兼容验收目录/语文/作文素材.txt', '作文素材：写景要抓住季节特征，动静结合。'),
          mk('兼容验收目录/语文/好句.md', '好句：落霞与孤鹜齐飞。'),
          mk('兼容验收目录/历史/时间线.txt', '历史时间线：秦统一六国在公元前 221 年。'),
          mk('兼容验收目录/随手记.txt', '随手记：今天复习了动量守恒。')
        ]);
      };
      say('FOLDER_COMPAT_BUTTON_OFFERED:' + (D().getElementById('foCompat') ? 'ok' : 'bad'));
      D().getElementById('foCompat').click();
      await waitFor(function () { return D().getElementById('foTop') && txt().indexOf('兼容验收目录') >= 0; }, 40000);
      await sleep(500);
      var csnap = await W().StudyFolder.snapshot();
      var csubs = {};
      ((csnap && csnap.docs) || []).forEach(function (d) { csubs[d.subject] = (csubs[d.subject] || 0) + 1; });
      say('FOLDER_COMPAT_SCANS_FOLDERS:' + ((csubs['语文'] === 2 && csubs['历史'] === 1
        && ((csnap && csnap.docs) || []).length === 4) ? 'ok' : ('bad:' + JSON.stringify(csubs))));
      var cst = await W().StudyFolder.stats();
      say('FOLDER_COMPAT_TEXT_EXTRACTED:' + (cst.searchable === 4 ? 'ok' : ('bad:' + JSON.stringify(cst))));
      W().location.hash = '#/search?q=' + encodeURIComponent('作文素材');
      var sawCompatHit = false;
      try {
        await waitFor(function () {
          var n = D().getElementById('sRes');
          return n && n.innerText.indexOf('作文素材') >= 0;
        }, 30000);
        sawCompatHit = true;
      } catch (e12) {}
      say('FOLDER_COMPAT_HIT_IN_SEARCH:' + (sawCompatHit ? 'ok' : ('bad:' + (D().getElementById('sRes') || {}).innerText)));
      W().StudyFolder.compatPickFiles = realCompat;
    } catch (e) {
      say('ASK_STREAMS_BEFORE_FINISH:bad:' + (e && e.message));
    }
    await report();
  } catch (err) {
    say('ERROR:' + (err && err.message));
    await report();
  }
})();
</script>
</body></html>
"""


def invite_code() -> str:
    try:
        return str(json.loads(config.SETTINGS_PATH.read_text(encoding="utf-8")).get("invite_code") or "")
    except Exception:
        return ""


def make_account(prefix="verify_e2e_"):
    user = prefix + uuid.uuid4().hex[:6]
    pw = "test123456"
    body = {"username": user, "password": pw}
    code = invite_code()
    if code:
        body["invite"] = code
    r = requests.post(BASE + "/api/register", json=body, timeout=30)
    if not r.ok:
        raise SystemExit("注册测试账号失败：" + r.text[:200])
    return user, pw


def db_exec(sql, params=()):
    conn = sqlite3.connect(str(config.DB_PATH), timeout=20)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    if not CHROME:
        print("找不到 Chrome / Edge —— 这次浏览器验收没有真正执行，退出码 77（不当作通过）。")
        print("装一个 Chrome 或 Edge，或者设环境变量 STUDY_CHROME 指向浏览器可执行文件后重跑。")
        return SKIP_EXIT
    if requests.get(BASE + "/api/register/info", timeout=10).status_code != 200:
        print("服务没在跑，先启动服务")
        return 2
    user, pw = make_account()
    admin_user, admin_pw = make_account("verifyadm_e2e_")
    su = requests.Session()
    r = su.post(BASE + "/api/login", json={"username": user, "password": pw}, timeout=30)
    if not r.ok:
        raise SystemExit("登录测试账号失败：" + r.text[:200])
    fb = su.post(BASE + "/api/feedback",
                 json={"kind": "suggestion", "content": "浏览器验收：求回复", "page": "#/me"}, timeout=30).json()
    fb_id = fb.get("id")
    if not fb_id:
        raise SystemExit("创建测试反馈失败：" + str(fb)[:200])
    db_exec("UPDATE users SET is_admin=1 WHERE username=?", (admin_user,))
    # 管理员的资料库规模：用于验证普通账号首页不泄露它（实时取，不写死数字）
    admin_su = requests.Session()
    admin_su.post(BASE + "/api/login", json={"username": admin_user, "password": admin_pw}, timeout=30)
    _ov = admin_su.get(BASE + "/api/overview", timeout=30).json()
    size_tokens = [str(_ov["totals"]["files"]), str(_ov["totals"]["bytes"])]

    server = http.server.ThreadingHTTPServer(("127.0.0.1", RESULT_PORT), Collector)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fake = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), FakeModel)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    leak_tokens = config.webbuild_forbidden() + [config.SOURCE_ROOT.name]
    page = (DRIVER_TEMPLATE.replace("__USER__", user).replace("__PW__", pw)
            .replace("__ADMIN__", admin_user).replace("__ADMINPW__", admin_pw)
            .replace("__RP__", str(RESULT_PORT)).replace("__FK__", str(FAKE_PORT))
            .replace("__LEAKTOKENS__", json.dumps(leak_tokens, ensure_ascii=False))
            .replace("__SIZETOKENS__", json.dumps(size_tokens, ensure_ascii=False))
            .replace("__FBID__", str(fb_id)))
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
        if not done.wait(300):
            print("  超时前的进度：" + str(len(PROGRESS)) + " 条", flush=True)
            check("浏览器验收跑完", False, "超时")
        else:
            for line in json.loads(result["body"])["lines"]:
                if line.startswith("ERROR:"):
                    check("浏览器验收跑完", False, line)
                elif ":" in line:
                    name, value = line.split(":", 1)
                    check(name, value == "ok", value)
        check("假模型真的被调用了两次以上", len(FAKE_CALLS) >= 2, FAKE_CALLS)
    finally:
        if proc is not None:
            # /T 连子进程一起杀，否则残留的 renderer 会一直占着 profile 目录。
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            time.sleep(1)
            if proc.poll() is None:
                proc.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)
        db_exec("DELETE FROM feedback WHERE id=?", (fb_id,))
        server.shutdown()
        fake.shutdown()
        if target.exists():
            target.unlink()

    print("\npassed " + str(len(PASS)) + ", failed " + str(len(FAIL)))
    for name in FAIL:
        print("  FAILED: " + name)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())