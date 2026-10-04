/* 学习网页前端：原生 JS，无构建步骤，改完刷新即可。 */
(function () {
  'use strict';

  var LOCAL = window.STUDY_MODE === 'local';
  var LOCAL_ID_BASE = 900000000;

  function isLocalId(id) { return Number(id) >= LOCAL_ID_BASE; }

  var state = {
    user: null,
    overview: null,
    sel: {},
    indexTimer: null,
    quizAnswers: {},
    loginMode: 'login',
    modelSubject: '', modelId: '', modelTime: 0, modelPlaying: true, modelSpeed: 1,
    modelParams: {}, modelRaf: null, askDeep: false, customCat: '', regInfo: null,
    allowSharedAi: null,
    hasOwnAi: null,
    upTarget: 'browser'
  };

  // ---------- 基础工具 ----------
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(id) { return document.getElementById(id); }

  function toast(msg, isErr) {
    var box = el('toast');
    var node = document.createElement('div');
    node.className = 'toast' + (isErr ? ' err' : '');
    node.textContent = msg;
    box.appendChild(node);
    setTimeout(function () { if (node.parentNode) { node.parentNode.removeChild(node); } }, isErr ? 6000 : 2600);
  }

  // 普通账号用的是“浏览器模式”：他自己上传的文件、笔记、收藏、做题记录和 AI
  // 全都在他自己的浏览器里，服务器不存，也不消耗网站主人的额度。这些请求交给 store.js 的
  // 浏览器实现；服务器只管登录、注册这些账号功能。
  var SERVER_ONLY_PATHS = ['/api/me', '/api/login', '/api/logout', '/api/register',
                           '/api/register/info', '/api/upload'];
  // 这几个永远走浏览器：普通账号的 AI 密钥、自定义动画、自己的索引状态都在他自己的浏览器里。
  var BROWSER_LOCAL_PATHS = ['/api/settings/ai', '/api/settings/ai/test', '/api/models/custom',
                             '/api/index/status', '/api/index/control', '/api/selftest',
                             '/api/collect/info', '/api/collect/config', '/api/collect/test',
                             '/api/collect/search', '/api/collect/preview', '/api/collect/url',
                             '/api/collect/topic', '/api/collect/note'];
  // 这几个要看用户有没有在自己浏览器里配好密钥：配了就自己直连模型，没配就用站点统一配置的。
  var BROWSER_OWN_KEY_PATHS = ['/api/ask', '/api/models/generate'];

  function isBrowserUser() {
    if (LOCAL) { return true; }
    return !!(state.user && !state.user.is_admin);
  }

  function shouldUseLocal(path) {
    if (LOCAL) { return true; }
    if (!state.user || state.user.is_admin) { return false; }
    var raw = String(path).split('?')[0];
    var i;
    for (i = 0; i < SERVER_ONLY_PATHS.length; i++) {
      if (raw === SERVER_ONLY_PATHS[i] || raw.indexOf(SERVER_ONLY_PATHS[i] + '/') === 0) { return false; }
    }
    var m = raw.match(/^\/api\/[a-z\-]+\/(\d+)(\/|$)/);
    if (m) { return isLocalId(m[1]); }
    if (BROWSER_LOCAL_PATHS.indexOf(raw) >= 0) { return true; }
    if (BROWSER_OWN_KEY_PATHS.indexOf(raw) >= 0) { return state.hasOwnAi === true; }
    return false;
  }

  function api(path, options) {
    var opt = options || {};
    if (window.studyLocalApi && shouldUseLocal(path)) {
      return window.studyLocalApi(path, opt);
    }
    if (opt.json !== undefined) {
      opt.method = opt.method || 'POST';
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(opt.json);
    }
    opt.credentials = 'same-origin';
    return fetch(path, opt).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          var err = new Error(data.error || ('请求失败（' + res.status + '）'));
          err.status = res.status;
          err.payload = data;
          throw err;
        }
        return withBrowserItems(path, data);
      });
    }).catch(function (err) {
      // 服务器明确回了错误码：原样抛出去，让调用方看到具体原因。
      if (err && err.status) { throw err; }
      // fetch 本身失败 = 连不上服务（服务没启动 / 断网）。别说英文的 "Failed to fetch"。
      var down = new Error('连接不上服务器：学习网页的服务可能没有在运行，或者网络断了。请先双击「启动.bat」把服务起来，再刷新页面。');
      down.network = true;
      throw down;
    });
  }

  // 非管理员上传的文件存在他自己浏览器里，列表要和服务器的资料合在一起显示。
  function withBrowserItems(path, data) {
    if (!window.StudyStore) { return data; }
    // 管理员的资料库在服务器上，overview/materials/dashboard 不回填浏览器里的东西；
    // 但搜索必须回填：文件夹模式里的资料只在他自己的浏览器里，不回填永远搜不到。
    if (state.user && state.user.is_admin && path.indexOf('/api/search') !== 0) { return data; }
    if (path.indexOf('/api/overview') === 0) {
      return window.StudyStore.list().then(function (docs) {
        // 首页只反映“他自己浏览器里的资料”，不显示别人资料库的规模和路径。
        data.index = {
          running: false, paused: false, phase: 'idle', current: null,
          total: docs.length,
          indexed: docs.filter(function (d) { return d.has_text; }).length,
          text_pending: 0,
          vision_pending: docs.filter(function (d) {
            return !d.has_text && (d.kind === 'image' || d.kind === 'pdf');
          }).length,
          failed: 0, done: 0, last_error: '', last_finished: '', local: true
        };
        data.source = { root: '' };
        if (!docs.length) { return data; }
        var subs = {};
        (data.subjects || []).forEach(function (s) { subs[s.name] = s; });
        var kinds = data.kind_counts || {};
        var bytes = (data.totals && data.totals.bytes) || 0;
        docs.forEach(function (d) {
          if (!subs[d.subject]) { subs[d.subject] = { name: d.subject, count: 0, bytes: 0 }; }
          subs[d.subject].count++;
          subs[d.subject].bytes += Number(d.size || 0);
          kinds[d.kind] = (kinds[d.kind] || 0) + 1;
          bytes += Number(d.size || 0);
        });
        data.subjects = Object.keys(subs).map(function (k) { return subs[k]; });
        data.kind_counts = kinds;
        data.recent = docs.slice(0, 12).concat(data.recent || []).slice(0, 12);
        data.totals = {
          files: ((data.totals && data.totals.files) || 0) + docs.length,
          bytes: bytes, bytes_label: window.StudyStore.humanSize(bytes)
        };
        return data;
      });
    }
    if (path.indexOf('/api/materials') === 0) {
      return window.StudyStore.list().then(function (docs) {
        function param(name) {
          var m = path.match(new RegExp('[?&]' + name + '=([^&]*)'));
          return m ? decodeURIComponent(m[1]) : '';
        }
        var q = param('q').toLowerCase();
        var subject = param('subject');
        var kind = param('kind');
        var extra = docs.filter(function (d) {
          if (subject && d.subject !== subject) { return false; }
          if (kind && d.kind !== kind) { return false; }
          if (q && String(d.name).toLowerCase().indexOf(q) < 0) { return false; }
          return true;
        });
        data.items = extra.concat(data.items || []);
        return data;
      });
    }
    if (path.indexOf('/api/search') === 0) {
      var mq = path.match(/[?&]q=([^&]*)/);
      if (!mq) { return data; }
      return window.StudyStore.search(decodeURIComponent(mq[1]), 60).then(function (hits) {
        // 服务器已经有的同一份资料只留一条（文件夹指向的目录可能和服务器索引的是同一个）。
        var seen = {};
        (data.hits || []).forEach(function (h) { seen[String(h.name) + '|' + String(h.subject)] = true; });
        var extra = (hits || []).filter(function (h) {
          return keepLocalHit(h) && !seen[String(h.name) + '|' + String(h.subject)];
        });
        data.hits = (data.hits || []).concat(extra);
        return data;
      });
    }
    if (path.indexOf('/api/me/dashboard') === 0) {
      return window.StudyStore.list().then(function (docs) {
        var notes = docs.filter(function (d) { return String(d.note || '').trim(); }).map(function (d) {
          return { material_id: d.id, name: d.name, subject: d.subject, kind: d.kind,
                   content: d.note, updated_at: d.created_at };
        });
        data.notes = (data.notes || []).concat(notes);
        data.favorites = docs.filter(function (d) { return d.fav; }).concat(data.favorites || []);
        return data;
      });
    }
    return data;
  }

  function md(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var inList = false;
    function inline(s) {
      var t = esc(s);
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      return t;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false; } continue; }
      var m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        if (inList) { out.push('</ul>'); inList = false; }
        var lv = Math.min(6, m[1].length + 1);
        out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
        continue;
      }
      m = line.match(/^\s*[-*+]\s+(.*)$/);
      if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
      m = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<p>' + inline(line) + '</p>');
    }
    if (inList) { out.push('</ul>'); }
    return out.join('');
  }

  function hl(snippet) {
    var s = esc(snippet).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');
    return s;
  }

  function kindBadge(kind, label) {
    return '<span class="badge">' + esc(label || kind) + '</span>';
  }

  function stateBadge(item) {
    if (item.has_text) { return '<span class="badge ok">已索引</span>'; }
    // 源文件本身读不出来（空的 / 格式不对 / 文件损坏）：鼠标停在徽标上能看到具体原因。
    // 这类文件重试也没用，所以跟「失败」分开显示。
    if (item.text_state === 'unreadable' || item.vision_state === 'unreadable') {
      var why = item.text_note || item.vision_note || '源文件本身读不出来';
      return '<span class="badge bad" title="' + esc(why) + '">无法解析</span>';
    }
    if (item.kind === 'image') { return '<span class="badge warn">待识别</span>'; }
    if (item.text_state === 'failed' || item.vision_state === 'failed') { return '<span class="badge bad">失败</span>'; }
    if (item.kind === 'web') { return '<span class="badge ok">可运行</span>'; }
    if (item.kind === 'video' || item.kind === 'audio' || item.kind === 'archive') { return ''; }
    return '<span class="badge warn">待处理</span>';
  }

  // ---------- 顶栏 ----------
  function renderTop() {
    var bar = el('topbar');
    if (!state.user) { bar.innerHTML = ''; return; }
    var hash = location.hash || '#/';
    function nav(href, text) {
      var on = hash.indexOf(href) === 0 ? ' on' : '';
      return '<a class="nav' + on + '" href="' + href + '">' + text + '</a>';
    }
    var selCount = Object.keys(state.sel).length;
    bar.innerHTML =
      '<div class="bar">' +
        '<span class="brand">' + esc(siteName()) + '</span>' +
        nav('#/', '首页') +
        nav('#/search', '搜索') +
        nav('#/ask', 'AI 问答') +
        (LOCAL ? '' : nav('#/qa', '答疑')) +
        nav('#/collect', '收集') +
        nav('#/models', '模型动画') +
        nav('#/upload', '上传') +
        nav('#/folder', '文件夹') +
        nav('#/export', '导出' + (selCount ? '（' + selCount + '）' : '')) +
        ((LOCAL || !state.user.is_admin) ? '' : nav('#/index', '索引进度')) +
        nav('#/appearance', '外观') +
        nav('#/me', '我的') +
        ((state.user.is_admin && !LOCAL) ? '<a class="nav" href="/admin">管理端</a>' : '') +
        '<span class="spacer"></span>' +
        '<span class="who">' + (LOCAL ? '本机模式：文件只存在你自己的浏览器里'
          : esc(state.user.username) + (state.user.is_admin ? '（管理员）' : '（文件存在你自己的浏览器里）')) + '</span>' +
        '<button class="btn small" id="btnPrint" title="把当前页面打印或另存为 PDF">打印</button>' +
        (LOCAL ? '' : '<button class="btn small" id="btnLogout">退出</button>') +
      '</div>';
    var bar2 = el('tabbar');
    if (bar2) {
      function tab(href, icon, text) {
        var on = hash.indexOf(href) === 0 ? ' on' : '';
        return '<a class="' + (on ? 'on' : '') + '" href="' + href + '"><b>' + icon + '</b>' + text + '</a>';
      }
      bar2.innerHTML = tab('#/', '🏠', '首页') + tab('#/search', '🔍', '搜索') +
        tab('#/ask', '🤖', '问答') + tab('#/folder', '📁', '文件夹') +
        tab('#/me', '👤', '我的');
    }
    if (el('btnPrint')) {
      el('btnPrint').onclick = function () { window.print(); };
    }
    if (el('btnLogout')) {
      el('btnLogout').onclick = function () {
        api('/api/logout', { json: {} }).then(function () {
          state.user = null; location.hash = '#/'; location.reload();
        });
      };
    }
  }

  // ---------- 登录 ----------
  function renderLogin(keepValues) {
    var isLogin = state.loginMode === 'login';
    // 匿名访问时 /api/me 返回的是 200（user 为 null），所以注册方式必须单独拉一次，
    // 否则「需要邀请码」这个开关永远读不到，邀请码输入框就不会出现。
    if (!LOCAL && state.regInfo === null) {
      state.regInfo = { pending: true };
      api('/api/register/info').then(function (d) {
        state.regInfo = d || {};
        if (!state.user) { renderLogin(true); }
      }).catch(function () { state.regInfo = {}; });
    }
    var info = state.regInfo || {};
    var keepName = '', keepPass = '', keepInvite = '', keepFocus = '';
    if (keepValues) {
      if (el('uName')) { keepName = el('uName').value; }
      if (el('uPass')) { keepPass = el('uPass').value; }
      if (el('uInvite')) { keepInvite = el('uInvite').value; }
      keepFocus = (document.activeElement && document.activeElement.id) || '';
    }
    if (state.loginMode === 'reset') { renderResetCard(); return; }
    var siteName = (info.site && info.site.name) || '我的资料库';
    var inviteField = (!isLogin && info.need_invite)
      ? '<div class="field invite-field"><input type="text" id="uInvite" placeholder="邀请码（向管理员要）" autocomplete="off" style="text-transform:uppercase"></div>'
      : '';
    var rememberField = isLogin
      ? '<label class="muted small" style="display:flex;gap:6px;align-items:center;margin-top:4px">'
        + '<input type="checkbox" id="uRemember" checked> 记住我（下次打开不用重新登录）</label>'
      : '';
    var hint;
    if (isLogin) {
      hint = '还没有账号？点上面的“注册”。';
    } else if (info.pending) {
      hint = '正在读取注册信息…';
    } else if (info.first_account) {
      hint = '你是这个网站的第一个账号，注册后自动成为管理员，不需要邀请码。用户名 2-20 个字符，密码至少 6 位。';
    } else if (info.need_invite) {
      hint = '这个网站需要邀请码才能注册（向上面的输入框填入）。用户名 2-20 个字符，密码至少 6 位。';
    } else {
      hint = '这个网站开放注册。用户名 2-20 个字符，密码至少 6 位。';
    }
    el('topbar').innerHTML = '';
    el('app').innerHTML =
      '<div class="overlay login-page">' +
        '<div class="lp-bg" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><span class="lp-spin"></span><span class="lp-dust"></span><span class="lp-grid"></span></div>' +
        '<div class="card login">' +
          '<div class="login-head">' +
            '<div class="login-mark" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M12 7.2C10.5 5.5 8.3 4.6 5.6 4.6H3.4v13.2h2.2c2.5 0 4.6.8 6.4 2.3 1.8-1.5 3.9-2.3 6.4-2.3h2.2V4.6h-2.2C15.7 4.6 13.5 5.5 12 7.2z"/>' +
              '<path d="M12 7.2v12.9"/></svg>' +
            '</div>' +
            '<div class="login-title">' +
              '<h1>' + esc(siteName) + '</h1>' +
              '<p class="muted small">把资料放进一个能搜索、能提问、能整理的地方。</p>' +
            '</div>' +
          '</div>' +
          '<div class="tabs">' +
            '<button id="tabLogin" class="' + (isLogin ? 'on' : '') + '">登录</button>' +
            '<button id="tabReg" class="' + (isLogin ? '' : 'on') + '">注册</button>' +
          '</div>' +
          '<div class="field"><input type="text" id="uName" placeholder="用户名" autocomplete="username"></div>' +
          '<div class="field pw-wrap"><input type="password" id="uPass" placeholder="密码" autocomplete="'
            + (isLogin ? 'current-password' : 'new-password') + '">' +
            '<button type="button" class="pw-eye" id="pwEye" aria-label="显示或隐藏密码" title="显示 / 隐藏密码">显示</button></div>' +
          inviteField +
          rememberField +
          '<div class="row" style="margin-top:14px">' +
            '<button class="btn primary" id="btnGo" style="flex:1">' + (isLogin ? '登录' : '注册并进入') + '</button>' +
          '</div>' +
          '<p class="muted small" style="margin-top:10px">' + esc(hint) +
            (isLogin ? '　<a href="javascript:void(0)" id="lnkForgot">忘记密码</a>' : '') + '</p>' +
        '</div>' +
      '</div>';
    if (keepName) { el('uName').value = keepName; }
    if (keepPass) { el('uPass').value = keepPass; }
    if (keepInvite && el('uInvite')) { el('uInvite').value = keepInvite; }
    if (keepFocus && el(keepFocus)) { el(keepFocus).focus(); }
    el('tabLogin').onclick = function () { state.loginMode = 'login'; renderLogin(); };
    el('tabReg').onclick = function () { state.loginMode = 'register'; renderLogin(); };
    if (el('lnkForgot')) {
      el('lnkForgot').onclick = function () { state.loginMode = 'reset'; renderLogin(); };
    }
    el('btnGo').onclick = function () { doAuth(isLogin ? '/api/login' : '/api/register'); };
    el('pwEye').onclick = function () {
      var box = el('uPass');
      box.type = (box.type === 'password') ? 'text' : 'password';
      el('pwEye').textContent = (box.type === 'password') ? '显示' : '隐藏';
      box.focus();
    };
    el('uName').onkeydown = function (ev) { if (ev.key === 'Enter') { el('uPass').focus(); } };
    el('uPass').onkeydown = function (ev) { if (ev.key === 'Enter') { doAuth(isLogin ? '/api/login' : '/api/register'); } };
    if (el('uInvite')) {
      el('uInvite').onkeydown = function (ev) { if (ev.key === 'Enter') { doAuth('/api/register'); } };
    }
  }

  // 忘记密码：管理员在「账号管理」点「重置码」生成一次性码，这里用它换新密码。
  function renderResetCard() {
    el('topbar').innerHTML = '';
    el('app').innerHTML =
      '<div class="overlay login-page">' +
        '<div class="lp-bg" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><span class="lp-spin"></span><span class="lp-dust"></span><span class="lp-grid"></span></div>' +
        '<div class="card login">' +
          '<div class="login-head">' +
            '<div class="login-title"><h1>重置密码</h1>' +
              '<p class="muted small">用管理员给你的一次性重置码，给自己设一个新密码。</p></div>' +
          '</div>' +
          '<div class="field"><input type="text" id="rName" placeholder="用户名" autocomplete="username"></div>' +
          '<div class="field"><input type="text" id="rCode" placeholder="一次性重置码（8 位）" autocomplete="off" style="text-transform:uppercase"></div>' +
          '<div class="field pw-wrap"><input type="password" id="rPass" placeholder="新密码（至少 6 位）" autocomplete="new-password">' +
            '<button type="button" class="pw-eye" id="rEye">显示</button></div>' +
          '<div class="row" style="margin-top:14px">' +
            '<button class="btn primary" id="rGo" style="flex:1">设成新密码</button>' +
          '</div>' +
          '<p class="muted small" style="margin-top:10px">重置码 15 分钟内有效、只能用一次。没有码就找管理员要一个。' +
            '　<a href="javascript:void(0)" id="rBack">返回登录</a></p>' +
        '</div>' +
      '</div>';
    el('rEye').onclick = function () {
      var box = el('rPass');
      box.type = (box.type === 'password') ? 'text' : 'password';
      el('rEye').textContent = (box.type === 'password') ? '显示' : '隐藏';
    };
    el('rBack').onclick = function () { state.loginMode = 'login'; renderLogin(); };
    function submit() {
      var username = (el('rName').value || '').trim();
      var code = (el('rCode').value || '').trim();
      var password = el('rPass').value || '';
      if (!username || !code || !password) { toast('用户名、重置码、新密码都要填', true); return; }
      el('rGo').disabled = true;
      el('rGo').textContent = '正在设置…';
      api('/api/auth/reset', { json: { username: username, code: code, password: password } })
        .then(function (r) {
          state.loginMode = 'login';
          renderLogin();
          if (el('uName')) { el('uName').value = r.username || username; }
          if (el('uPass')) { el('uPass').focus(); }
          toast('密码已改，用新密码登录');
        })
        .catch(function (e) {
          toast(e.message, true);
          el('rGo').disabled = false;
          el('rGo').textContent = '设成新密码';
        });
    }
    el('rGo').onclick = submit;
    el('rPass').onkeydown = function (ev) { if (ev.key === 'Enter') { submit(); } };
  }

  function doAuth(path) {
    var username = (el('uName').value || '').trim();
    var password = el('uPass').value || '';
    if (!username || !password) { toast('请填写用户名和密码', true); return; }
    var payload = { username: username, password: password };
    if (path === '/api/register' && el('uInvite')) { payload.invite = el('uInvite').value; }
    if (path === '/api/login' && el('uRemember')) { payload.remember = !!el('uRemember').checked; }
    api(path, { json: payload })
      .then(function (data) {
        state.user = data.user;
        // 登录后可能连渲染两次（改 hash 会触发 hashchange），给 0.9 秒窗口，窗口内的首屏都带动画。
        state.enterUntil = Date.now() + 900;
        setTimeout(function () { state.enterUntil = 0; }, 900);
        toast(path === '/api/login' ? '登录成功' : '注册成功，欢迎');
        location.hash = '#/';
        boot();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  // 登录成功后的第一屏：从下方 20px 滑入 + 淡入。
  function playEnter() {
    if (!state.enterUntil || Date.now() > state.enterUntil) { return; }
    var box = el('app');
    var node = box && box.firstElementChild;
    if (node && node.classList) { node.classList.add('page-enter'); }
  }

  // ---------- 首页 ----------
  function viewHome() {
    el('app').innerHTML = '<div class="loading">正在读取资料库…</div>';
    api('/api/overview').then(function (data) {
      state.overview = data;
      if (data.allow_shared_ai !== undefined) { state.allowSharedAi = data.allow_shared_ai; }
      var subs = data.subjects.map(function (s) {
        return '<a class="sub" href="#/s/' + encodeURIComponent(s.name) + '">' +
          '<div class="n">' + esc(s.name) + '</div>' +
          '<div class="c">' + s.count + ' 个文件</div></a>';
      }).join('');
      var recent = data.recent.map(function (item) { return itemCard(item, true); }).join('');
      var cont = data.continue && data.continue.length
        ? '<div class="card"><h2>继续学习</h2><div class="grid g-card">' + data.continue.map(function (i) { return itemCard(i, true); }).join('') + '</div></div>'
        : '';
      var idx = data.index;
      var rootCount = ((data.source && data.source.roots) || []).length;
      var srcLabel = esc((data.source && data.source.root) || '') +
        (rootCount > 1 ? ('<span class="muted"> 等 ' + rootCount + ' 个目录</span>') : '');
      var announce = (data.site && data.site.announcement)
        ? '<div class="card"><b>公告</b><p class="muted small" style="margin:6px 0 0">' + esc(data.site.announcement) + '</p></div>'
        : '';
      el('app').innerHTML =
        '<div class="wrap">' +
          announce +
          '<div class="card">' +
            '<h1>资料库总览</h1>' +
            '<p class="muted small">' + (data.is_admin
              ? ('来源：' + srcLabel + '　·　共 ' + data.totals.files + ' 个文件，' + esc(data.totals.bytes_label))
              : ('你自己的资料库　·　共 ' + data.totals.files + ' 个文件，' + esc(data.totals.bytes_label))) + '</p>' +
            (data.is_admin
              ? '<div class="grid g-stat" style="margin-top:12px">' +
                  statBox('已建立索引', idx.indexed + ' / ' + idx.total, '有文字内容可搜索') +
                  statBox('待提取文字', idx.text_pending, '文字型文件排队中') +
                  statBox('待看图识别', idx.vision_pending, '扫描件与图片排队中') +
                  statBox('处理失败', idx.failed, idx.failed ? '可在索引进度页重试' : '一切正常') +
                '</div>'
              : '<div class="grid g-stat" style="margin-top:12px">' +
                  statBox('我的文件', data.totals.files, '只存在你自己的浏览器里') +
                  statBox('可以搜索', idx.indexed + ' / ' + idx.total, '有文字内容的资料') +
                  statBox('待看图识别', idx.vision_pending, '图片和扫描件') +
                  statBox('占用空间', data.totals.bytes_label, '浏览器给的空间') +
                '</div>') +
          '</div>' +
          '<div class="card"><h2>按分类浏览</h2>' + (subs ? '<div class="grid g-sub">' + subs + '</div>' : '<p class="muted">当前账号看不到任何资料。<br>资料默认<b>只有本人可见</b>：' + (data.is_admin ? '你是管理员，可以到「索引进度」做一次重新扫描。' : '其他账号上传或共享给你的资料才会出现在这里。') + '</p>') + '</div>' +
          cont +
          '<div class="card"><h2>最近加入</h2><div class="grid g-card">' + recent + '</div></div>' +
        '</div>';
      if (idx.text_pending || idx.vision_pending) { startIndexPolling(); }
      playEnter();
    }).catch(function (err) {
      el('app').innerHTML = '<div class="wrap"><div class="card">读取失败：' + esc(err.message) + '</div></div>';
    });
  }

  function statBox(title, value, hint) {
    return '<div class="sub"><div class="c">' + esc(title) + '</div>' +
      '<div class="n" style="font-size:22px">' + esc(value) + '</div>' +
      '<div class="c small">' + esc(hint) + '</div></div>';
  }

  function itemCard(item, withPick) {
    var thumb = ((item.kind === 'image' || item.kind === 'pdf') && !isLocalId(item.id))
      ? '<img loading="lazy" src="/api/thumb/' + item.id + '" alt="">'
      : '<span class="muted small">' + esc(item.kind_label) + '</span>';
    var pick = '';
    if (withPick) {
      pick = '<span class="pick"><input type="checkbox" data-pick="' + item.id + '"' + (state.sel[item.id] ? ' checked' : '') + '>选择</span>';
    }
    return '<div class="item">' +
      '<a class="thumb" href="#/m/' + item.id + '">' + pick + thumb + '</a>' +
      '<div class="body">' +
        '<a class="name" href="#/m/' + item.id + '">' + esc(item.name) + '</a>' +
        '<div class="meta">' + kindBadge(item.kind, item.kind_label) + stateBadge(item) + '<span>' + esc(item.size_label) + '</span>' + (item.mine && !item.shared ? '<span class="badge">仅自己可见</span>' : '') + '</div>' +
      '</div></div>';
  }

  // ---------- 分类页 ----------
  function viewSubject(name, query) {
    var kind = (query && query.kind) || '';
    var sort = (query && query.sort) || 'name';
    var q = (query && query.q) || '';
    el('app').innerHTML = '<div class="loading">正在读取…</div>';
    var params = '?subject=' + encodeURIComponent(name) + '&kind=' + encodeURIComponent(kind) +
      '&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(q) + '&limit=300';
    api('/api/materials' + params).then(function (data) {
      var kinds = ['', 'pdf', 'word', 'ppt', 'excel', 'image', 'video', 'web', 'audio', 'text', 'archive', 'other'];
      var labels = { '': '全部', pdf: 'PDF', word: '文档', ppt: '演示文稿', excel: '表格', image: '图片', video: '视频', audio: '音频', text: '文本', web: '网页', archive: '压缩包', other: '其他' };
      var chips = kinds.map(function (k) {
        var on = k === kind ? ' primary' : '';
        return '<a class="btn small' + on + '" href="#/s/' + encodeURIComponent(name) + '?kind=' + k + '&sort=' + sort + '">' + labels[k] + '</a>';
      }).join(' ');
      var sorts = '<a class="btn small' + (sort === 'name' ? ' primary' : '') + '" href="#/s/' + encodeURIComponent(name) + '?kind=' + kind + '&sort=name">按名称</a> ' +
        '<a class="btn small' + (sort === 'size' ? ' primary' : '') + '" href="#/s/' + encodeURIComponent(name) + '?kind=' + kind + '&sort=size">按大小</a> ' +
        '<a class="btn small' + (sort === 'new' ? ' primary' : '') + '" href="#/s/' + encodeURIComponent(name) + '?kind=' + kind + '&sort=new">最新</a>';
      var items = data.items.map(function (i) { return itemCard(i, true); }).join('');
      el('app').innerHTML =
        '<div class="wrap">' +
          '<div class="card">' +
            '<h1>' + esc(name) + '</h1>' +
            '<p class="muted small">共 ' + data.items.length + ' 个文件</p>' +
            '<div class="row" style="margin-top:10px"><input type="search" id="subQ" placeholder="在这个分类里搜文件名" value="' + esc(q) + '" style="min-width:220px">' +
            '<button class="btn small" id="subQBtn">搜索</button>' +
            '<span class="spacer"></span>' + sorts + '</div>' +
            '<div class="row" style="margin-top:8px">' + chips + '</div>' +
            '<div class="row" style="margin-top:8px">' +
              '<button class="btn small" id="pickAll">全选本页</button>' +
              '<button class="btn small" id="pickNone">清空选择</button>' +
              '<a class="btn small primary" href="#/export">去导出</a>' +
            '</div>' +
          '</div>' +
          '<div class="grid g-card">' + items + '</div>' +
        '</div>';
      el('subQBtn').onclick = function () {
        location.hash = '#/s/' + encodeURIComponent(name) + '?kind=' + kind + '&sort=' + sort + '&q=' + encodeURIComponent(el('subQ').value);
      };
      el('subQ').onkeydown = function (ev) { if (ev.key === 'Enter') { el('subQBtn').click(); } };
      el('pickAll').onclick = function () {
        data.items.forEach(function (i) { state.sel[i.id] = true; });
        renderTop(); viewSubject(name, query);
      };
      el('pickNone').onclick = function () { state.sel = {}; renderTop(); viewSubject(name, query); };
    }).catch(function (err) {
      el('app').innerHTML = '<div class="wrap"><div class="card">读取失败：' + esc(err.message) + '</div></div>';
    });
  }

  // ---------- 资料详情 ----------
  function viewMaterial(id) {
    el('app').innerHTML = '<div class="loading">正在读取…</div>';
    var localFile = isLocalId(id);
    var fileUrlPromise = localFile ? window.StudyStore.objectUrl(id) : Promise.resolve('');
    var webHtmlPromise = localFile
      ? window.StudyStore.blob(id).then(function (b) { return b ? b.text() : ''; })
      : Promise.resolve('');
    Promise.all([api('/api/material/' + id), fileUrlPromise, webHtmlPromise]).then(function (res) {
      var data = res[0];
      var webHtml = res[2] || '';
      var item = data.item;
      var fileUrl = res[1] || ('/api/file/' + item.id);
      var viewer = '';
      if (item.kind === 'image') {
        viewer = '<div class="viewer"><img src="' + fileUrl + '" alt=""></div>';
      } else if (item.kind === 'pdf') {
        viewer = '<iframe class="pdf" src="' + fileUrl + '"></iframe>';
      } else if (item.kind === 'video') {
        viewer = '<div class="viewer"><video id="vid" controls src="' + fileUrl + '" data-pos="' + (data.position || 0) + '"></video></div>';
      } else if (item.kind === 'web') {
        if (localFile) {
          viewer = '<div class="webbox"><iframe class="webpage" sandbox="allow-scripts allow-downloads allow-pointer-lock" srcdoc="' + esc(webHtml) + '"></iframe></div>' +
            '<div class="row" style="margin-top:8px"><span class="muted small">网页/模型动画在安全沙箱里运行，读不到你浏览器里的其它数据。</span></div>';
        } else {
          viewer = '<div class="webbox"><iframe class="webpage" sandbox="allow-scripts allow-downloads allow-pointer-lock" src="/api/material/' + item.id + '/page"></iframe></div>' +
            '<div class="row" style="margin-top:8px">' +
            '<a class="btn small" href="/api/material/' + item.id + '/page" target="_blank" rel="noopener">新标签页打开</a>' +
            '<span class="muted small">网页/模型动画在安全沙箱里运行，它读不到你的账号信息。</span></div>';
        }
      } else if (item.kind === 'audio') {
        viewer = '<audio controls style="width:100%" src="' + fileUrl + '"></audio>';
      }
      var texts = data.texts.map(function (t) {
        return '<details style="margin:8px 0"><summary class="muted small">' +
          (t.origin === 'vision' ? 'AI 识别' : '自动提取') + ' · 第 ' + t.page + ' 页</summary>' +
          '<pre class="text">' + esc(t.content) + '</pre></details>';
      }).join('');
      var attempts = data.attempts.map(function (a) {
        return '<tr><td>' + esc(a.created_at) + '</td><td>' + a.score + ' / ' + a.total + '</td></tr>';
      }).join('');
      el('app').innerHTML =
        '<div class="wrap">' +
          '<div class="card">' +
            '<h1>' + esc(item.name) + '</h1>' +
            '<div class="row" style="margin:8px 0">' + kindBadge(item.kind, item.kind_label) +
              '<span class="badge">' + esc(item.subject) + '</span>' +
              '<span class="badge">' + esc(item.size_label) + '</span>' + stateBadge(item) + '<span class="badge">' + (item.shared ? '已共享' : '仅自己可见') + '</span>' +
              (item.pages ? '<span class="badge">' + item.pages + ' 页</span>' : '') + '</div>' +
            '<div class="row">' +
              '<a class="btn small" href="' + fileUrl + '" download="' + esc(item.name) + '">下载原文件</a>' +
              '<button class="btn small" id="btnFav">' + (item.fav ? '★ 已收藏' : '☆ 收藏') + '</button>' +
              ((item.mine && !localFile) ? '<button class="btn small" id="btnVis">' + (item.shared ? '取消共享' : '共享给其他账号') + '</button>' : '') +
              '<button class="btn small" id="btnReindex">重新提取文字</button>' +
              (item.kind === 'image' || item.kind === 'pdf' ? '<button class="btn small" id="btnVision">AI 识别文字</button>' : '') +
              '<button class="btn small primary" id="btnSummary">生成 AI 笔记</button>' +
              '<button class="btn small primary" id="btnQuiz">出练习题</button>' +
              '<button class="btn small" id="btnNotes">总结打印版</button>' +
              (localFile ? '' : '<a class="btn small" id="linkMd" href="/api/material/' + item.id + '/summary.md">下载 Markdown</a>') +
            '</div>' +
          '</div>' +
          (viewer ? '<div class="card">' + viewer + '</div>' : '') +
          '<div class="card"><h2>AI 学习笔记</h2><div id="summaryBox" class="md">' +
            (data.summary ? md(data.summary) : '<p class="muted">还没有生成。点上面的“生成 AI 笔记”。</p>') + '</div></div>' +
          '<div class="card"><h2>练习题</h2><div id="quizBox">' + renderQuiz(data.quiz) + '</div>' +
            (attempts ? '<h3>最近成绩</h3><table><thead><tr><th>时间</th><th>得分</th></tr></thead><tbody>' + attempts + '</tbody></table>' : '') +
          '</div>' +
          '<div class="card"><h2>资料原文</h2>' + (texts || '<p class="muted">还没有提取到文字内容。</p>') + '</div>' +
          '<div class="card"><h2>我的笔记</h2>' +
            '<textarea id="noteBox" rows="6" placeholder="在这里记笔记，随时保存">' + esc(data.note) + '</textarea>' +
            '<div class="row" style="margin-top:8px"><button class="btn primary small" id="btnNote">保存笔记</button><span class="muted small" id="noteHint"></span></div>' +
          '</div>' +
        '</div>';
      bindMaterial(id, item, data);
    }).catch(function (err) {
      el('app').innerHTML = '<div class="wrap"><div class="card">读取失败：' + esc(err.message) + '</div></div>';
    });
  }

  function bindMaterial(id, item, data) {
    if (!canUseAi()) {
      ['btnSummary', 'btnQuiz', 'btnVision'].forEach(function (bid) {
        var b = el(bid);
        if (b) { b.disabled = true; b.title = aiLockedMessage(); }
      });
    }
    el('btnFav').onclick = function () {
      api('/api/favorite/' + id, { json: {} }).then(function (r) {
        el('btnFav').textContent = r.fav ? '★ 已收藏' : '☆ 收藏';
        toast(r.fav ? '已加入收藏' : '已取消收藏');
      }).catch(function (e) { toast(e.message, true); });
    };
    el('btnReindex').onclick = function () {
      if (isLocalId(id)) {
        el('btnReindex').disabled = true;
        api('/api/material/' + id + '/index', { json: { mode: 'auto' } })
          .then(function () { toast('已重新提取文字'); viewMaterial(id); })
          .catch(function (e) { toast(e.message, true); el('btnReindex').disabled = false; });
        return;
      }
      api('/api/material/' + id + '/index', { json: { mode: 'auto' } })
        .then(function () { toast('已加入索引队列，稍后刷新查看'); })
        .catch(function (e) { toast(e.message, true); });
    };
    if (el('btnVis')) {
      el('btnVis').onclick = function () {
        var next = !item.shared;
        api('/api/material/' + id + '/visibility', { json: { shared: next } }).then(function (r) {
          toast(r.shared ? '已共享，其他账号可以看到' : '已改为仅自己可见');
          viewMaterial(id);
        }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('btnVision')) {
      el('btnVision').onclick = function () {
        el('btnVision').disabled = true;
        el('btnVision').textContent = '识别中…';
        api('/api/material/' + id + '/index', { json: { mode: 'vision' } })
          .then(function () { toast('开始识别，完成后刷新页面'); })
          .catch(function (e) { toast(e.message, true); el('btnVision').disabled = false; el('btnVision').textContent = 'AI 识别'; });
      };
    }
    el('btnSummary').onclick = function () {
      el('btnSummary').disabled = true;
      el('btnSummary').textContent = '生成中…';
      api('/api/material/' + id + '/summary', { json: {} })
        .then(function (r) { el('summaryBox').innerHTML = md(r.summary); toast('笔记已生成'); })
        .catch(function (e) { toast(e.message, true); })
        .then(function () { el('btnSummary').disabled = false; el('btnSummary').textContent = '生成 AI 笔记'; });
    };
    el('btnQuiz').onclick = function () {
      el('btnQuiz').disabled = true;
      el('btnQuiz').textContent = '出题中…';
      api('/api/material/' + id + '/quiz', { json: {} })
        .then(function (r) { el('quizBox').innerHTML = renderQuiz(r.quiz); bindQuiz(id, r.quiz); toast('练习题已生成'); })
        .catch(function (e) { toast(e.message, true); })
        .then(function () { el('btnQuiz').disabled = false; el('btnQuiz').textContent = '出练习题'; });
    };
    if (el('btnNotes')) {
      el('btnNotes').onclick = function () {
        if (isLocalId(id)) { localPrint(id); return; }
        api('/api/material/' + id + '/notes-export', { json: {} }).then(function (r) {
          window.open('/api/export/' + r.id + '/download', '_blank');
          toast('已生成打印版，在打开的页面里点“打印 / 另存为 PDF”');
        }).catch(function (e) { toast(e.message, true); });
      };
    }
    el('btnNote').onclick = function () {
      api('/api/notes/' + id, { json: { content: el('noteBox').value } })
        .then(function () { el('noteHint').textContent = '已保存'; setTimeout(function () { el('noteHint').textContent = ''; }, 2000); })
        .catch(function (e) { toast(e.message, true); });
    };
    bindQuiz(id, data.quiz);
    var vid = el('vid');
    if (vid) {
      var pos = parseFloat(vid.getAttribute('data-pos') || '0');
      if (pos > 1) { vid.currentTime = pos; }
      var last = 0;
      vid.ontimeupdate = function () {
        var now = Date.now();
        if (now - last < 5000) { return; }
        last = now;
        api('/api/progress/' + id, { json: { position: vid.currentTime } }).catch(function () {});
      };
    }
  }

  function renderQuiz(questions) {
    if (!questions || !questions.length) { return '<p class="muted">还没有练习题。点上面的“出练习题”。</p>'; }
    var html = '';
    for (var i = 0; i < questions.length; i++) { html += quizBlock(questions[i], i); }
    return html + '<div class="row" style="margin-top:12px"><button class="btn primary small" id="quizSubmit">提交并判分</button><span id="quizScore" class="muted small"></span></div>';
  }

  function quizBlock(q, i) {
    var body = '';
    if (q.type === 'choice' && q.options && q.options.length) {
      body = '<div class="opts">';
      for (var j = 0; j < q.options.length; j++) {
        var letter = 'ABCD'.charAt(j) || String(j + 1);
        body += '<label><input type="radio" name="q' + i + '" value="' + esc(letter) + '"> ' + esc(letter) + '. ' + esc(q.options[j]) + '</label>';
      }
      body += '</div>';
    } else {
      body = '<input type="text" class="blank" data-qi="' + i + '" placeholder="填写答案">';
    }
    return '<div class="q" data-answer="' + esc(q.answer) + '">' +
      '<div class="stem">' + (i + 1) + '. ' + esc(q.stem) + '</div>' + body +
      '<div><button class="btn small" data-show="' + i + '">看解析</button></div>' +
      '<div class="explain" id="exp' + i + '">' + md(q.explain) + '</div>' +
      '<div class="res" id="res' + i + '"></div></div>';
  }

  function bindQuiz(id, questions) {
    if (!questions || !questions.length) { return; }
    var btns = document.querySelectorAll('[data-show]');
    for (var k = 0; k < btns.length; k++) {
      btns[k].onclick = function () {
        var box = el('exp' + this.getAttribute('data-show'));
        box.style.display = box.style.display === 'block' ? 'none' : 'block';
      };
    }
    var submit = el('quizSubmit');
    if (!submit) { return; }
    submit.onclick = function () {
      var answers = [];
      for (var i = 0; i < questions.length; i++) {
        var picked = document.querySelector('input[name="q' + i + '"]:checked');
        var blank = document.querySelector('.blank[data-qi="' + i + '"]');
        answers.push(picked ? picked.value : (blank ? blank.value : ''));
      }
      api('/api/material/' + id + '/quiz/submit', { json: { answers: answers } }).then(function (r) {
        el('quizScore').textContent = '得分 ' + r.score + ' / ' + r.total;
        for (var i = 0; i < r.detail.length; i++) {
          var box = el('res' + i);
          box.className = 'res ' + (r.detail[i].ok ? 'ok' : 'no');
          box.textContent = r.detail[i].ok ? '正确' : ('错误，正确答案：' + r.detail[i].answer);
        }
        toast('已记录本次成绩');
      }).catch(function (e) { toast(e.message, true); });
    };
  }

  // 文件夹模式里的文件：id 是 "f:相对路径"，点开是直接打开本地那个文件。
  function isFolderHit(id) { return String(id || '').indexOf('f:') === 0; }

  // 管理员上传的资料在服务器上，他浏览器里剩的多半是别人用同一台电脑时留下的本地资料，
  // 合并进搜索只会变成点不开的链接，所以管理员只合并文件夹里的。
  function keepLocalHit(hit) {
    return !(state.user && state.user.is_admin) || isFolderHit(hit.material_id);
  }

  // 文件夹相关的报错：点“取消”不该弹红条；英文的 DOMException 已在 folder.js 里转成中文。
  // 注意：只有“用户真的点了取消”才说取消。窗口根本没弹出来（内置浏览器常见）时要说真实原因，
  // 否则用户明明点了却没选成，页面还说他取消了——上一轮就是这么误会了一整天。
  function folderToast(e) {
    var cancel = !!(e && e.cancelled) && !(e && e.noDialog);
    if (cancel) {
      toast('没有选中文件夹（弹窗被取消/关掉了）。再点一次：点一下文件夹，再点右下角「选择文件夹」。');
      return;
    }
    toast(String((e && e.message) || e), !(e && e.cancelled));
  }

  // 选文件夹失败的原因要留在页面上：toast 会自己消失，用户想截图或复述时得看得见。
  function showFolderWhy(e) {
    // 选择卡片上有 foWhy，已连接那张卡片上只有 foMsg——哪里有位置就写哪里。
    var box = el('foWhy') || el('foMsg');
    if (!box) { return; }
    // 原始英文（AbortError 之类）只进 data/folder_diag.log 留证，不再糊到用户脸上。
    box.innerHTML = esc(String((e && e.message) || e));
  }

  // 选文件夹失败后：文件夹其实可能已经存下来了（扫描那一步才出错），把真实状态画出来，
  // 别让页面停在“还没有选文件夹”上，看着像白选了。
  function refreshFolderAfterPickFail() {
    var F = window.StudyFolder;
    if (!F || !F.rootInfo) { return; }
    F.rootInfo().then(function (saved) {
      if (saved && saved.handle) { viewFolder(); }
    }).catch(function () {});
  }

  function openFolderRel(rel) {
    var F = window.StudyFolder;
    if (!F) { toast('文件夹模块没加载，Ctrl+F5 强刷一下', true); return Promise.resolve(); }
    return F.fileOf(rel).then(function (file) {
      var url = URL.createObjectURL(file);
      window.open(url, '_blank');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { folderToast(e); });
  }

  function bindFolderOpen(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-fopen]'), function (b) {
      b.onclick = function (ev) {
        if (ev) { ev.preventDefault(); }
        openFolderRel(b.getAttribute('data-fopen'));
      };
    });
  }

  // 搜索结果 / AI 引用的标题：上传的资料进资料页，文件夹里的资料直接打开文件。
  function hitTitle(hit, name) {
    if (isFolderHit(hit.material_id)) {
      return '<button class="btn small" data-fopen="' + esc(String(hit.material_id).slice(2)) + '">'
        + esc(name) + '</button>';
    }
    return '<a href="#/m/' + hit.material_id + '">' + esc(name) + '</a>';
  }

  // ---------- 搜索 ----------
  function viewSearch(query) {
    var q = (query && query.q) || '';
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h1>全文搜索</h1>' +
          '<p class="muted small">在所有已索引的资料里查找内容，包括扫描件里 AI 识别出来的文字。</p>' +
          '<div class="row" style="margin-top:10px">' +
            '<input type="search" id="sQ" value="' + esc(q) + '" placeholder="例如：古典概型、细胞呼吸、定语从句" style="flex:1;min-width:240px">' +
            '<button class="btn primary" id="sBtn">搜索</button>' +
          '</div>' +
        '</div>' +
        '<div id="sRes"></div>' +
      '</div>';
    el('sBtn').onclick = function () { location.hash = '#/search?q=' + encodeURIComponent(el('sQ').value); };
    el('sQ').onkeydown = function (ev) { if (ev.key === 'Enter') { el('sBtn').click(); } };
    if (!q) { el('sRes').innerHTML = '<div class="card muted">输入关键词开始搜索。</div>'; return; }
    api('/api/search?q=' + encodeURIComponent(q)).then(function (data) {
      if (!data.hits.length) {
        el('sRes').innerHTML = '<div class="card muted">没有找到相关的内容。<br>可能的原因：这份资料还在索引队列里，或者它是扫描件还没做 AI 识别。可以到“索引进度”查看。</div>';
        return;
      }
      var total = 0;
      data.hits.forEach(function (hit) { total += (hit.matches || 1); });
      var head = '<div class="card muted small">在 <b>' + data.hits.length + '</b> 份资料里共找到 <b>' + total + '</b> 处命中。同一份资料只显示最相关的一处，点进去能看到原文。</div>';
      var html = data.hits.map(function (hit) {
        var more = hit.matches > 1 ? '<span class="badge warn">这份资料里还有 ' + (hit.matches - 1) + ' 处</span>' : '';
        if (hit.copies > 1) {
          more += '<span class="badge">资料库里有 ' + hit.copies + ' 份同名同大小的文件，这里合并显示 1 条</span>';
        }
        var folderTag = isFolderHit(hit.material_id) ? '<span class="badge">文件夹</span>' : '';
        return '<div class="card"><h3 style="margin-top:0">' + hitTitle(hit, hit.name) + '</h3>' +
          '<div class="row small muted">' + folderTag + '<span class="badge">' + esc(hit.subject) + '</span><span>第 ' + hit.page + ' 页</span>' + more + '</div>' +
          '<pre class="text" style="max-height:180px">' + hl(hit.snippet) + '</pre></div>';
      }).join('');
      el('sRes').innerHTML = head + html;
      bindFolderOpen(el('sRes'));
    }).catch(function (err) { el('sRes').innerHTML = '<div class="card">搜索失败：' + esc(err.message) + '</div>'; });
  }

  // 文件夹 / 本地上传的资料只在本人浏览器里，提问时把最相关的几段原文一起发给模型（最多 4 段）。
  function askLocalExtra(question) {
    if (!window.StudyStore || !window.StudyStore.contexts) { return Promise.resolve([]); }
    return window.StudyStore.contexts(question, 6).then(function (list) {
      return (list || []).filter(keepLocalHit).slice(0, 4).map(function (c) {
        return { material_id: c.material_id, title: c.title, subject: c.subject,
                 text: String(c.text || '').slice(0, 1500) };
      });
    }).catch(function () { return []; });
  }

  // ---------- AI 问答 ----------
  // 来源列表（服务器资料和文件夹模式共用）：普通资料显示学科，本地文件多一个「文件夹」标签。
  function renderAskSources(sources) {
    return (sources || []).map(function (s) {
      var where = esc(s.subject) + (isFolderHit(s.material_id) ? '　·　文件夹' : '');
      return '<li>[' + s.index + '] ' + hitTitle(s, s.name) + ' <span class="muted small">' + where + '</span></li>';
    }).join('');
  }

  // 非流式问答（老接口 / 公网单文件版）的渲染，和流式共用同一套外观。
  function renderAsk(r) {
    var src = renderAskSources(r.sources);
    var meta = '<p class="muted small">' + (r.deep ? '深度思考模式' : '快速模式') + (r.model ? '　·　回答模型：' + esc(r.model) : '') + '</p>';
    var think = r.reasoning ? '<details class="think"><summary>展开看 AI 的思考过程</summary><div class="md">' + md(r.reasoning) + '</div></details>' : '';
    el('askOut').innerHTML = '<div class="card"><h2>回答</h2>' + meta + '<div class="md">' + md(r.answer) + '</div>' +
      think + (src ? '<h3>引用来源</h3><ul>' + src + '</ul>' : '') + '</div>';
    bindFolderOpen(el('askOut'));
  }

  // 能流式才流式：公网单文件版、以及“密钥在浏览器里自己直连模型”的账号都读不了服务器的 SSE。
  function canAskStream() { return !shouldUseLocal('/api/ask'); }

  // 边收边显示。api() 是 res.json()，读不了流，所以这里自己 fetch。
  function askStream(body) {
    var streaming = false;
    return fetch('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body)
    }).then(function (res) {
      var ctype = (res.headers && res.headers.get('content-type')) || '';
      if (!res.ok || !res.body || ctype.indexOf('event-stream') < 0) {
        // 服务器没按流式回（老接口 / 没开流式）：退回一次性返回，行为跟以前一样。
        // 这时要把 stream 指标摘掉，不然服务器会再按流式回一次。
        var plain = {};
        Object.keys(body).forEach(function (k) { if (k !== 'stream') { plain[k] = body[k]; } });
        return api('/api/ask', { json: plain }).then(renderAsk);
      }
      streaming = true;
      return readAskSse(res);
    }).catch(function (err) {
      if (streaming || (err && err.status)) { throw err; }
      // fetch 本身失败 = 连不上服务，别把英文 "Failed to fetch" 露出来。
      var down = new Error('连接不上服务器：学习网页的服务可能没有在运行，或者网络断了。刷新页面重试一次。');
      down.network = true;
      throw down;
    });
  }

  function readAskSse(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var got = { sources: [], reasoning: '', answer: '', model: '', deep: false, done: false };
    function paint() {
      var meta = '<p class="muted small">' + (got.deep ? '深度思考模式' : '快速模式') + (got.model ? '　·　回答模型：' + esc(got.model) : '') + '</p>';
      var think = got.reasoning ? '<details class="think"><summary>展开看 AI 的思考过程</summary><div class="md">' + md(got.reasoning) + '</div></details>' : '';
      var body = got.answer ? md(got.answer) : '<span class="muted small">正在思考…</span>';
      var src = renderAskSources(got.sources);
      el('askOut').innerHTML = '<div class="card"><h2>回答</h2>' + meta + '<div class="md">' + body + '</div>' +
        think + (src ? '<h3>引用来源</h3><ul>' + src + '</ul>' : '') + '</div>';
      bindFolderOpen(el('askOut'));
    }
    function handle(line) {
      if (line.indexOf('data:') !== 0) { return; }
      var ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
      if (ev.type === 'sources') { got.sources = ev.sources || []; got.deep = !!ev.deep; paint(); }
      else if (ev.type === 'reasoning') { got.reasoning += ev.text || ''; paint(); }
      else if (ev.type === 'answer') { got.answer += ev.text || ''; paint(); }
      else if (ev.type === 'model') { got.model = ev.text || ''; paint(); }
      else if (ev.type === 'done') { got.done = true; }
      else if (ev.type === 'error') { throw new Error(ev.message || 'AI 出错了'); }
    }
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          if (!got.done && !got.answer) { throw new Error('连接中断了，没收到回答，请重试。'); }
          return;
        }
        buf += decoder.decode(step.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) { handle(lines[i].trim()); }
        return pump();
      });
    }
    return pump();
  }

  function viewAsk() {
    el('app').innerHTML =
      '<div class="wrap">' +
        (canUseAi() ? '' : '<div class="card"><b>AI 暂时不可用</b><p class="muted small">' + esc(aiLockedMessage()) + '</p></div>') +
        '<div class="card"><h1>AI 问答</h1>' +
          '<p class="muted small">系统会先在你的资料里检索相关片段，再让 AI 根据这些片段回答，并标出来源编号。' +
            '普通模式用看图模型（快）；打开下面的“深度思考”会换用会推理的模型，一步步分步推导（慢一些）。</p>' +
          '<textarea id="askQ" rows="3" placeholder="例如：古典概型和几何概型有什么区别？"></textarea>' +
          '<div class="row" style="margin-top:8px">' +
            '<button class="btn primary" id="askBtn">提问</button>' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="askDeep"' + (state.askDeep ? ' checked' : '') + '> 深度思考（分步推导，更慢）</label>' +
            '<span class="muted small">回答会一边生成一边显示</span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:8px">看不到回答多半是 AI 接口没连上：可以到「<a href="#/index">索引进度</a>」页底部点一下检测；管理员可以在 <a href="/admin">管理端</a> 的「系统设置」里换成别的模型服务。</p>' +
        '</div>' +
        '<div id="askOut"></div>' +
      '</div>';
    el('askDeep').onchange = function () { state.askDeep = el('askDeep').checked; };
    el('askBtn').onclick = function () {
      var question = (el('askQ').value || '').trim();
      if (!question) { toast('请先输入问题', true); return; }
      var useDeep = el('askDeep').checked;
      el('askBtn').disabled = true;
      el('askBtn').textContent = '思考中…';
      el('askOut').innerHTML = '<div class="card loading">' + (useDeep ? '正在分步推理，可能要半分钟…' : '正在检索资料并组织答案…') + '</div>';
      askLocalExtra(question).then(function (extra) {
        var body = { question: question, deep: useDeep };
        if (extra.length) { body.extra = extra; }
        if (canAskStream()) { body.stream = true; return askStream(body); }
        return api('/api/ask', { json: body }).then(renderAsk);
      }).catch(function (e) {
        el('askOut').innerHTML = '<div class="card">出错了：' + esc(e.message) + '</div>';
      }).then(function () { el('askBtn').disabled = false; el('askBtn').textContent = '提问'; });
    };
  }
  // ---------- 收集 ----------
  function viewCollect() {
    var browserMode = isBrowserUser();
    var subs = (state.overview && state.overview.subjects) || [];
    var options = subs.map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('');
    options += '<option value="网络收集" selected>网络收集</option><option value="我的笔记">我的笔记</option><option value="未分类">未分类</option>';
    el('app').innerHTML =
      '<div class="wrap">' +
        (browserMode ? serverCard() : '') +
        (browserMode ? collectChannelCard() : '') +
        '<div class="card"><h1>收集资料和知识点</h1>' +
          '<p class="muted small">' + (browserMode
            ? '收集来的内容会存进<b>你自己的浏览器</b>，不占这台电脑的硬盘；存好会自动加入索引，可以直接搜索、出题、导出。'
            : '收集来的内容会存进你自己的资料库，<b>默认只有你能看到</b>，并自动加入索引，可以直接搜索、出题、导出。') +
          '</p>' +
        '</div>' +
        '<div class="card"><h2>按主题自动收集</h2>' +
          '<p class="muted small">输入一个知识点，系统会去网上搜索若干来源，抓取正文，再让 AI 汇总成一份知识点笔记。</p>' +
          '<div class="row" style="margin-top:10px"><input type="text" id="colTopic" placeholder="例如：古典概型与几何概型的区别" style="flex:1;min-width:240px">' +
          '<select id="colTopicSubject">' + options + '</select>' +
          '<button class="btn primary" id="colTopicBtn">开始收集</button></div>' +
          '<div class="muted small" style="margin-top:8px">来源数量：<select id="colLimit"><option value="3">3 个</option><option value="5" selected>5 个</option><option value="8">8 个</option></select>　' +
          '<label><input type="checkbox" id="colTopicQuiz"> 顺便出练习题</label></div>' +
        '</div>' +
        '<div class="card"><h2>收集一个网页</h2>' +
          '<div class="row" style="margin-top:10px"><input type="text" id="colUrl" placeholder="粘贴网址，例如某篇讲解文章" style="flex:1;min-width:240px">' +
          '<select id="colUrlSubject">' + options + '</select>' +
          '<button class="btn" id="colPreviewBtn">先预览</button>' +
          '<button class="btn primary" id="colUrlBtn">保存进资料库</button></div>' +
          '<div class="row" style="margin-top:8px"><label class="small"><input type="checkbox" id="colSum" checked> 顺便让 AI 总结</label>' +
          '<label class="small"><input type="checkbox" id="colUrlQuiz"> 顺便出练习题</label></div>' +
          '<div id="colPreview" style="margin-top:10px"></div>' +
        '</div>' +
        '<div class="card"><h2>自己粘贴知识点</h2>' +
          '<div class="row"><input type="text" id="colNoteTitle" placeholder="标题，例如：概率公式小结" style="flex:1;min-width:220px">' +
          '<select id="colNoteSubject">' + options + '</select></div>' +
          '<textarea id="colNoteBody" rows="7" placeholder="把整理好的知识点粘贴到这里" style="margin-top:10px"></textarea>' +
          '<div class="row" style="margin-top:8px"><button class="btn primary" id="colNoteBtn">保存进资料库</button></div>' +
        '</div>' +
        '<div id="colOut"></div>' +
      '</div>';

    el('colTopicBtn').onclick = function () {
      var topic = (el('colTopic').value || '').trim();
      if (!topic) { toast('请先填写主题', true); return; }
      el('colTopicBtn').disabled = true;
      el('colTopicBtn').textContent = '收集中…';
      el('colOut').innerHTML = '<div class="card loading">正在搜索、抓取正文并让 AI 汇总，这一步可能要半分钟到几分钟…</div>';
      api('/api/collect/topic', { json: {
        topic: topic, subject: el('colTopicSubject').value,
        limit: parseInt(el('colLimit').value, 10), quiz: el('colTopicQuiz').checked
      } }).then(function (r) {
        var src = (r.sources || []).map(function (s) {
          var extra = s.media ? ' <span class="muted small">' + esc(s.media)
            + (s.date ? ' · ' + esc(s.date) : '') + '</span>' : '';
          return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>'
            + extra + '</li>';
        }).join('');
        el('colOut').innerHTML = '<div class="card"><h2>收集完成</h2>' +
          '<p>已保存为《' + esc(r.filename) + '》，抓到 ' + r.chars + ' 字。</p>' +
          (src ? '<h3>来源</h3><ul>' + src + '</ul>' : '') +
          (r.via ? '<p class="muted small">这次用的通道：' + esc(r.via) + '</p>' : '') +
          '<div class="row"><a class="btn primary" href="#/m/' + r.material_id + '">打开这份资料</a>' +
          '<a class="btn" href="#/search?q=' + encodeURIComponent(topic) + '">去搜索</a></div></div>';
        toast('收集完成');
      }).catch(function (e) {
        el('colOut').innerHTML = '<div class="card">收集失败：' + esc(e.message) + '</div>';
      }).then(function () { el('colTopicBtn').disabled = false; el('colTopicBtn').textContent = '开始收集'; });
    };

    el('colPreviewBtn').onclick = function () {
      var url = (el('colUrl').value || '').trim();
      if (!url) { toast('请先填写网址', true); return; }
      el('colPreview').innerHTML = '<span class="muted">正在抓取…</span>';
      api('/api/collect/preview?url=' + encodeURIComponent(url)).then(function (r) {
        el('colPreview').innerHTML = '<div class="row"><span class="badge">' + esc(r.chars) + ' 字</span>' +
          '<strong>' + esc(r.title) + '</strong></div><pre class="text" style="max-height:200px">' + esc(r.preview) + '</pre>';
      }).catch(function (e) { el('colPreview').innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; });
    };

    el('colUrlBtn').onclick = function () {
      var url = (el('colUrl').value || '').trim();
      if (!url) { toast('请先填写网址', true); return; }
      el('colUrlBtn').disabled = true;
      el('colUrlBtn').textContent = '保存中…';
      el('colOut').innerHTML = '<div class="card loading">正在抓取并保存…</div>';
      api('/api/collect/url', { json: {
        url: url, subject: el('colUrlSubject').value,
        summarize: el('colSum').checked, quiz: el('colUrlQuiz').checked
      } }).then(function (r) {
        el('colOut').innerHTML = '<div class="card"><h2>已保存</h2><p>《' + esc(r.filename) + '》共 ' + r.chars + ' 字。</p>' +
          (r.via ? '<p class="muted small">这次用的通道：' + esc(r.via) + '</p>' : '') +
          '<a class="btn primary" href="#/m/' + r.material_id + '">打开这份资料</a></div>';
        toast('已保存到资料库');
      }).catch(function (e) {
        el('colOut').innerHTML = '<div class="card">保存失败：' + esc(e.message) + '</div>';
      }).then(function () { el('colUrlBtn').disabled = false; el('colUrlBtn').textContent = '保存进资料库'; });
    };

    el('colNoteBtn').onclick = function () {
      var content = (el('colNoteBody').value || '').trim();
      if (content.length < 10) { toast('内容太短了', true); return; }
      api('/api/collect/note', { json: {
        title: el('colNoteTitle').value, content: content, subject: el('colNoteSubject').value
      } }).then(function (r) {
        el('colOut').innerHTML = '<div class="card"><h2>已保存</h2><p>《' + esc(r.filename) + '》</p>' +
          '<a class="btn primary" href="#/m/' + r.material_id + '">打开这份笔记</a></div>';
        el('colNoteBody').value = '';
        toast('笔记已保存');
      }).catch(function (e) { toast(e.message, true); });
    };
    bindServerCard(browserMode);
  }

  function collectChannelCard() {
    return '<div class="card"><h2>抓不到网页正文时，会自动换通道</h2>' +
      '<p class="muted small">浏览器自己抓不了别的网站正文（跨域限制）。系统按下面的顺序依次尝试，哪个能用用哪个：</p>' +
      '<ol class="muted small" style="margin:6px 0 0 18px;padding:0">' +
        '<li>你电脑上的服务器（可选增强，最稳；见上面「连接服务器」）</li>' +
        '<li>第三方免费抓取代理（免费，但经常挂或限流；对方会看到被抓取的网址和正文）</li>' +
        '<li>你自己的 AI 联网搜索（花<b>你自己的额度</b>，几分钱一次；需要支持联网的模型）</li>' +
      '</ol>' +
      '<p class="muted small" style="margin-top:8px">联网搜索支持：智谱 ✅、阿里云百炼 ✅；DeepSeek ❌ 不支持，' +
      '会自动降级成「自己粘贴知识点」或「上传文件」。</p></div>';
  }

  function serverCard() {
    return '<div class="card"><h2>连接服务器</h2>' +
      '<p class="muted small">浏览器自己抓不了别的网站正文（跨域限制）。填上<b>你电脑上那个学习网页的地址</b>' +
      '和<b>连接码</b>，就能借用它的抓取能力；抓到的内容仍然只存在<b>你自己的浏览器</b>里。</p>' +
      '<p class="muted small">这是<b>可选增强</b>：服务器开着时抓取最稳，需要和你在同一个网络（或已做内网穿透）。' +
      '不填也不影响使用——系统会自动改用免费抓取代理，或你自己的 AI 联网搜索。</p>' +
      '<div class="fields" style="margin-top:10px">' +
        '<label>服务器地址<input type="text" id="colSrvUrl" placeholder="例如 http://192.168.1.5:8787"></label>' +
        '<label>连接码<input type="text" id="colSrvKey" placeholder="服务器管理端显示的连接码" style="text-transform:uppercase"></label>' +
      '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn primary small" id="colSrvSave">保存并连接</button>' +
        '<button class="btn small" id="colSrvTest">测试连接</button>' +
        '<span class="muted small" id="colSrvOut"></span>' +
      '</div></div>';
  }

  function bindServerCard(browserMode) {
    if (!browserMode || !el('colSrvSave')) { return; }
    api('/api/collect/info').then(function (r) {
      var info = r.info || {};
      el('colSrvUrl').value = info.url || '';
      if (info.has_key) { el('colSrvKey').placeholder = '已保存，留空表示不改'; }
    }).catch(function () {});
    el('colSrvSave').onclick = function () {
      el('colSrvSave').disabled = true;
      el('colSrvOut').textContent = '正在连接…';
      api('/api/collect/config', { json: { url: el('colSrvUrl').value, key: el('colSrvKey').value } })
        .then(function (r) {
          var info = r.info || {};
          el('colSrvOut').textContent = info.note || '';
          toast(info.connected ? '服务器已连接' : '还没连上，看上面的提示', !info.connected);
          if (info.connected) { el('colSrvKey').value = ''; el('colSrvKey').placeholder = '已保存，留空表示不改'; }
        }).catch(function (e) { el('colSrvOut').textContent = e.message; toast(e.message, true); })
        .then(function () { el('colSrvSave').disabled = false; });
    };
    el('colSrvTest').onclick = function () {
      el('colSrvOut').textContent = '正在测试…';
      api('/api/collect/test').then(function (r) {
        el('colSrvOut').textContent = (r.result && r.result.message) || '连接正常。';
        toast('连接正常');
      }).catch(function (e) { el('colSrvOut').textContent = e.message; toast(e.message, true); });
    };
  }

  // ---------- 上传 ----------
  function viewUpload() {
    var subs = (state.overview && state.overview.subjects) || [];
    var options = subs.map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('');
    options += '<option value="未分类">未分类</option><option value="__new__">新建分类…</option>';
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h1>上传资料</h1>' +
          '<div id="upWhere"><p class="muted small">正在检查文件存到哪里…</p></div>' +
          '<div class="row" style="margin-top:12px"><span>存到分类：</span><select id="upSubject">' + options + '</select>' +
          '<input type="text" id="upNew" placeholder="新分类名称" style="display:none"></div>' +
          '<div class="drop" id="drop" style="margin-top:14px">把文件拖到这里，或者点击选择（可以一次选很多个）</div>' +
          '<div class="bar-track" style="margin-top:14px"><div class="bar-fill" id="upBar"></div></div>' +
          '<div id="upList" class="small muted" style="margin-top:10px"></div>' +
        '</div>' +
      '</div>';
    var drop = el('drop');
    el('upSubject').onchange = function () {
      el('upNew').style.display = this.value === '__new__' ? '' : 'none';
    };
    drop.onclick = function () { el('hiddenFile').click(); };
    drop.ondragover = function (ev) { ev.preventDefault(); drop.classList.add('hot'); };
    drop.ondragleave = function () { drop.classList.remove('hot'); };
    drop.ondrop = function (ev) {
      ev.preventDefault(); drop.classList.remove('hot');
      uploadFiles(ev.dataTransfer.files);
    };
    el('hiddenFile').onchange = function () { uploadFiles(this.files); this.value = ''; };
    renderUploadTarget();
  }

  // 只有管理员（也就是站主本人）的文件放在这台电脑上；其他人的文件一律留在自己浏览器里。
  function uploadLocal() {
    return LOCAL || !(state.user && state.user.is_admin);
  }

  function uploadToBrowser(fileList, subject) {
    if (!window.StudyStore) { toast('这个浏览器不支持本地存储，换 Chrome 或 Edge 试试', true); return; }
    var total = fileList.length;
    var done = 0;
    var saved = 0;
    var bar = el('upBar');
    el('upList').textContent = '正在保存到本机浏览器…';
    var chain = Promise.resolve();
    Array.prototype.forEach.call(fileList, function (f) {
      chain = chain.then(function () {
        return window.StudyStore.add(f, subject).then(function (doc) {
          saved++;
          done++;
          if (bar) { bar.style.width = Math.round((done / total) * 100) + '%'; }
          el('upList').textContent = '已保存 ' + saved + ' / ' + total + '：' + doc.name
            + (doc.has_text ? '（已能搜索）' : '（图片或扫描件，可点进资料用“AI 识别文字”）');
          return doc;
        });
      });
    });
    chain.then(function () {
      if (bar) { bar.style.width = '0%'; }
      toast('已存到本机浏览器：' + saved + ' 个文件');
      if (state.overview) {
        api('/api/overview').then(function (d) { state.overview = d; });
      }
    }).catch(function (e) {
      if (bar) { bar.style.width = '0%'; }
      toast(e.message, true);
    });
  }

  function uploadFiles(fileList) {
    if (!fileList || !fileList.length) { return; }
    var subject = el('upSubject').value;
    if (subject === '__new__') { subject = (el('upNew').value || '').trim() || '未分类'; }
    if (uploadLocal()) {
      if (state.upTarget === 'folder' && window.StudyFolder) { uploadToFolder(fileList, subject); return; }
      uploadToBrowser(fileList, subject); return;
    }
    var form = new FormData();
    form.append('subject', subject);
    for (var i = 0; i < fileList.length; i++) { form.append('files', fileList[i]); }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable) {
        el('upBar').style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
      }
    };
    xhr.onload = function () {
      el('upBar').style.width = '0%';
      var res = {};
      try { res = JSON.parse(xhr.responseText); } catch (e) { res = {}; }
      if (xhr.status === 200 && res.ok) {
        el('upList').innerHTML = '已上传 ' + res.saved.length + ' 个文件到「' + esc(res.subject) + '」，已加入索引队列。';
        toast('上传成功');
      } else {
        toast(res.error || '上传失败', true);
      }
    };
    xhr.onerror = function () { toast('上传中断，请重试', true); };
    el('upList').textContent = '正在上传 ' + fileList.length + ' 个文件…';
    xhr.send(form);
  }

  // 上传存到哪里：管理员存这台电脑；普通用户优先写进自己选的文件夹，没选就落浏览器。
  function renderUploadTarget() {
    var box = el('upWhere');
    if (!box) { return; }
    if (!uploadLocal()) {
      state.upTarget = 'server';
      box.innerHTML = '<p class="muted small">文件会保存到这台电脑上的资料文件夹（data\\uploads\\分类\\），同名文件自动改名，绝不会覆盖已有的东西。</p>';
      return;
    }
    var browserText = '<p class="muted small">文件只保存到<b>你自己的浏览器</b>里，不会上传到任何服务器；同名文件自动改名，绝不会覆盖已有的东西。</p>';
    var F = window.StudyFolder;
    if (!F || !F.supported()) {
      state.upTarget = 'browser';
      box.innerHTML = browserText;
      return;
    }
    F.rootInfo().then(function (saved) {
      if (!saved || !saved.handle) {
        state.upTarget = 'browser';
        box.innerHTML = browserText + '<p class="muted small">想让文件直接写进自己的文件夹（不受浏览器空间限制），先去 ' +
          '<a href="#/folder">文件夹</a> 选一个目录。</p>';
        return;
      }
      state.upTarget = 'folder';
      box.innerHTML = '<p class="muted small">文件直接写进你选的文件夹：<b>' + esc(saved.handle.name || '我的文件夹') +
        '\\分类\\文件名</b>，不占浏览器空间，也不会上传到服务器。同名文件自动加序号，绝不覆盖。</p>' +
        '<div class="row small" style="margin-top:8px">' +
          '<label><input type="radio" name="upWhere" value="folder" checked> 存到我的文件夹（推荐）</label>' +
          '<label><input type="radio" name="upWhere" value="browser"> 存到浏览器</label>' +
        '</div>';
      Array.prototype.forEach.call(document.querySelectorAll('input[name=upWhere]'), function (radio) {
        radio.onchange = function () {
          if (radio.checked) { state.upTarget = radio.value; }
        };
      });
    }).catch(function () {
      state.upTarget = 'browser';
      box.innerHTML = browserText;
    });
  }

  function uploadToFolder(fileList, subject) {
    var F = window.StudyFolder;
    var total = fileList.length;
    var done = 0;
    var paths = [];
    var bar = el('upBar');
    el('upList').textContent = '正在写入你的文件夹…';
    // 先要写入权限（选文件夹时只给了读），紧跟着这次操作浏览器才认。
    var chain = F.ensureWritable();
    Array.prototype.forEach.call(fileList, function (f) {
      chain = chain.then(function () {
        return F.writeFile(subject, f.name, f).then(function (rel) {
          done++;
          paths.push(rel);
          if (bar) { bar.style.width = Math.round((done / total) * 100) + '%'; }
          el('upList').textContent = '已写入 ' + done + ' / ' + total + '：' + rel;
          return null;
        });
      });
    });
    chain.then(function () {
      if (bar) { bar.style.width = '0%'; }
      return F.scan().catch(function () { return null; });
    }).then(function () {
      el('upList').innerHTML = '已写入你的文件夹 ' + paths.length + ' 个文件：<br>' +
        paths.map(function (p) { return esc(p); }).join('<br>') +
        '<br><a href="#/folder">去「文件夹」看</a>';
      toast('已写入你的文件夹：' + paths.length + ' 个文件');
    }).catch(function (e) {
      if (bar) { bar.style.width = '0%'; }
      toast(e.message, true);
    });
  }

  function localPrint(id) {
    window.StudyStore.get(id).then(function (doc) {
      if (!doc) { throw new Error('资料不存在'); }
      var parts = ['<h1>' + esc(doc.name) + '</h1>',
        '<p class="muted">' + esc(doc.subject) + ' · ' + esc(doc.kind_label) + ' · ' + esc(doc.size_label) + '</p>'];
      if (doc.summary) { parts.push('<h2>AI 学习笔记</h2><pre>' + esc(doc.summary) + '</pre>'); }
      if (doc.quiz && doc.quiz.length) {
        parts.push('<h2>练习题与答案</h2>' + doc.quiz.map(function (item, i) {
          var opts = (item.options || []).map(function (o, j) {
            return '<div>' + 'ABCD'.charAt(j) + '. ' + esc(o) + '</div>';
          }).join('');
          return '<div class="q"><b>' + (i + 1) + '. ' + esc(item.stem) + '</b>' + opts +
            '<div class="ans">答案：' + esc(item.answer) + (item.explain ? '　解析：' + esc(item.explain) : '') + '</div></div>';
        }).join(''));
      }
      if (String(doc.note || '').trim()) { parts.push('<h2>我的笔记</h2><pre>' + esc(doc.note) + '</pre>'); }
      var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(doc.name) + '</title>'
        + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:820px;margin:32px auto;padding:0 18px;line-height:1.7;color:#1b2430}'
        + 'h1{font-size:22px}h2{font-size:17px;margin-top:26px;border-bottom:1px solid #ddd;padding-bottom:6px}'
        + 'pre{white-space:pre-wrap;font-family:inherit;background:#f6f8fa;padding:12px;border-radius:8px}'
        + '.q{margin:10px 0}.ans{color:#0a7c4a}.muted{color:#667}</style></head><body>'
        + '<div style="text-align:right"><button onclick="window.print()">打印 / 另存为 PDF</button></div>'
        + parts.join('') + '</body></html>';
      var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank');
      toast('已生成打印版，在打开的页面里点“打印 / 另存为 PDF”');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------- 导出 ----------
  function viewExport(query) {
    if (LOCAL) { return viewExportLocal(query); }
    var q = (query && query.q) || '';
    var ids = Object.keys(state.sel).map(function (k) { return parseInt(k, 10); });
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h1>导出学习资料包</h1>' +
          '<p class="muted small">勾选资料，生成一个可以发给别人的文件。' +
          '<strong>单文件模式</strong>适合小资料；<strong>打包模式</strong>会把视频和大 PDF 一起放进去，别人解压后也能看。' +
          '<strong>分享版网站</strong>导出的是这个学习网站本身（界面 + 数理化模型动画），只打包你勾选的资料，不含账号、笔记、收藏，发给别人不会泄露你的私人内容。</p>' +
          '<div class="row" style="margin-top:12px">' +
            '<input type="text" id="exTitle" placeholder="资料包标题" value="学习资料包" style="min-width:200px">' +
            '<select id="exMode"><option value="single">单文件 HTML（方便发微信）</option><option value="bundle">打包 zip（含视频/大文件）</option><option value="notes">AI 总结打印版（可打印/存 PDF）</option><option value="site">分享版网站（离线可看的整站，含模型动画）</option></select>' +
            '<button class="btn primary" id="exBtn">生成</button>' +
          '</div>' +
          '<div class="row" style="margin-top:8px"><label class="small"><input type="checkbox" id="exQuiz" checked> 带上练习题和答案</label><label class="small"><input type="checkbox" id="exText"> 带上资料原文</label></div>' +
          '<div class="row" style="margin-top:8px"><span class="muted small">已选 ' + ids.length + ' 个</span>' +
          '<button class="btn small" id="exClear">清空选择</button><a class="btn small" href="#/search">去搜索资料</a></div>' +
        '</div>' +
        '<div class="card"><h2>选择资料</h2>' +
          '<div class="row"><input type="search" id="exQ" value="' + esc(q) + '" placeholder="按文件名筛选" style="min-width:220px"><button class="btn small" id="exQBtn">筛选</button></div>' +
          '<div id="exList" style="margin-top:12px"></div>' +
        '</div>' +
        '<div id="exOut"></div>' +
      '</div>';
    el('exBtn').onclick = doExport;
    el('exClear').onclick = function () { state.sel = {}; renderTop(); viewExport(query); };
    el('exQBtn').onclick = function () { location.hash = '#/export?q=' + encodeURIComponent(el('exQ').value); };
    api('/api/materials?limit=300&q=' + encodeURIComponent(q)).then(function (data) {
      if (!data.items.length) { el('exList').innerHTML = '<p class="muted">没有匹配的资料。</p>'; return; }
      var rows = data.items.map(function (i) {
        return '<label style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)">' +
          '<input type="checkbox" data-pick="' + i.id + '"' + (state.sel[i.id] ? ' checked' : '') + '>' +
          '<span class="badge">' + esc(i.subject) + '</span>' + esc(i.name) +
          '<span class="muted small" style="margin-left:auto">' + esc(i.size_label) + '</span></label>';
      }).join('');
      el('exList').innerHTML = rows;
    }).catch(function (e) { el('exList').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }

  function viewExportLocal(query) {
    var q = (query && query.q) || '';
    var ids = Object.keys(state.sel).map(function (k) { return parseInt(k, 10); });
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h1>分享给别人</h1>' +
          '<p class="muted small">这个网页文件本身就能分享：把 <b>学习工具.html</b> 直接发给别人，对方双击就能打开，' +
          '而且<b>里面没有你的任何资料</b>。如果想连自己整理的资料一起给某个人，在下面勾选后生成一个小文件。</p>' +
          '<div class="row" style="margin-top:12px">' +
            '<input type="text" id="exTitle" placeholder="文件标题" value="学习资料包" style="min-width:200px">' +
            '<button class="btn primary" id="exBtn">生成并下载</button>' +
            '<span class="muted small">已选 ' + ids.length + ' 个</span>' +
            '<button class="btn small" id="exClear">清空选择</button>' +
          '</div>' +
        '</div>' +
        '<div class="card"><h2>选择要一起给出去的资料</h2>' +
          '<div class="row"><input type="search" id="exQ" value="' + esc(q) + '" placeholder="按文件名筛选" style="min-width:220px">' +
          '<button class="btn small" id="exQBtn">筛选</button></div>' +
          '<div id="exList" style="margin-top:12px"></div>' +
        '</div>' +
        '<div id="exOut"></div>' +
      '</div>';
    var params = '?limit=300' + (q ? '&q=' + encodeURIComponent(q) : '');
    api('/api/materials' + params).then(function (data) {
      var rows = data.items.map(function (i) {
        return '<label style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)">' +
          '<input type="checkbox" data-pick="' + i.id + '"' + (state.sel[i.id] ? ' checked' : '') + '>' +
          '<span class="badge">' + esc(i.subject) + '</span>' + esc(i.name) +
          '<span class="muted small" style="margin-left:auto">' + esc(i.size_label) + '</span></label>';
      }).join('') || '<p class="muted">还没有资料，先去「上传」加一些。</p>';
      el('exList').innerHTML = rows;
    }).catch(function (e) { el('exList').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
    el('exQBtn').onclick = function () { location.hash = '#/export?q=' + encodeURIComponent(el('exQ').value); };
    el('exQ').onkeydown = function (ev) { if (ev.key === 'Enter') { el('exQBtn').click(); } };
    el('exClear').onclick = function () { state.sel = {}; renderTop(); viewExportLocal(query); };
    el('exBtn').onclick = function () { doLocalExport(); };
  }

  function doLocalExport() {
    var ids = Object.keys(state.sel).map(function (k) { return parseInt(k, 10); });
    if (!ids.length) { toast('请先勾选资料', true); return; }
    var title = (el('exTitle').value || '').trim() || '学习资料包';
    el('exBtn').disabled = true;
    el('exOut').innerHTML = '<div class="card loading">正在打包…</div>';
    Promise.all(ids.map(function (id) {
      return Promise.all([window.StudyStore.get(id), window.StudyStore.texts(id)]);
    })).then(function (pairs) {
      var chunks = [];
      var images = pairs.filter(function (p) {
        return p[0] && p[0].kind === 'image' && p[0].size <= 1500000;
      }).map(function (p) {
        return window.StudyStore.dataUrl(p[0].id).then(function (u) {
          return { doc: p[0], url: u };
        }).catch(function () { return null; });
      });
      pairs.forEach(function (p) {
        var doc = p[0];
        if (!doc) { return; }
        var body = '<h2>' + esc(doc.name) + '</h2><p class="muted">' + esc(doc.subject) + ' · '
          + esc(doc.kind_label) + ' · ' + esc(doc.size_label) + '</p>';
        if (doc.summary) { body += '<h3>AI 学习笔记</h3><pre>' + esc(doc.summary) + '</pre>'; }
        if (doc.quiz && doc.quiz.length) {
          body += '<h3>练习题与答案</h3>' + doc.quiz.map(function (item, i) {
            var opts = (item.options || []).map(function (o, j) {
              return '<div>' + 'ABCD'.charAt(j) + '. ' + esc(o) + '</div>';
            }).join('');
            return '<div class="q"><b>' + (i + 1) + '. ' + esc(item.stem) + '</b>' + opts +
              '<div class="ans">答案：' + esc(item.answer) + '</div></div>';
          }).join('');
        }
        var text = (p[1] || []).map(function (t) { return String(t.content || ''); }).join('\n').trim();
        if (text) { body += '<h3>资料原文</h3><pre>' + esc(text.slice(0, 60000)) + '</pre>'; }
        chunks.push(body);
      });
      return Promise.all(images).then(function (picList) {
        var pics = picList.filter(function (x) { return x; }).map(function (x) {
          return '<figure><img src="' + x.url + '" alt=""><figcaption>' + esc(x.doc.name) + '</figcaption></figure>';
        }).join('');
        if (pics) { chunks.push('<h2>图片</h2>' + pics); }
        var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(title) + '</title>'
          + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:860px;margin:32px auto;padding:0 18px;line-height:1.7;color:#1b2430}'
          + 'h1{font-size:24px}h2{font-size:20px;margin-top:34px;border-bottom:2px solid #e6e6e6;padding-bottom:8px}'
          + 'h3{font-size:16px;margin-top:20px}pre{white-space:pre-wrap;font-family:inherit;background:#f6f8fa;padding:12px;border-radius:8px;font-size:14px}'
          + 'img{max-width:100%;border-radius:8px}.q{margin:10px 0}.ans{color:#0a7c4a}.muted{color:#667}'
          + 'figure{margin:14px 0}figcaption{color:#667;font-size:13px}</style></head><body>'
          + '<h1>' + esc(title) + '</h1><p class="muted">这份文件是学习资料包，双击即可离线打开，不需要联网。</p>'
          + chunks.join('') + '</body></html>';
        var blob = new Blob([html], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = title + '.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        el('exOut').innerHTML = '<div class="card"><h2>已生成</h2><p>大小：'
          + esc(window.StudyStore.humanSize(blob.size)) + '　资料：' + chunks.length + ' 份</p></div>';
        toast('已生成并开始下载');
      });
    }).catch(function (e) {
      el('exOut').innerHTML = '<div class="card">导出失败：' + esc(e.message) + '</div>';
    }).then(function () { el('exBtn').disabled = false; });
  }

  function doExport() {
    var ids = Object.keys(state.sel).map(function (k) { return parseInt(k, 10); });
    var mode = el('exMode').value;
    if (mode !== 'site' && !ids.length) { toast('请先勾选资料', true); return; }
    el('exBtn').disabled = true;
    el('exBtn').textContent = '生成中…';
    var rawTitle = el('exTitle').value;
    if (mode === 'site' && (!rawTitle || rawTitle === '学习资料包')) { rawTitle = '离线学习站'; }
    var payload = { ids: ids, title: rawTitle, mode: mode };
    if (mode === 'notes') {
      payload.include_quiz = el('exQuiz').checked;
      payload.include_text = el('exText').checked;
    }
    var endpoint = mode === 'notes' ? '/api/notes-export' : (mode === 'site' ? '/api/share/site' : '/api/export');
    el('exOut').innerHTML = '<div class="card loading">正在生成，视频和大文件需要复制，请稍候…</div>';
    api(endpoint, { json: payload }).then(function (r) {
      var warn = (r.warnings || []).length ? '<h3>提示</h3><ul>' + r.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '';
      el('exOut').innerHTML = '<div class="card"><h2>生成成功</h2>' +
        '<p>大小：' + esc(r.size_label) + '　资料：' + r.count + ' 个</p>' + warn +
        '<div class="row" style="margin-top:10px"><a class="btn primary" href="/api/export/' + r.id + '/download">下载 ' + esc(r.file_name) + '</a></div>' +
        '<p class="muted small" style="margin-top:10px">' + (mode === 'notes' ? '打开后点页面顶部的「打印 / 另存为 PDF」，在打印窗口里选「另存为 PDF」就能保存成 PDF。' : (mode === 'site' ? '这是整个学习网站的离线版：双击打开就能看模型动画，里面有模型动画和你勾选的资料，但没有账号、笔记、收藏，也没有别人的东西。直接发给别人即可。' : (r.mode === 'bundle' ? '下载的是一个压缩包，对方解压后双击 index.html，里面的视频和文档都能看。' : '下载后直接把文件发给别人，对方双击就能看。'))) + '</p>' +
        '</div>';
      toast('导出完成');
    }).catch(function (e) {
      el('exOut').innerHTML = '<div class="card">导出失败：' + esc(e.message) + '</div>';
    }).then(function () { el('exBtn').disabled = false; el('exBtn').textContent = '生成'; });
  }

  // ---------- 我的 ----------
  // AI 由谁买单：管理员随便用；别人要管理员在管理端开了「共用 AI」才行。
  function canUseAi() {
    if (!state.user) { return true; }
    if (isBrowserUser()) { return true; }   // 用他自己的密钥，随时都能用
    return state.allowSharedAi === true;
  }

  function aiLockedMessage() {
    return '这台服务器没有开放共用的 AI 额度。你可以到「我的 → AI 接入」填一个自己的模型接口来用。';
  }

  // 自带密钥的 AI 面板：本地版和普通账号都能看到；局域网里的管理员由管理端统一配置。
  var AI_PRESETS = [
    { name: '本机代理（免密钥，只有这台电脑能用）', base: 'http://127.0.0.1:15721/v1',
      text: 'deepseek-v4-pro', vision: 'deepseek-flash', browser: false },
    { name: 'DeepSeek 官方（浏览器直连可用）', base: 'https://api.deepseek.com/v1',
      text: 'deepseek-chat', vision: 'deepseek-chat', browser: true },
    { name: '智谱开放平台（浏览器直连可用）', base: 'https://open.bigmodel.cn/api/paas/v4',
      text: 'glm-4-plus', vision: 'glm-4v-plus', browser: true },
    { name: '硅基流动（浏览器直连可用）', base: 'https://api.siliconflow.cn/v1',
      text: 'deepseek-ai/DeepSeek-V3', vision: 'Qwen/Qwen2.5-VL-72B-Instruct', browser: true },
    { name: '阿里云百炼（浏览器直连可用）',
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      text: 'qwen-plus', vision: 'qwen-vl-max', browser: true }
  ];

  function showAiPanel() { return true; }

  // 管理员在“我的”里改的其实是全站统一配置（和管理端是同一份），说明白免得误会。
  function isAdminAccount() { return !!(state.user && state.user.is_admin && !LOCAL); }

  function aiStoreMode() { return state.aiStore === 'server' ? 'server' : 'browser'; }

  function localSettingsCard() {
    if (!showAiPanel()) { return ''; }
    var server = aiStoreMode() === 'server';
    var admin = isAdminAccount();
    var options = AI_PRESETS.map(function (item, index) {
      return '<option value="' + index + '">' + esc(item.name) + '</option>';
    }).join('');
    return '<div class="card"><h2>' + (admin ? 'AI 接入（全站统一配置）' : 'AI 接入（用你自己的密钥）') + '</h2>' +
      '<p class="muted small">' + (admin
        ? '这里保存的是全站统一的 AI 接口，和管理端「系统设置 → AI 接入」是同一份，保存后全站生效。'
        : 'AI 问答、AI 摘要、出练习题、看图识字都走这里配置的接口；填上你自己的密钥就能用。') + '</p>' +
      (admin ? '' :
        '<div class="row" style="margin-top:10px">' +
          '<label class="small"><input type="radio" name="aiStore" value="browser"' + (server ? '' : ' checked') +
            '> 只存在我这个浏览器（推荐）</label>' +
          '<label class="small"><input type="radio" name="aiStore" value="server"' + (server ? ' checked' : '') +
            '> 存在我的账号里（由服务器代发）</label>' +
        '</div>') +
      '<p class="muted small" style="margin:6px 0 0">' + (admin
        ? '「本机代理」只在这台电脑上有效。'
        : 'DeepSeek / 智谱 / 硅基流动 / 阿里云百炼 都能直接连；「本机代理」只在这台电脑上有效。') + '</p>' +
      '<div class="fields" style="margin-top:10px">' +
        '<label>常用服务<select id="lsPreset">' + '<option value="">选择一个常用服务（会自动填好地址和模型名）</option>' + options + '</select></label>' +
        '<label>接口地址<input type="text" id="lsBase" name="study-ai-base" autocomplete="off" placeholder="例如 https://api.deepseek.com/v1"></label>' +
        '<label>密钥<input type="password" id="lsKey" placeholder="粘贴你自己的 API Key" autocomplete="off"></label>' +
        '<label>文本模型<input type="text" id="lsModels" name="study-ai-text" autocomplete="off" placeholder="例如 deepseek-chat"></label>' +
        '<label>看图模型<input type="text" id="lsVision" name="study-ai-vision" autocomplete="off" placeholder="例如 deepseek-chat"></label>' +
      '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn primary small" id="lsSave">保存</button>' +
        '<button class="btn small" id="lsTest">测试连接</button>' +
        '<button class="btn small" id="lsClear">清空</button>' +
        '<span class="muted small" id="lsOut"></span>' +
      '</div>' +
      (LOCAL ? '<div class="row" style="margin-top:10px"><button class="btn small" id="lsLock">忘记分享码 / 换一个码</button></div>' : '') +
      '</div>';
  }

  function aiFormPayload() {
    var payload = {
      base_url: el('lsBase').value,
      model_text: el('lsModels').value, model_vision: el('lsVision').value
    };
    // 密钥留空表示“不改”，绝不能把已经保存的密钥冲掉。
    if (el('lsKey').value) { payload.api_key = el('lsKey').value; }
    return payload;
  }

  function bindLocalSettings() {
    if (!el('lsBase')) { return; }
    el('lsPreset').innerHTML = '<option value="">选择一个常用服务（会自动填好地址和模型名）</option>' +
      AI_PRESETS.map(function (item, index) {
        return '<option value="' + index + '">' + esc(item.name) + '</option>';
      }).join('');
    el('lsPreset').onchange = function () {
      var index = parseInt(el('lsPreset').value, 10);
      if (isNaN(index) || !AI_PRESETS[index]) { return; }
      var item = AI_PRESETS[index];
      el('lsBase').value = item.base;
      el('lsModels').value = item.text;
      el('lsVision').value = item.vision;
      if (!item.browser) {
        var radio = document.querySelector('input[name=aiStore][value=server]');
        if (radio && !(state.user && state.user.is_admin)) {
          radio.checked = true;
          state.aiStore = 'server';
          toast('这个服务商不允许网页直连，已经帮你改成“存在我的账号里”');
        }
      }
    };
    Array.prototype.forEach.call(document.querySelectorAll('input[name=aiStore]'), function (radio) {
      radio.onchange = function () {
        if (radio.checked) { state.aiStore = radio.value; toast('保存时会存在：' + (radio.value === 'server' ? '你的账号里' : '这个浏览器里')); }
      };
    });
    if (!LOCAL) {
      api('/api/me/ai').then(function (d) {
        var conf = d.ai || {};
        if (conf.has_key) {
          state.aiServerAi = conf;
          el('lsBase').value = conf.base_url || '';
          el('lsModels').value = conf.model_text || '';
          el('lsVision').value = conf.model_vision || '';
          el('lsKey').placeholder = '已经存在账号里了（留空就不改）';
          var radio = document.querySelector('input[name=aiStore][value=server]');
          if (radio) { radio.checked = true; }
          state.aiStore = 'server';
        }
      }).catch(function () { });
    }
    if (isAdminAccount()) {
      api('/api/settings/ai').then(function (d) {
        var conf = (d && d.ai) || {};
        if (conf.base_url) { el('lsBase').value = conf.base_url; }
        if (conf.model_text) { el('lsModels').value = conf.model_text; }
        if (conf.model_vision) { el('lsVision').value = conf.model_vision; }
        el('lsKey').placeholder = conf.has_key ? '已保存，留空表示不改' : '粘贴你的密钥；本机代理可留空';
      }).catch(function () { });
    }
    if (window.StudyStore && window.StudyStore.settingsGet) {
      window.StudyStore.settingsGet('ai', null).then(function (conf) {
        if (!conf || !conf.base_url || aiStoreMode() === 'server') { return; }
        el('lsBase').value = conf.base_url || '';
        el('lsModels').value = conf.model_text || '';
        el('lsVision').value = conf.model_vision || '';
        el('lsKey').placeholder = '已经保存了密钥（留空就不改）';
      }).catch(function () { });
    }
    el('lsSave').onclick = function () {
      var payload = aiFormPayload();
      if (!String(payload.base_url || '').trim()) { toast('先选一个服务或者把接口地址填上', true); return; }
      if (!isAdminAccount() && aiStoreMode() === 'server' && !LOCAL) {
        api('/api/me/ai', { json: payload }).then(function () {
          el('lsKey').value = '';
          state.hasOwnAi = false;
          state.aiServerAi = { base_url: payload.base_url, has_key: true };
          if (window.StudyStore && window.StudyStore.settingsSet) { window.StudyStore.settingsSet('ai', null); }
          toast('已存到你的账号里，AI 功能可以用了');
        }).catch(function (e) { toast(e.message, true); });
        return;
      }
      api('/api/settings/ai', { json: payload }).then(function () {
        state.hasOwnAi = true;
        state.aiStore = 'browser';
        el('lsKey').value = '';
        if (!LOCAL) { api('/api/me/ai/clear', { json: {} }).catch(function () { }); }
        toast('已存在这个浏览器里，AI 功能可以用了');
      }).catch(function (e) { toast(e.message, true); });
    };
    el('lsTest').onclick = function () {
      el('lsOut').textContent = '正在测试…';
      var payload = aiFormPayload();
      var call = (!isAdminAccount() && aiStoreMode() === 'server' && !LOCAL)
        ? api('/api/me/ai/test', { json: payload })
        : api('/api/settings/ai/test', { json: {} });
      call.then(function (r) {
        var res = r.result || {};
        el('lsOut').textContent = '通了：' + (res.sample || res.model || '正常')
          + (r.via ? '（' + r.via + '）' : '');
      }).catch(function (e) { el('lsOut').textContent = '失败：' + e.message; });
    };
    el('lsClear').onclick = function () {
      el('lsBase').value = '';
      el('lsModels').value = '';
      el('lsVision').value = '';
      el('lsKey').value = '';
      if (window.StudyStore && window.StudyStore.settingsSet) { window.StudyStore.settingsSet('ai', null); }
      state.hasOwnAi = false;
      if (isAdminAccount()) { toast('表单已清空（没有改动全站配置）'); return; }
      if (!LOCAL) {
        api('/api/me/ai/clear', { json: {} }).then(function () {
          state.aiServerAi = null;
          toast('已经清空，AI 会回到站点统一配置');
        }).catch(function () { toast('已经清空本机的设置'); });
      } else { toast('已经清空'); }
    };
    if (el('lsLock')) {
      el('lsLock').onclick = function () {
        window.StudyGate.reset();
        toast('已忘记分享码，刷新后重新输入');
      };
    }
  }

  // ---------- 疑问解答 ----------
  function qaWho(item) {
    return item.answer_source === 'admin'
      ? ('管理员 ' + (item.answered_by || '') + ' 解答')
      : 'AI 解答';
  }

  function qaCard(item, isAdmin) {
    var canAi = !item.answer && (item.mine || isAdmin);
    return '<div class="card">' +
      '<div style="white-space:pre-wrap;font-size:15.5px"><b>' + esc(item.question) + '</b></div>' +
      '<div class="muted small" style="margin-top:5px">' + esc(item.username) + ' · ' + esc(item.asked_at) +
        ' · ' + (item.answer ? '<span class="tag ok">已解答</span>' : '<span class="tag warn">待解答</span>') + '</div>' +
      (item.answer
        ? ('<div class="muted small" style="margin-top:10px">' + esc(qaWho(item)) + ' · ' + esc(item.answered_at) + '</div>' +
           '<div class="md" style="margin-top:6px">' + md(item.answer) + '</div>')
        : '') +
      '<div class="row" style="margin-top:10px;align-items:center;gap:8px">' +
        (canAi ? '<button class="btn small" data-qaai="' + item.id + '">让 AI 解答</button>' : '') +
        ((item.mine || isAdmin) ? '<button class="btn small" data-qadel="' + item.id + '">删除</button>' : '') +
        '<span class="muted small" data-qaout="' + item.id + '"></span>' +
      '</div>' +
      (isAdmin ? ('<details style="margin-top:8px"><summary class="muted small">我来解答 / 修改解答</summary>' +
        '<textarea id="qaAns' + item.id + '" rows="4" placeholder="写下你的解答…">' + esc(item.answer_source === 'admin' ? item.answer : '') + '</textarea>' +
        '<div class="row" style="margin-top:6px"><button class="btn small primary" data-qasave="' + item.id + '">保存解答</button></div></details>') : '') +
    '</div>';
  }

  function viewQa(query) {
    var kw = (query && query.q) || '';
    el('app').innerHTML = '<div class="loading">正在读取…</div>';
    api('/api/qa' + (kw ? '?q=' + encodeURIComponent(kw) : '')).then(function (d) {
      var items = d.items || [];
      var isAdmin = !!d.is_admin;
      el('app').innerHTML =
        '<div class="wrap">' +
          '<div class="card"><h1>疑问解答</h1>' +
            '<div class="row" style="margin-top:10px;align-items:center;gap:8px">' +
              '<span class="muted small">共 ' + (d.total || 0) + ' 个问题，' + (d.open || 0) + ' 个待解答</span>' +
              '<span class="spacer"></span>' +
              '<input type="search" id="qaSearch" placeholder="搜索问题或解答" value="' + esc(kw) + '" style="max-width:240px">' +
            '</div>' +
            '<textarea id="qaAsk" rows="3" maxlength="1000" style="margin-top:10px" placeholder="把你没弄明白的地方写下来…"></textarea>' +
            '<div class="row" style="margin-top:8px;align-items:center;gap:10px">' +
              '<button class="btn primary" id="qaGo">提问</button>' +
              '<span class="muted small" id="qaMsg"></span>' +
            '</div>' +
          '</div>' +
          (items.length ? items.map(function (i) { return qaCard(i, isAdmin); }).join('')
            : '<div class="card"><p class="muted">还没有人提问。</p></div>') +
        '</div>';
      el('qaGo').onclick = function () {
        var text = (el('qaAsk').value || '').trim();
        if (!text) { toast('先写下你的问题', true); return; }
        el('qaGo').disabled = true;
        el('qaMsg').textContent = '正在提问…';
        api('/api/qa', { json: { question: text } }).then(function (r) {
          el('qaAsk').value = '';
          el('qaMsg').textContent = 'AI 正在解答…';
          return api('/api/qa/' + r.item.id + '/ai', { json: {} }).catch(function () {
            toast('问题已记下，AI 暂时没答上来，可以让管理员解答');
            return null;
          });
        }).then(function () {
          el('qaMsg').textContent = '';
          el('qaGo').disabled = false;
          viewQa(query);
        }).catch(function (e) {
          el('qaMsg').textContent = '';
          el('qaGo').disabled = false;
          toast(e.message, true);
        });
      };
      el('qaSearch').onkeydown = function (ev) {
        if (ev.key !== 'Enter') { return; }
        var v = (el('qaSearch').value || '').trim();
        location.hash = v ? ('#/qa?q=' + encodeURIComponent(v)) : '#/qa';
      };
      Array.prototype.forEach.call(document.querySelectorAll('[data-qaai]'), function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-qaai');
          var out = document.querySelector('[data-qaout="' + id + '"]');
          if (out) { out.textContent = 'AI 正在解答…'; }
          api('/api/qa/' + id + '/ai', { json: {} }).then(function () { viewQa(query); })
            .catch(function (e) { if (out) { out.textContent = ''; } toast(e.message, true); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-qasave]'), function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-qasave');
          api('/api/qa/' + id + '/answer', { json: { answer: el('qaAns' + id).value } })
            .then(function () { toast('解答已发布'); viewQa(query); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-qadel]'), function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-qadel');
          api('/api/qa/' + id + '/delete', { json: {} })
            .then(function () { toast('已删除'); viewQa(query); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
    }).catch(function (e) {
      el('app').innerHTML = '<div class="wrap"><div class="card">' + esc(e.message) + '</div></div>';
    });
  }

  // ---------- 用户反馈（提交给管理员） ----------
  var FEEDBACK_KINDS = [['suggestion', '功能建议'], ['bug', '问题反馈'], ['content', '内容需求'], ['other', '其他']];

  function fbKindLabel(k) {
    var out = k;
    FEEDBACK_KINDS.forEach(function (x) { if (x[0] === k) { out = x[1]; } });
    return out;
  }

  function fbStatusTag(s) {
    var m = { new: ['info', '已提交'], read: ['warn', '管理员已看'], done: ['ok', '已处理'] };
    var v = m[s] || ['info', s];
    return '<span class="tag ' + v[0] + '">' + v[1] + '</span>';
  }

  function feedbackCard() {
    var opts = FEEDBACK_KINDS.map(function (k) {
      return '<option value="' + k[0] + '">' + k[1] + '</option>';
    }).join('');
    return '<div class="card"><h2>反馈</h2>' +
      '<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">' +
        '<select id="fbKind" style="max-width:150px">' + opts + '</select>' +
        '<input type="text" id="fbContact" placeholder="联系方式（可不填）" style="flex:1;min-width:180px;max-width:320px">' +
      '</div>' +
      '<textarea id="fbText" rows="4" maxlength="2000" style="margin-top:8px" placeholder="写在这里：想加什么功能、哪里不好用、需要什么资料…"></textarea>' +
      '<div class="row" style="margin-top:8px;align-items:center;gap:10px">' +
        '<button class="btn primary" id="fbSend">提交反馈</button>' +
        '<span class="muted small" id="fbOut"></span>' +
      '</div>' +
      '<div id="fbMine" style="margin-top:14px"></div>' +
    '</div>';
  }

  function renderMyFeedback() {
    if (!el('fbMine')) { return; }
    api('/api/feedback').then(function (d) {
      var items = (d && d.items) || [];
      if (!items.length) { el('fbMine').innerHTML = '<p class="muted small">你还没有提交过反馈。</p>'; return; }
      el('fbMine').innerHTML = '<h3 style="margin:0 0 6px">我提交过的</h3>' + items.map(function (f) {
        return '<div style="border-top:1px solid var(--line);padding:10px 0">' +
          '<div>' + fbStatusTag(f.status) + ' <span class="tag">' + esc(fbKindLabel(f.kind)) + '</span>' +
          '<span class="muted small"> · ' + esc(f.created_at) + '</span></div>' +
          '<div style="white-space:pre-wrap;margin-top:5px">' + esc(f.content) + '</div>' +
          (f.reply ? '<div class="fb-answer"><b>管理员回复</b>：' + esc(f.reply) + '</div>' : '') +
        '</div>';
      }).join('');
    }).catch(function () { el('fbMine').innerHTML = ''; });
  }

  function bindFeedback() {
    if (!el('fbSend')) { return; }
    renderMyFeedback();
    el('fbSend').onclick = function () {
      var text = (el('fbText').value || '').trim();
      if (!text) { toast('先写点内容再提交', true); return; }
      el('fbSend').disabled = true;
      el('fbOut').textContent = '正在提交…';
      api('/api/feedback', { json: { kind: el('fbKind').value, content: text,
        contact: (el('fbContact').value || '').trim(), page: location.hash || '' } })
        .then(function () {
          el('fbText').value = '';
          el('fbOut').textContent = '提交成功，管理员已经能看到了。';
          toast('反馈已提交');
          renderMyFeedback();
        })
        .catch(function (e) { el('fbOut').textContent = '提交失败：' + e.message; })
        .then(function () { el('fbSend').disabled = false; });
    };
  }

  function viewMe() {
    el('app').innerHTML = '<div class="loading">正在读取…</div>';
    api('/api/me/dashboard').then(function (data) {
      var favs = data.favorites.map(function (i) { return itemCard(i, true); }).join('') || '<p class="muted">还没有收藏。</p>';
      var notes = data.notes.map(function (n) {
        return '<div style="margin-bottom:12px"><a href="#/m/' + n.material_id + '"><strong>' + esc(n.name) + '</strong></a>' +
          '<span class="muted small"> · ' + esc(n.subject) + ' · ' + esc(n.updated_at) + '</span>' +
          '<pre class="text" style="max-height:160px">' + esc(n.content) + '</pre></div>';
      }).join('') || '<p class="muted">还没有笔记。</p>';
      var attempts = data.attempts.map(function (a) {
        return '<tr><td><a href="#/m/' + a.material_id + '">' + esc(a.name) + '</a></td><td>' + esc(a.subject) + '</td>' +
          '<td>' + a.score + ' / ' + a.total + '</td><td class="muted small">' + esc(a.created_at) + '</td></tr>';
      }).join('');
      el('app').innerHTML =
        '<div class="wrap">' +
          '<div class="card"><h1>我的学习记录</h1>' +
            '<div class="row" style="margin-top:10px">' +
              '<a class="btn" href="#/export">导出我勾选的资料</a>' +
              '<button class="btn" id="meShare">生成分享版网页</button>' +
              (state.user && state.user.is_admin ? '<a class="btn" href="/admin">管理端（账号 / AI / 数据位置）</a>' : '') +
            '</div>' +
          '</div>' +
          profileCard() +
          passwordCard() +
          localSettingsCard() +
          installCard() +
          (LOCAL ? '' : feedbackCard()) +
          '<div class="card"><h2>收藏</h2><div class="grid g-card">' + favs + '</div></div>' +
          '<div class="card"><h2>我的笔记</h2>' + notes + '</div>' +
          '<div class="card"><h2>做题记录</h2>' + (attempts ? '<table><thead><tr><th>资料</th><th>分类</th><th>得分</th><th>时间</th></tr></thead><tbody>' + attempts + '</tbody></table>' : '<p class="muted">还没有做过题。</p>') + '</div>' +
        '</div>';
      if (el('meShare')) { el('meShare').onclick = function () { location.hash = '#/export'; }; }
      bindProfileCard();
      bindPasswordCard();
      bindLocalSettings();
      bindInstall();
      bindFeedback();
    }).catch(function (e) { el('app').innerHTML = '<div class="wrap"><div class="card">' + esc(e.message) + '</div></div>'; });
  }

  // ---------- 加到桌面（PWA） ----------
  // 电脑版 Chrome / Edge 和安卓会发 beforeinstallprompt，先把它存下来，等用户点按钮再触发。
  var installPrompt = null;
  try {
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      installPrompt = ev;
      if (state.user && location.hash.indexOf('#/me') === 0) { viewMe(); }
    });
    window.addEventListener('appinstalled', function () { installPrompt = null; });
  } catch (e) {}

  function isStandalone() {
    try {
      if (window.navigator.standalone) { return true; }
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }

  function isIos() {
    var ua = String((window.navigator && window.navigator.userAgent) || '');
    try {
      return /iPad|iPhone|iPod/.test(ua)
        || (/Macintosh/.test(ua) && (window.navigator.maxTouchPoints || 0) > 1);
    } catch (e) { return false; }
  }

  function installCard() {
    if (isStandalone()) { return ''; }
    var body;
    if (installPrompt) {
      body = '<button class="btn primary" id="pwaGo">安装到桌面</button>' +
        '<span class="muted small">装完就像 App 一样，从桌面图标直接打开。</span>';
    } else if (isIos()) {
      body = '<span class="muted small">Safari 里点底部的「分享」按钮，再选「添加到主屏幕」。</span>';
    } else {
      body = '<span class="muted small">用手机或电脑版 Chrome / Edge 打开本站，' +
        '在浏览器菜单里选「安装应用 / 添加到主屏幕」。</span>';
    }
    return '<div class="card"><h2>加到桌面</h2><div class="row" style="margin-top:8px">' + body + '</div></div>';
  }

  function bindInstall() {
    if (!el('pwaGo')) { return; }
    el('pwaGo').onclick = function () {
      var ev = installPrompt;
      if (!ev) { return; }
      installPrompt = null;
      el('pwaGo').disabled = true;
      try { ev.prompt(); } catch (e) {}
      if (ev.userChoice && ev.userChoice.then) {
        ev.userChoice.then(function () { viewMe(); })['catch'](function () { viewMe(); });
      } else {
        viewMe();
      }
    };
  }

  // ---------- 文件夹模式 ----------
  function folderSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) { return n + ' B'; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(0) + ' KB'; }
    if (n < 1024 * 1024 * 1024) { return (n / 1048576).toFixed(1) + ' MB'; }
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function folderWhen(stamp) {
    if (!stamp) { return '还没扫过'; }
    var date = new Date(stamp);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function viewFolder() {
    var F = window.StudyFolder;
    var head = '<div class="card"><h1>文件夹模式</h1>' +
      '<p class="muted small">选一个你电脑上的资料文件夹：<b>顶层文件夹当分类、后缀当类型</b>，文字提到你自己的浏览器里，' +
      '之后就能在「搜索」和「AI 问答」里找到；文件不上传、不占别人空间。</p>' +
      '</div>';
    var canHandle = !!(F && F.supported());
    var canCompat = !!(F && F.compatSupported && F.compatSupported());
    if (!F || (!canHandle && !canCompat)) {
      el('app').innerHTML = '<div class="wrap">' + head +
        '<div class="card"><p class="badge warn">现在用不了</p>' +
        '<p class="muted small">' + esc(F ? F.why() : '文件夹模块没有加载，请 Ctrl+F5 强刷。') + '</p>' +
        '<p class="muted small">手机浏览器都不支持读文件夹，这条只有电脑版 Chrome / Edge 能用；也可以先到「上传」把文件放进浏览器。</p>' +
        '<div class="row"><a class="btn" href="#/upload">去上传</a></div></div></div>';
      return;
    }
    el('app').innerHTML = '<div class="wrap">' + head +
      '<div class="card" id="foTop">正在检查…</div>' +
      '<div id="foList"></div></div>';
    F.rootInfo().then(function (saved) {
      if (saved && saved.handle) { renderFolderSaved(); return; }
      return F.compatRoot().then(function (compat) {
        if (compat) { renderFolderSaved(); return; }
        renderFolderPick();
      });
    }).catch(function () { renderFolderPick(); });
  }

  function renderFolderPick() {
    var F = window.StudyFolder;
    var canHandle = !!(F && F.supported());
    var canCompat = !!(F && F.compatSupported && F.compatSupported());
    el('foTop').innerHTML =
      '<h2>还没有选文件夹</h2>' +
      '<p class="muted small">选你放资料的根目录（例如「学习资料」这样的总目录）。' +
      (canHandle ? '选的时候：点一下文件夹，再点右下角「选择文件夹」（双击是“进入”，不算选中）。' : '') + '</p>' +
      '<div class="row" style="margin-top:12px">' +
        (canHandle ? '<button class="btn primary" id="foPick">选择文件夹</button>' : '') +
        (canCompat ? '<button class="btn' + (canHandle ? '' : ' primary') + '" id="foCompat">兼容扫描</button>' : '') +
        '<a class="btn" href="#/upload">改用上传</a></div>' +
      (canCompat ? '<p class="muted small" style="margin-top:8px">这个浏览器打不开系统“选文件夹”窗口时就用「兼容扫描」：' +
        '只读、当次有效（关掉页面要重选一次，再选同一个文件夹就接回来了）。</p>' : '') +
      '<p class="muted small" id="foWhy"></p>';
    el('foList').innerHTML = '';
    bindFolderPick();
  }

  function bindFolderPick() {
    var F = window.StudyFolder;
    function fail(e, btn, label) {
      folderToast(e);
      if (btn) { btn.disabled = false; btn.textContent = label; }
      refreshFolderAfterPickFail();
      showFolderWhy(e);
    }
    if (el('foPick')) {
      el('foPick').onclick = function () {
        el('foPick').disabled = true;
        el('foPick').textContent = '正在扫描…';
        F.pick().then(function (snap) {
          toast('已连接：' + (snap.folder || '文件夹') + '（' + snap.docs.length + ' 个文件）');
          viewFolder();
        }).catch(function (e) { fail(e, el('foPick'), '选择文件夹'); });
      };
    }
    if (el('foCompat')) {
      el('foCompat').onclick = function () {
        el('foCompat').disabled = true;
        el('foCompat').textContent = '正在扫描…';
        F.compatPickFiles().then(function (files) {
          return F.compatScan(files, { onProgress: function (p) {
            if (el('foCompat')) { el('foCompat').textContent = '正在提取 ' + p.done + '/' + p.total + '…'; }
          } });
        }).then(function (snap) {
          toast('已连接：' + (snap.folder || '文件夹') + '（' + snap.docs.length + ' 个文件）');
          viewFolder();
        }).catch(function (e) { fail(e, el('foCompat'), '兼容扫描'); });
      };
    }
  }

  // 兼容扫描模式下「重新扫描」：要再弹一次选文件夹窗口，把文件对象接回来。
  function compatRepick(F, msg) {
    if (el('foMsg')) { el('foMsg').textContent = msg; }
    F.compatPickFiles().then(function (files) {
      return F.compatScan(files, { onProgress: function (p) {
        if (el('foMsg')) { el('foMsg').textContent = '正在提取文字 ' + p.done + '/' + p.total + '：' + p.name; }
      } });
    }).then(function (res) {
      toast('重新扫描完成：' + res.docs.length + ' 个文件');
      viewFolder();
    }).catch(function (e) {
      if (el('foMsg')) { el('foMsg').textContent = e.message; }
      folderToast(e);
    });
  }

  function renderFolderSaved(saved) {
    var F = window.StudyFolder;
    el('foTop').innerHTML = '<h2>正在扫描…</h2><p class="muted small">第一次扫描文件多的时候要几秒钟。</p>';
    F.snapshot().then(function (snap) {
      if (!snap) {
        return F.scan({ onProgress: function (p) {
          if (el('foTop')) {
            el('foTop').innerHTML = '<h2>正在提取文字…</h2><p class="muted small">'
              + esc(p.done + '/' + p.total + '：' + p.name) + '</p>';
          }
        } });
      }
      return snap;
    }).then(function (snap) {
      return F.stats().then(function (st) { return { snap: snap, st: st }; });
    }).then(function (pack) {
      var snap = pack.snap;
      var st = pack.st || {};
      var isCompat = !!(snap && snap.compat);
      var docs = (snap && snap.docs) || [];
      var subjects = {};
      docs.forEach(function (doc) { subjects[doc.subject] = (subjects[doc.subject] || 0) + 1; });
      var kinds = {};
      docs.forEach(function (doc) { kinds[doc.kind] = (kinds[doc.kind] || 0) + 1; });
      var totalBytes = docs.reduce(function (sum, doc) { return sum + (doc.size || 0); }, 0);
      el('foTop').innerHTML =
        '<h2>已连接：' + esc(snap.folder || '（未命名文件夹）') + '</h2>' +
        '<p class="muted small">上次扫描：' + esc(folderWhen(snap.scannedAt)) +
          '　·　共 <b>' + docs.length + '</b> 个文件 / ' + folderSize(totalBytes) +
          '　·　' + Object.keys(subjects).length + ' 个分类' +
          (snap.skipped ? '　·　跳过 ' + snap.skipped + ' 个读不了的文件' : '') + '</p>' +
        '<p class="muted small">可搜索 <b>' + st.searchable + '</b> 份' +
          (st.waiting ? '　·　等待提取 ' + st.waiting + ' 份' : '') +
          (st.need_ai ? '　·　待识别（图片 / 扫描件）' + st.need_ai + ' 份' : '') +
          (st.total > 800 ? '　·　文件很多，提取会跑一会儿，可以随时关页面，下次继续' : '') + '</p>' +
        '<div class="row small" style="margin-top:6px">' +
          Object.keys(kinds).sort().map(function (k) {
            return '<span class="badge">' + esc(F.kindLabel(k)) + ' ' + kinds[k] + '</span>';
          }).join('') +
        '</div>' +
        (isCompat ? '<p class="muted small">兼容扫描：只读、当次有效。关掉页面后文字还能搜到，但文件要重选一次才能打开；' +
          '「导出到文件夹」要句柄，电脑版 Edge / Chrome 才有。</p>' : '') +
        '<div class="row" style="margin-top:12px">' +
          '<button class="btn primary" id="foRefresh">' + (isCompat ? '重新扫描' : '立即刷新') + '</button>' +
          '<button class="btn" id="foIndex">提取文字</button>' +
          '<button class="btn" id="foRepick">' + (isCompat ? '兼容扫描（重选文件夹）' : '重新选择文件夹') + '</button>' +
          (isCompat ? '' : '<button class="btn" id="foExport">把我的笔记导出到这里</button>') +
          '<button class="btn" id="foForget">' + (isCompat ? '忘掉这个文件夹' : '忘记这个文件夹') + '</button>' +
        '</div>' +
        '<p class="muted small" style="margin-top:8px" id="foMsg"></p>';
      el('foRefresh').onclick = function () {
        if (isCompat) { return compatRepick(F, '正在重新扫描…'); }
        el('foMsg').textContent = '正在增量扫描…';
        F.scan({ onProgress: function (p) {
          el('foMsg').textContent = '正在提取文字 ' + p.done + '/' + p.total + '：' + p.name;
        } }).then(function (res) {
          el('foMsg').textContent = '刷新完成：新增 ' + res.added + ' 个，内容变了 ' + res.changed
            + ' 个，不见了 ' + res.removed + ' 个，共 ' + res.docs.length + ' 个文件。';
          toast('刷新完成');
          viewFolder();
        }).catch(function (e) {
          el('foMsg').textContent = e.message;
          folderToast(e);
        });
      };
      el('foIndex').onclick = function () {
        el('foIndex').disabled = true;
        el('foMsg').textContent = '正在提取文字…';
        F.indexPending({ onProgress: function (p) {
          el('foMsg').textContent = '正在提取 ' + p.done + '/' + p.total + '：' + p.name;
        } }).then(function () {
          return F.stats();
        }).then(function (st2) {
          toast('已可搜索：' + st2.searchable + ' 份');
          viewFolder();
        }).catch(function (e) {
          el('foMsg').textContent = e.message;
          folderToast(e);
          el('foIndex').disabled = false;
        });
      };
      el('foRepick').onclick = function () {
        if (isCompat) { return compatRepick(F, '正在重新扫描…'); }
        F.pick().then(function () { toast('已重新扫描'); viewFolder(); })
          .catch(function (e) { folderToast(e); refreshFolderAfterPickFail(); showFolderWhy(e); });
      };
      if (el('foExport')) {
        el('foExport').onclick = function () {
          exportNotesToFolder();
        };
      }
      el('foForget').onclick = function () {
        UI.confirm('忘记之后不会再读那个文件夹，下次要重新选择。确定吗？').then(function (yes) {
          if (!yes) { return; }
          F.forget().then(function () { toast('已经忘记'); viewFolder(); });
        });
      };
      F.docs().catch(function () { return []; }).then(function (recs) { renderFolderList(docs, recs); });
    }).catch(function (e) {
      var extra = e && e.needPermission
        ? '<div class="row" style="margin-top:10px"><button class="btn primary" id="foRepick2">重新授权</button></div>' : '';
      el('foTop').innerHTML = '<h2>读不了这个文件夹</h2><p class="muted small">' + esc(e.message) + '</p>' + extra;
      if (el('foRepick2')) {
        el('foRepick2').onclick = function () {
          F.pick().then(function () { viewFolder(); }).catch(function (err) {
            folderToast(err); refreshFolderAfterPickFail(); showFolderWhy(err);
          });
        };
      }
      el('foList').innerHTML = '';
    });
  }

  function renderFolderList(docs, recs) {
    var F = window.StudyFolder;
    var byId = {};
    (recs || []).forEach(function (r) { byId[r.id] = r; });
    var groups = {};
    docs.forEach(function (doc) { (groups[doc.subject] = groups[doc.subject] || []).push(doc); });
    var names = Object.keys(groups).sort();
    if (!names.length) {
      el('foList').innerHTML = '<div class="card">这个文件夹里没有找到能识别的文件。</div>';
      return;
    }
    el('foList').innerHTML = names.map(function (name) {
      var items = groups[name].slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
      var shown = items.slice(0, 200);
      return '<div class="card"><h2>' + esc(name) + ' <span class="badge">' + items.length + ' 个文件</span></h2>' +
        '<table><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>能否搜索</th><th></th></tr></thead><tbody>' +
        shown.map(function (doc) {
          var rec = byId[doc.id] || {};
          var mark = '<span class="badge warn">待提取</span>';
          var vision = '';
          if (rec.has_text) {
            mark = '<span class="badge ok">可搜索</span>';
          } else if (doc.kind === 'video') {
            mark = '<span class="muted small">不索引</span>';
          } else if (doc.kind === 'image' || doc.kind === 'pdf') {
            mark = '<span class="badge warn">待识别</span>';
            if (doc.origin !== 'compat' || F.sessionFile(doc.relPath)) {
              vision = '<button class="btn small" data-vision="' + esc(doc.relPath) + '">AI 识别</button>';
            }
          }
          return '<tr><td>' + esc(doc.name) + '</td><td><span class="badge">' + esc(F.kindLabel(doc.kind)) + '</span></td>' +
            '<td class="muted small">' + folderSize(doc.size) + '</td>' +
            '<td>' + mark + '</td>' +
            '<td>' + (doc.origin === 'compat' && !F.sessionFile(doc.relPath)
              ? '<span class="muted small">重选文件夹后可打开</span>'
              : '<button class="btn small" data-open="' + esc(doc.relPath) + '">打开</button>') + vision + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
        (items.length > shown.length ? '<p class="muted small">（只列出前 200 个，用「立即刷新」更新）</p>' : '') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(el('foList').querySelectorAll('[data-open]'), function (node) {
      node.onclick = function () {
        var rel = node.getAttribute('data-open');
        node.disabled = true;
        node.textContent = '打开中…';
        F.fileOf(rel).then(function (file) {
          var url = URL.createObjectURL(file);
          window.open(url, '_blank');
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          node.disabled = false;
          node.textContent = '打开';
        }).catch(function (e) {
          folderToast(e);
          node.disabled = false;
          node.textContent = '打开';
        });
      };
    });
    Array.prototype.forEach.call(el('foList').querySelectorAll('[data-vision]'), function (node) {
      node.onclick = function () {
        var rel = node.getAttribute('data-vision');
        node.disabled = true;
        node.textContent = '识别中…';
        F.visionOne(rel).then(function () {
          toast('已加入搜索');
          viewFolder();
        }).catch(function (e) {
          folderToast(e);
          node.disabled = false;
          node.textContent = 'AI 识别';
        });
      };
    });
  }

  function exportNotesToFolder() {
    var F = window.StudyFolder;
    var msg = el('foMsg');
    if (msg) { msg.textContent = '正在整理你的笔记…'; }
    // 选文件夹时只给了“读”，写权限要单独点一次“允许”；这一步必须紧跟着这次点击，晚了浏览器就不认。
    F.ensureWritable().then(function () { return api('/api/me/dashboard'); }).then(function (data) {
      var notes = data.notes || [];
      if (!notes.length) { toast('你还没有笔记，先去资料页写一条吧', true); return; }
      var chain = Promise.resolve();
      var done = 0;
      var stamp = new Date().toLocaleString('zh-CN', { hour12: false });
      chain = chain.then(function () {
        return F.writeText('学习网页导出', 'index.md',
          '# 学习网页导出\n\n导出时间：' + stamp + '\n\n共 ' + notes.length + ' 条笔记。\n\n'
          + notes.map(function (n, i) { return (i + 1) + '. ' + n.name + '（' + n.subject + '）'; }).join('\n') + '\n');
      });
      notes.forEach(function (note) {
        var body = '# ' + note.name + '\n\n分类：' + note.subject + '\n\n更新时间：'
          + (note.updated_at || '') + '\n\n---\n\n' + (note.content || '');
        chain = chain.then(function () {
          return F.writeText('学习网页导出/笔记/' + (note.subject || '未分类'),
            String(note.name).replace(/\.[^.]+$/, '') + '.md', body);
        }).then(function () {
          done++;
          if (msg) { msg.textContent = '正在写入 ' + done + ' / ' + notes.length + ' …'; }
        });
      });
      return chain.then(function () {
        if (msg) { msg.textContent = '导出完成：' + notes.length + ' 条笔记已写入「学习网页导出/笔记」。'; }
        toast('已导出到你的文件夹');
      });
    }).catch(function (e) {
      if (msg) { msg.textContent = '导出失败：' + e.message; }
      toast(e.message, true);
    });
  }

  // ---------- 外观 / 主题中心 ----------
  function siteName() {
    return ((state.site && state.site.name) || (state.overview && state.overview.site
      && state.overview.site.name) || '学习网页');
  }

  function themeState() {
    return window.StudyTheme ? window.StudyTheme.current() : { preset: 'light' };
  }

  function themeCardsHtml() {
    if (!window.StudyTheme) { return ''; }
    var cur = themeState();
    var presets = window.StudyTheme.presets;
    return Object.keys(presets).map(function (key) {
      var vars = presets[key].vars || {};
      var bg = vars['--bg'] || '#f6f8fa';
      var card = vars['--card'] || '#ffffff';
      var accent = vars['--accent'] || '#2563eb';
      return '<button class="theme-card' + (cur.preset === key ? ' on' : '') + '" data-theme="' + esc(key) + '">' +
        '<div class="sw"><i style="background:' + esc(bg) + '"></i><i style="background:' + esc(card) + '"></i>' +
        '<i style="background:' + esc(accent) + '"></i></div>' +
        '<div class="t">' + esc(presets[key].label) + '</div></button>';
    }).join('');
  }

  function viewAppearance() {
    if (!window.StudyTheme) {
      el('app').innerHTML = '<div class="wrap"><div class="card">外观模块没有加载成功，请 Ctrl+F5 强刷一次。</div></div>';
      return;
    }
    var cur = themeState();
    state.themeDraft = null;
    var allow = !state.site || state.site.allow_user_theme !== false;
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h1>外观 / 主题</h1>' +
          (allow ? '' : '<p class="badge warn">管理员关闭了自定义外观，你现在看到的样式由站点统一决定。</p>') +
          (allow ? '<div class="theme-grid" id="themeGrid">' + themeCardsHtml() + '</div>' : '') +
        '</div>' +
        (allow ? (
        '<div class="card"><h2>细调</h2>' +
          '<div class="fields">' +
            '<label>主色<input type="color" id="thAccent" value="' + esc(cur.accent || '#2563eb') + '"></label>' +
            '<label>字号 <span class="muted" id="thScaleVal">' + cur.scale + '%</span>' +
              '<input type="range" id="thScale" min="85" max="130" step="5" value="' + cur.scale + '"></label>' +
            '<label>圆角 <span class="muted" id="thRadiusVal">' + cur.radius + 'px</span>' +
              '<input type="range" id="thRadius" min="0" max="24" step="2" value="' + cur.radius + '"></label>' +
            '<label>背景色（留空用预设）<input type="text" id="thBg" placeholder="例如 #101418" value="' + esc(cur.bg || '') + '"></label>' +
            '<label>卡片色（留空用预设）<input type="text" id="thCard" placeholder="例如 #171d26" value="' + esc(cur.card || '') + '"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:12px">' +
            '<label class="small"><input type="checkbox" id="thCompact"' + (cur.compact ? ' checked' : '') + '> 紧凑模式</label>' +
            '<label class="small"><input type="checkbox" id="thFollow"' + (cur.follow ? ' checked' : '') + '> 跟随系统深浅色</label>' +
          '</div>' +
          '<h3>背景壁纸</h3>' +
          '<div class="row"><input type="file" id="thWall" accept="image/*"><button class="btn small" id="thWallClear">去掉壁纸</button></div>' +
          (cur.wallpaper ? '<img class="wall-prev" id="thWallPrev" src="' + esc(cur.wallpaper) + '" alt="壁纸预览">' : '') +
          '<div class="row" style="margin-top:14px">' +
            '<button class="btn primary" id="thSave">保存</button>' +
            '<button class="btn" id="thReset">恢复默认</button>' +
            '<span class="muted small" id="thOut"></span>' +
          '</div>' +
        '</div>') : '') +
      '</div>';

    function draft() {
      var out = JSON.parse(JSON.stringify(state.themeDraft || themeState()));
      if (el('thAccent')) { out.accent = el('thAccent').value; }
      if (el('thScale')) { out.scale = parseInt(el('thScale').value, 10); }
      if (el('thRadius')) { out.radius = parseInt(el('thRadius').value, 10); }
      if (el('thBg')) { out.bg = (el('thBg').value || '').trim(); }
      if (el('thCard')) { out.card = (el('thCard').value || '').trim(); }
      if (el('thCompact')) { out.compact = el('thCompact').checked; }
      if (el('thFollow')) { out.follow = el('thFollow').checked; }
      return out;
    }

    function preview() {
      window.StudyTheme.apply(draft());
      if (el('thScaleVal')) { el('thScaleVal').textContent = el('thScale').value + '%'; }
      if (el('thRadiusVal')) { el('thRadiusVal').textContent = el('thRadius').value + 'px'; }
    }

    if (el('themeGrid')) {
      Array.prototype.forEach.call(el('themeGrid').querySelectorAll('[data-theme]'), function (node) {
        node.onclick = function () {
          var next = draft();
          next.preset = node.getAttribute('data-theme');
          next.accent = '';
          next.bg = '';
          next.card = '';
          next.fg = '';
          state.themeDraft = next;
          window.StudyTheme.apply(next);
          Array.prototype.forEach.call(el('themeGrid').querySelectorAll('[data-theme]'), function (other) {
            other.className = 'theme-card';
          });
          node.className = 'theme-card on';
          toast('已预览：' + (window.StudyTheme.presets[next.preset] || {}).label + '，记得点保存');
        };
      });
      ['thAccent', 'thScale', 'thRadius', 'thBg', 'thCard', 'thCompact', 'thFollow'].forEach(function (id) {
        if (el(id)) { el(id).oninput = preview; el(id).onchange = preview; }
      });
    }
    if (el('thWall')) {
      el('thWall').onchange = function () {
        var file = this.files && this.files[0];
        this.value = '';
        if (!file) { return; }
        if (file.size > 4 * 1024 * 1024) { toast('壁纸图片太大了（超过 4 MB），换一张小一点的', true); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var next = draft();
          next.wallpaper = String(reader.result || '');
          window.StudyTheme.apply(next);
          state.themeDraftWall = next.wallpaper;
          toast('壁纸已预览，点保存才会记住');
        };
        reader.readAsDataURL(file);
      };
    }
    if (el('thWallClear')) {
      el('thWallClear').onclick = function () {
        state.themeDraftWall = '';
        var next = draft();
        next.wallpaper = '';
        window.StudyTheme.apply(next);
        toast('壁纸已去掉，点保存才会记住');
      };
    }
    function saveTheme(theme, done) {
      if (!window.StudyTheme) { return; }
      window.StudyTheme.save(theme, { server: !!(state.user && !LOCAL) }).then(function () {
        state.themeDraft = null;
        toast('外观已保存' + (state.user && !LOCAL ? '（跟着账号走）' : ''));
        if (done) { done(); }
      }).catch(function (e) {
        window.StudyTheme.save(theme);
        toast('保存到账号失败，已经先存在这台设备上：' + e.message, true);
      });
    }
    if (el('thSave')) {
      el('thSave').onclick = function () {
        var next = draft();
        if (state.themeDraftWall !== undefined) { next.wallpaper = state.themeDraftWall; }
        saveTheme(next, function () { viewAppearance(); });
      };
    }
    if (el('thReset')) {
      el('thReset').onclick = function () {
        state.themeDraftWall = '';
        saveTheme(window.StudyTheme.defaults, function () { viewAppearance(); });
      };
    }
  }

  // ---------- 我的账号 ----------
  function profileCard() {
    var u = state.user || {};
    var avatars = state.avatars || ['🙂', '🐱', '🐼', '🦊', '🐳', '🌱', '🍀', '⭐', '🚀', '🎧', '📚', '⚡'];
    var current = u.avatar || '🙂';
    var av = avatars.map(function (a) {
      return '<button class="btn small' + (a === current ? ' primary' : '') + '" data-av="' + esc(a) + '">' + a + '</button>';
    }).join('');
    if (LOCAL) {
      return '<div class="card"><h2>我的账号</h2><p class="muted small">这是分享单文件版，没有账号系统。' +
        '数据都在你自己的浏览器里；外观可以在 <a href="#/appearance">外观 / 主题</a> 里改。</p></div>';
    }
    return '<div class="card"><h2>我的账号</h2>' +
      '<div class="fields">' +
        '<label>昵称（可以留空，默认显示用户名）<input type="text" id="pfNick" name="study-nickname" autocomplete="off" maxlength="20" value="' +
          esc(u.nickname || '') + '" placeholder="' + esc(u.username || '') + '"></label>' +
      '</div>' +
      '<div style="margin-top:10px"><div class="muted small">头像</div>' +
        '<div class="row" id="pfAvatars" style="margin-top:6px">' + av + '</div></div>' +
      '<div class="row" style="margin-top:12px">' +
        '<button class="btn primary small" id="pfSave">保存头像昵称</button>' +
        '<a class="btn small" href="#/appearance">外观 / 主题</a>' +
      '</div>' +
      '</div>';
  }

  // 改密码单独一张卡：不跟昵称之类的文本框混在一起，浏览器就不会把登录信息自动填进昵称里。
  function passwordCard() {
    return '<div class="card"><h2>改密码</h2>' +
      '<div class="fields">' +
        '<label>原来的密码<input type="password" id="pwOld" name="study-old-password" autocomplete="off"></label>' +
        '<label>新密码（至少 6 位）<input type="password" id="pwNew" name="study-new-password" autocomplete="new-password"></label>' +
      '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn small" id="pwGo">改密码</button>' +
        '<button class="btn small" id="logoutAll">登出全部设备</button>' +
      '</div>' +
      '</div>';
  }

  function bindProfileCard() {
    if (!el('pfSave')) { return; }
    var picked = (state.user && state.user.avatar) || '🙂';
    Array.prototype.forEach.call(el('pfAvatars').querySelectorAll('[data-av]'), function (node) {
      node.onclick = function () {
        picked = node.getAttribute('data-av');
        Array.prototype.forEach.call(el('pfAvatars').querySelectorAll('[data-av]'), function (other) {
          other.className = 'btn small';
        });
        node.className = 'btn small primary';
      };
    });
    el('pfSave').onclick = function () {
      api('/api/me/prefs', { json: { nickname: el('pfNick').value, avatar: picked } }).then(function (r) {
        if (r.prefs) {
          state.user.nickname = r.prefs.nickname;
          state.user.avatar = r.prefs.avatar;
        }
        toast('已保存');
        renderTop();
        viewMe();
      }).catch(function (e) { toast(e.message, true); });
    };
  }

  function bindPasswordCard() {
    if (!el('pwGo')) { return; }
    el('pwGo').onclick = function () {
      el('pwGo').disabled = true;
      api('/api/me/password', { json: { old: el('pwOld').value, new: el('pwNew').value } }).then(function (r) {
        el('pwOld').value = '';
        el('pwNew').value = '';
        toast((r && r.note) || '密码已修改');
      }).catch(function (e) { toast(e.message, true); })
        .then(function () { el('pwGo').disabled = false; });
    };
    el('logoutAll').onclick = function () {
      UI.confirm('确定要登出全部设备吗？其它设备需要重新登录。').then(function (yes) {
        if (!yes) { return; }
        api('/api/me/logout-all', { json: {} }).then(function () {
          toast('已经登出其它设备');
        }).catch(function (e) { toast(e.message, true); });
      });
    };
  }

  // ---------- 索引进度 ----------
  function viewIndex() {
    if (LOCAL) {
      el('app').innerHTML = '<div class="wrap"><div class="card"><h1>本机模式</h1>' +
        '<p class="muted small">这是分享给别人的单文件版本，资料都在你自己的浏览器里，不需要索引队列。' +
        '上传后会自动提取文字；图片和扫描件可以在资料页点“AI 识别文字”。</p>' +
        '<a class="btn" href="#/me">去看 AI 接入设置</a></div></div>';
      return;
    }
    if (!state.user || !state.user.is_admin) {
      el('app').innerHTML = '<div class="wrap"><div class="card"><h1>你的资料存在自己电脑上</h1>' +
        '<p class="muted small">这个网站里，管理员以外的账号（包括你）上传的资料、笔记、收藏、做题记录都只存在你自己的浏览器里，' +
        '不会上传到这台电脑，也不占它的硬盘。</p>' +
        '<p class="muted small">上传后浏览器会自动提取文字，可以直接搜索；图片和扫描件到资料页点「AI 识别文字」，' +
        '用你自己在「我的 → AI 接入」里填的密钥识别。</p>' +
        '<div class="row" style="margin-top:10px">' +
          '<a class="btn" href="#/upload">去上传资料</a>' +
          '<a class="btn" href="#/me">AI 接入设置</a>' +
        '</div></div></div>';
      return;
    }
    el('app').innerHTML = '<div class="loading">正在读取索引进度…</div>';
    api('/api/index/status').then(function (data) {
      var s = data.status;
      var phaseText = { idle: '空闲（没有排队任务）', text: '正在提取文字', vision: '正在看图识别', paused: '已暂停' };
      el('app').innerHTML =
        '<div class="wrap">' +
          '<div class="card"><h1>索引进度</h1>' +
            '<p class="muted small">第一级处理文字资料（快），第二级用 AI 识别扫描件和图片（慢，但关掉页面也会继续在后台跑）。</p>' +
            '<div class="row" style="margin-top:12px">' +
              '<button class="btn small primary" id="idxStart">开始 / 继续</button>' +
              '<button class="btn small" id="idxPause">暂停</button>' +
              '<button class="btn small" id="idxRescan">重新扫描文件夹</button>' +
              '<button class="btn small" id="idxRequeue">重试失败项</button>' +
            '</div>' +
          '</div>' +
          '<div class="card"><h2>当前状态</h2>' +
            '<div class="grid g-stat">' +
              statBox('状态', phaseText[s.phase] || s.phase, s.running ? '正在运行' : '未运行') +
              statBox('已索引资料', s.indexed + ' / ' + s.total, '有文字可搜索') +
              statBox('待提取文字', s.text_pending, '第一级队列') +
              statBox('待看图识别', s.vision_pending, '第二级队列') +
              statBox('失败', s.failed, '可点上面的重试') +
              statBox('无法解析', s.unreadable || 0, '源文件本身的问题') +
            '</div>' +
            '<p class="small muted" style="margin-top:12px" id="idxCur">' + (s.current ? ('正在处理：' + esc(s.current.name) + '（第 ' + s.current.phase + ' 级）') : '当前没有正在处理的文件。') + '</p>' +
            (s.last_error ? '<p class="small" style="color:var(--danger)">最近错误：' + esc(s.last_error) + '</p>' : '') +
          '</div>' +
          '<div class="card"><h2>读不出来的文件</h2>' +
            '<p class="muted small">这些是原始资料本身的问题（文件是空的、格式不对、复制或下载时损坏）。' +
            '程序只读不改，一个字节都不会动你的资料，所以这类文件重试也没用，' +
            '要么自己另存/重新拷一份，要么就这样放着（不影响其它资料的搜索和 AI）。</p>' +
            '<button class="btn small" id="idxBad">看看是哪些、为什么</button>' +
            '<div id="badOut" style="margin-top:10px"></div>' +
          '</div>' +
          (state.user && state.user.is_admin
            ? '<div class="card"><h2>AI 通道（只有管理员能看到这块）</h2>' +
                '<p class="muted small">AI 问答、AI 摘要、看图识字、自动出题都要连一个“大模型接口”。默认指向这台电脑上的本机代理（不用密钥、不花钱），只要 CC Switch 开着就能用。' +
                '想换成 DeepSeek、硅基流动、阿里云百炼、智谱等云端服务，到 <a href="/admin">管理端 → 系统设置</a> 填地址和密钥即可。</p>' +
                '<div class="row" style="margin-top:10px">' +
                  '<button class="btn small" id="idxPing">检测模型是否可用</button>' +
                  '<a class="btn small" href="/admin">打开管理端设置</a>' +
                  '<span class="muted small" id="pingOut"></span>' +
                '</div>' +
              '</div>'
            : '<div class="card"><h2>AI 功能</h2>' +
                '<p class="muted small">' + (canUseAi()
                  ? 'AI 问答、AI 摘要、看图识字、自动出题由管理员统一配置，你不用设置。如果一直报错，联系管理员就好。'
                  : '管理员目前没有开放共用 AI（免得额度被用光）。要用这些功能，可以让管理员在「管理端 → 系统设置」里打开「允许局域网共用我的 AI」。') + '</p>' +
                '<div class="row" style="margin-top:10px">' +
                  '<button class="btn small" id="idxPing">检测一下现在能不能用</button>' +
                  '<span class="muted small" id="pingOut"></span>' +
                '</div>' +
              '</div>') +
          '<div class="card"><h2>原始资料完整性自检</h2>' +
            '<p class="muted small">用来证明程序从来没有改动过你的原始资料文件夹里的任何文件。</p>' +
            '<button class="btn small" id="idxSelf">运行自检</button><div id="selfOut" style="margin-top:10px"></div>' +
          '</div>' +
        '</div>';
      el('idxStart').onclick = function () { control('start'); };
      el('idxPause').onclick = function () { control('pause'); };
      el('idxRescan').onclick = function () { control('rescan'); };
      el('idxRequeue').onclick = function () { control('requeue'); };
      el('idxBad').onclick = function () {
        el('badOut').innerHTML = '<span class="muted">正在读取…</span>';
        api('/api/index/failed').then(function (r) {
          if (!r.items.length) {
            el('badOut').innerHTML = '<p class="muted small">没有读不出来的文件，一切正常。</p>';
            return;
          }
          el('badOut').innerHTML = r.items.map(function (it) {
            var where = [];
            if (it.text_state === 'unreadable' || it.text_state === 'failed') { where.push('提取文字'); }
            if (it.vision_state === 'unreadable' || it.vision_state === 'failed') { where.push('看图识别'); }
            var hard = (it.text_state === 'unreadable' || it.vision_state === 'unreadable');
            var note = it.text_note || it.vision_note || '';
            return '<div style="padding:8px 0;border-top:1px solid var(--line)">' +
              '<div><span class="badge ' + (hard ? 'bad' : 'warn') + '">' + (hard ? '无法解析' : '失败') + '</span> ' +
              esc(it.name) + '<span class="muted small"> · ' + esc(it.subject || '未分类') +
              (where.length ? ' · ' + where.join(' / ') : '') + '</span></div>' +
              (note ? '<div class="muted small" style="margin-top:2px">' + esc(note) + '</div>' : '') +
              '</div>';
          }).join('');
        }).catch(function (e) { el('badOut').innerHTML = esc(e.message); });
      };
      el('idxPing').onclick = function () {
        el('pingOut').textContent = '检测中…';
        api('/api/selftest').then(function (r) {
          el('pingOut').textContent = r.ai.ok ? ('可用：' + r.ai.message) : ('不可用：' + r.ai.message);
        }).catch(function (e) { el('pingOut').textContent = e.message; });
      };
      el('idxSelf').onclick = function () {
        el('selfOut').innerHTML = '<span class="muted">正在计算校验值…</span>';
        api('/api/selftest').then(function (r) {
          var s2 = r.source;
          el('selfOut').innerHTML = '<div>' + s2.files + ' 个文件，' + s2.bytes + ' 字节' +
            '<br>当前指纹：<code>' + esc(s2.sha256.substring(0, 24)) + '…</code>' +
            '<br>上线前基线：<code>' + esc((s2.baseline_sha256 || '无').substring(0, 24)) + '…</code>' +
            '<br><strong style="color:' + (s2.unchanged ? 'var(--ok)' : 'var(--danger)') + '">' +
            (s2.unchanged ? '完全一致，原始资料没有被改动过' : '不一致，请检查') + '</strong></div>';
        }).catch(function (e) { el('selfOut').innerHTML = esc(e.message); });
      };
      startIndexPolling();
    }).catch(function (e) { el('app').innerHTML = '<div class="wrap"><div class="card">' + esc(e.message) + '</div></div>'; });
  }

  function control(action) {
    api('/api/index/control', { json: { action: action } }).then(function (r) {
      if (action === 'rescan' && r.stats) {
        toast('扫描完成，新增 ' + (r.stats.library ? r.stats.library.add : 0) + ' 个文件');
      } else if (action === 'requeue') {
        toast('已重新排队 ' + r.count + ' 项');
      } else {
        toast('已' + (action === 'start' ? '开始' : '暂停'));
      }
      viewIndex();
    }).catch(function (e) { toast(e.message, true); });
  }

  function startIndexPolling() {
    if (state.indexTimer) { return; }
    state.indexTimer = setInterval(function () {
      if (!state.user) { return; }
      api('/api/index/status').then(function (data) {
        var s = data.status;
        var box = el('idxCur');
        if (box) {
          box.textContent = s.current
            ? ('正在处理：' + s.current.name + '（第 ' + s.current.phase + ' 级）')
            : ('空闲。待提取文字 ' + s.text_pending + '，待看图识别 ' + s.vision_pending);
        }
        if (!s.text_pending && !s.vision_pending) {
          clearInterval(state.indexTimer);
          state.indexTimer = null;
        }
      }).catch(function () {});
    }, 5000);
  }

  // ---------- 模型动画 ----------
  function customModelsHtml() {
    var list = state.customList || [];
    var items = list.map(function (m) {
      return '<div class="cm-item"><a href="#/m/' + m.id + '">' + esc(m.name) + '</a>' +
        '<span class="muted small">' + esc(m.group_path || '') + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn small" data-cmdel="' + m.id + '">删除</button></div>';
    }).join('');
    return '<h2>自己加一个模型</h2>' +
      '<p class="muted small">填一个类别（比如“力学 电磁感应”）和模型名称，AI 会直接写好一个能离线运行的小动画保存下来。生成后出现在下面的「我生成的模型」里，也可以在首页学科「模型动画」中按类别找到。</p>' +
      '<div class="fields">' +
        '<label>类别<input type="text" id="cmCat" placeholder="例如：选修三 电磁感应" value="' + esc(state.customCat || '') + '"></label>' +
        '<label>模型名称<input type="text" id="cmTitle" placeholder="例如：带电粒子在磁场中的螺旋运动"></label>' +
      '</div>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-top:10px">补充要求（可不填）' +
        '<textarea id="cmPrompt" rows="2" placeholder="例如：要有速度滑块，画出磁场方向和半径公式"></textarea></label>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn primary" id="cmGo">生成动画</button>' +
        '<span class="muted small" id="cmOut">生成一次大约十几秒到一分钟，期间可以继续看别的页面。</span>' +
      '</div>' +
      (items ? '<h3>我生成的模型</h3><div class="cm-list">' + items + '</div>'
             : '<p class="muted small" style="margin-top:10px">还没有自己生成的模型。</p>');
  }

  function loadCustomModels() {
    return api('/api/models/custom').then(function (d) {
      state.customList = d.items || [];
      var box = el('customBox');
      if (box) { box.innerHTML = customModelsHtml(); bindCustomModels(); }
    }).catch(function () { });
  }

  function bindCustomModels() {
    if (el('cmGo')) {
      el('cmGo').onclick = function () {
        var cat = (el('cmCat').value || '').trim() || '我的模型';
        var title = (el('cmTitle').value || '').trim();
        var prompt = (el('cmPrompt').value || '').trim();
        if (!title) { toast('先写一个模型名称', true); return; }
        state.customCat = cat;
        el('cmGo').disabled = true;
        el('cmOut').textContent = '正在让 AI 写动画，请稍等…';
        api('/api/models/generate', { json: { category: cat, title: title, prompt: prompt } }).then(function (r) {
          el('cmOut').textContent = '生成好了：' + r.name + '（' + r.chars + ' 字符）';
          toast('模型已生成');
          if (r.material_id) { state.modelId = ''; location.hash = '#/m/' + r.material_id; return; }
          loadCustomModels();
        }).catch(function (e) {
          el('cmOut').textContent = '';
          toast(e.message, true);
        }).then(function () { var b = el('cmGo'); if (b) { b.disabled = false; } });
      };
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmdel]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-cmdel');
        UI.confirm('删除这个自建模型？', { okText: '删除' }).then(function (yes) {
          if (!yes) { return; }
          api('/api/models/custom/' + id + '/delete', { json: {} }).then(function () {
            toast('已删除'); loadCustomModels();
          }).catch(function (e) { toast(e.message, true); });
        });
      };
    });
  }

  function viewModels() {
    var all = window.MODELS || [];
    if (!all.length) {
      el('app').innerHTML = '<div class="wrap"><div class="card">模型库没有加载出来（缺少 web/models.js）。</div></div>';
      return;
    }
    var subs = [];
    all.forEach(function (m) { if (subs.indexOf(m.subject) < 0) { subs.push(m.subject); } });
    var sub = subs.indexOf(state.modelSubject) >= 0 ? state.modelSubject : subs[0];
    var list = all.filter(function (m) { return m.subject === sub; });
    var cur = null;
    all.forEach(function (m) { if (m.id === state.modelId) { cur = m; } });
    if (!cur || cur.subject !== sub) { cur = list[0]; }
    state.modelSubject = sub;
    state.modelId = cur.id;
    cur.params = cur.params || [];
    var pv = state.modelParams[cur.id] || {};
    cur.params.forEach(function (pp) { if (pv[pp.key] === undefined) { pv[pp.key] = pp.value; } });
    state.modelParams[cur.id] = pv;

    var tabs = subs.map(function (x) {
      return '<button class="btn small' + (x === sub ? ' primary' : '') + '" data-msub="' + esc(x) + '">' + esc(x) + '</button>';
    }).join(' ');
    var picks = list.map(function (m) {
      return '<button class="model-pick' + (m.id === cur.id ? ' on' : '') + '" data-mid="' + esc(m.id) + '">' + esc(m.title) + '</button>';
    }).join('');
    var ctrls = cur.params.map(function (pp) {
      if (pp.type === 'select') {
        var opts = (pp.options || []).map(function (o) {
          return '<option value="' + esc(o[1]) + '"' + (String(pv[pp.key]) === String(o[1]) ? ' selected' : '') + '>' + esc(o[0]) + '</option>';
        }).join('');
        return '<label class="mp">' + esc(pp.label) + '<select data-mkey="' + esc(pp.key) + '">' + opts + '</select></label>';
      }
      return '<label class="mp">' + esc(pp.label) +
        '<input type="range" min="' + pp.min + '" max="' + pp.max + '" step="' + pp.step + '" value="' + pv[pp.key] + '" data-mkey="' + esc(pp.key) + '">' +
        '<span class="mv" data-mval="' + esc(pp.key) + '">' + esc(pv[pp.key]) + '</span></label>';
    }).join('');

    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card">' +
          '<h1>模型动画</h1>' +
          '<p class="muted small">覆盖常见数理化模型，点左边换模型，拖滑块改参数。全部是本地画的，不联网也能看。</p>' +
          '<div class="row" style="margin-top:10px">' + tabs + '</div>' +
        '</div>' +
        '<div class="models">' +
          '<div class="card model-list">' + picks + '</div>' +
          '<div class="card model-main">' +
            '<div class="row"><b id="mTitle">' + esc(cur.title) + '</b>' +
              '<span class="spacer"></span>' +
              '<button class="btn small" id="mPlay">暂停</button>' +
              '<button class="btn small" id="mReset">重放</button>' +
              '<button class="btn small" id="mStep">单步</button>' +
              '<select id="mSpeed" title="只改变播放快慢，物理规律不变"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>' +
            '</div>' +
            '<p class="muted small" style="margin:6px 0 4px">' + esc(cur.desc) + '</p>' +
            '<p class="muted small" style="margin:0 0 10px">播放速度只是把时间放慢或加快（相当于慢放摄像机），物理规律和数值都不会变；想看清一瞬间的变化就选 0.25×。</p>' +
            '<div class="model-stage"><canvas id="mCanvas"></canvas></div>' +
            '<div class="model-ctrls">' + (ctrls || '<span class="muted small">这个模型没有可调参数，直接看动画。</span>') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card" id="customBox">' + customModelsHtml() + '</div>' +
      '</div>';

    loadCustomModels();
    bindCustomModels();
    var canvas = el('mCanvas');
    var ctx = canvas.getContext('2d');
    var lastW = 0, lastH = 0;
    function resize() {
      var box = canvas.parentNode;
      var cw = Math.max(240, box.clientWidth), ch = Math.max(180, box.clientHeight);
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastW = cw; lastH = ch;
    }
    resize();
    var lastTs = 0;
    function frame(ts) {
      var box = canvas.parentNode;
      if (box.clientWidth !== lastW || box.clientHeight !== lastH) { resize(); }
      var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      if (state.modelPlaying) { state.modelTime += dt * state.modelSpeed; }
      ctx.save();
      try {
        cur.draw(ctx, lastW, lastH, state.modelTime, state.modelParams[cur.id]);
      } catch (e) {
        ctx.restore();
        ctx.fillStyle = '#0e1521'; ctx.fillRect(0, 0, lastW, lastH);
        ctx.fillStyle = '#ff6b6b'; ctx.font = '13px sans-serif';
        ctx.fillText('这个模型画不出来了：' + e.message, 14, 24);
      }
      ctx.restore();
      state.modelRaf = requestAnimationFrame(frame);
    }
    if (state.modelRaf) { cancelAnimationFrame(state.modelRaf); }
    state.modelRaf = requestAnimationFrame(frame);

    Array.prototype.forEach.call(el('app').querySelectorAll('[data-msub]'), function (b) {
      b.onclick = function () { state.modelSubject = b.getAttribute('data-msub'); state.modelId = ''; viewModels(); };
    });
    Array.prototype.forEach.call(el('app').querySelectorAll('[data-mid]'), function (b) {
      b.onclick = function () { state.modelId = b.getAttribute('data-mid'); state.modelTime = 0; viewModels(); };
    });
    Array.prototype.forEach.call(el('app').querySelectorAll('[data-mkey]'), function (inp) {
      var key = inp.getAttribute('data-mkey');
      function changed() {
        var v = inp.type === 'range' ? parseFloat(inp.value) : inp.value;
        state.modelParams[cur.id][key] = v;
        var lbl = el('app').querySelector('[data-mval="' + key + '"]');
        if (lbl) { lbl.textContent = inp.value; }
        if (inp.type !== 'range') { state.modelTime = 0; }
      }
      inp.oninput = changed;
      inp.onchange = changed;
    });
    el('mPlay').onclick = function () {
      state.modelPlaying = !state.modelPlaying;
      el('mPlay').textContent = state.modelPlaying ? '暂停' : '播放';
    };
    el('mReset').onclick = function () { state.modelTime = 0; lastTs = 0; };
    el('mStep').onclick = function () {
      state.modelPlaying = false;
      el('mPlay').textContent = '播放';
      state.modelTime += 0.04;
    };
    el('mSpeed').onchange = function () { state.modelSpeed = parseFloat(el('mSpeed').value) || 1; };
  }

  // ---------- 路由 ----------
  function parseHash() {
    var raw = (location.hash || '#/').substring(1);
    var parts = raw.split('?');
    var path = parts[0] || '/';
    var query = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv[0]) { query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }
      });
    }
    return { path: path, query: query };
  }

  // ---- 切页动画：按顶栏顺序决定从左边还是右边滑入（24px / 350ms）----
  var NAV_ORDER = { '': 0, '/': 0, '/search': 1, '/ask': 2, '/qa': 3, '/collect': 4,
                    '/models': 5, '/upload': 6, '/folder': 7, '/export': 8,
                    '/index': 9, '/appearance': 10, '/me': 11 };

  function navOrder(path) {
    if (Object.prototype.hasOwnProperty.call(NAV_ORDER, path)) { return NAV_ORDER[path]; }
    return 90;   // 学科页、资料详情这些都是“更深一层”
  }

  function setNavDirection(path) {
    var now = navOrder(path);
    var prev = typeof state.navOrder === 'number' ? state.navOrder : now;
    state.navOrder = now;
    if (now === prev) { return; }
    // 登录后的那 0.9 秒交给「从下方滑入」，两个动画不叠在一起。
    if (state.enterUntil && Date.now() <= state.enterUntil) { return; }
    state.navDir = now > prev ? 'right' : 'left';
  }

  // 页面内容一渲染出来就套上滑入动画（每次导航只播一次，"正在读取…"的占位不算）。
  function watchPageEnter() {
    var box = el('app');
    if (!box || !window.MutationObserver) { return; }
    new MutationObserver(function () {
      if (!state.navDir) { return; }
      var node = box.firstElementChild;
      if (!node || !node.classList || node.classList.contains('loading')) { return; }
      var dir = state.navDir;
      state.navDir = '';
      node.classList.add(dir === 'left' ? 'page-enter-left' : 'page-enter-right');
    }).observe(box, { childList: true });
  }

  // ---- 按钮按下：点击位置冒一圈水波 ----
  var RIPPLE_SELECTOR = 'button,.btn,.bar a.nav,#tabbar a';

  function rippleAt(node, ev) {
    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) { return; }
    var x = ev.clientX - rect.left;
    var y = ev.clientY - rect.top;
    var size = 2 * Math.max(Math.hypot(x, y), Math.hypot(rect.width - x, y),
                            Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y));
    if (!size) { return; }
    var dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.left = (x - size / 2) + 'px';
    dot.style.top = (y - size / 2) + 'px';
    node.appendChild(dot);
    setTimeout(function () { if (dot.parentNode) { dot.parentNode.removeChild(dot); } }, 640);
  }

  function bindRipple() {
    var reduce = false;
    try {
      reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { reduce = false; }
    if (reduce) { return; }
    document.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) { return; }
      var node = ev.target;
      while (node && node !== document && !(node.matches && node.matches(RIPPLE_SELECTOR))) {
        node = node.parentElement;
      }
      if (!node || node === document || node.disabled) { return; }
      rippleAt(node, ev);
    }, true);
  }

  function route() {
    if (state.modelRaf) { cancelAnimationFrame(state.modelRaf); state.modelRaf = null; }
    if (!state.user) { renderLogin(); return; }
    var r = parseHash();
    setNavDirection(r.path);
    renderTop();
    var seg = r.path.split('/').filter(function (x) { return x; });
    if (!seg.length) { viewHome(); return; }
    if (seg[0] === 's' && seg[1]) { viewSubject(decodeURIComponent(seg[1]), r.query); return; }
    if (seg[0] === 'm' && seg[1]) { viewMaterial(parseInt(seg[1], 10)); return; }
    if (seg[0] === 'search') { viewSearch(r.query); return; }
    if (seg[0] === 'ask') { viewAsk(); return; }
    if (seg[0] === 'collect') { viewCollect(); return; }
    if (seg[0] === 'models') { viewModels(); return; }
    if (seg[0] === 'upload') { viewUpload(); return; }
    if (seg[0] === 'export') { viewExport(r.query); return; }
    if (seg[0] === 'index') { viewIndex(); return; }
    if (seg[0] === 'appearance') { viewAppearance(); return; }
    if (seg[0] === 'folder') { viewFolder(); return; }
    if (seg[0] === 'qa') { if (LOCAL) { viewHome(); return; } viewQa(r.query); return; }
    if (seg[0] === 'me') { viewMe(); return; }
    viewHome();
  }

  // 勾选：全局委托
  document.addEventListener('change', function (ev) {
    var box = ev.target;
    if (box && box.getAttribute && box.getAttribute('data-pick')) {
      var id = box.getAttribute('data-pick');
      if (box.checked) { state.sel[id] = true; } else { delete state.sel[id]; }
      renderTop();
    }
  });

  window.addEventListener('hashchange', route);

  function renderGate() {
    el('topbar').innerHTML = '';
    el('app').innerHTML =
      '<div class="overlay login-page">' +
        '<div class="lp-bg" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><span class="lp-spin"></span><span class="lp-dust"></span><span class="lp-grid"></span></div>' +
        '<div class="card login">' +
        '<h1>输入分享码</h1>' +
        '<p class="muted small">这个学习工具只给拿到分享码的人用。输入一次，这台设备就记住了。</p>' +
        '<div class="field"><input type="text" id="gateCode" placeholder="分享码" autocomplete="off"></div>' +
        '<div class="row" style="margin-top:14px"><button class="btn primary" id="gateGo" style="flex:1">进入</button></div>' +
        '<p class="muted small" style="margin-top:10px" id="gateHint"></p>' +
      '</div></div>';
    function tryGate() {
      var code = (el('gateCode').value || '').trim();
      if (!code) { el('gateHint').textContent = '请输入分享码。'; return; }
      el('gateGo').disabled = true;
      el('gateHint').textContent = '正在校验…';
      window.StudyGate.submit(code).then(function (good) {
        if (good) { el('gateHint').textContent = '通过，正在进入…'; boot(); return; }
        el('gateHint').textContent = '分享码不对，再试一次。';
        el('gateGo').disabled = false;
      }).catch(function (e) {
        el('gateHint').textContent = String((e && e.message) || e);
        el('gateGo').disabled = false;
      });
    }
    el('gateGo').onclick = tryGate;
    el('gateCode').onkeydown = function (ev) { if (ev.key === 'Enter') { tryGate(); } };
    el('gateCode').focus();
  }

  function boot() {
    if (LOCAL && window.StudyGate && window.StudyGate.required() && !window.StudyGate.unlocked()) {
      renderGate();
      return;
    }
    api('/api/me').then(function (data) {
      state.user = data.user;
      window.studyThemeSave = function (theme) {
        if (!state.user || LOCAL) { return Promise.resolve(theme); }
        return api('/api/me/prefs', { json: { theme: theme } }).then(function () { return theme; });
      };
      if (state.user && !LOCAL) {
        api('/api/me/prefs').then(function (d) {
          state.prefs = d.prefs || {};
          state.site = d.site || {};
          var theme = (d.prefs && d.prefs.theme) || null;
          if (theme && window.StudyTheme && Object.keys(theme).length) { window.StudyTheme.apply(theme); }
          if (d.avatars) { state.avatars = d.avatars; }
          renderTop();
        }).catch(function () { });
      }
      if (window.StudyStore && isBrowserUser()) {
        window.StudyStore.settingsGet('ai', null).then(function (v) {
          state.hasOwnAi = !!(v && v.base_url);
        }).catch(function () {});
      }
      route();
    }).catch(function () {
      state.user = null;
      api('/api/register/info').then(function (d) {
        state.regInfo = d;
      }).catch(function () { }).then(function () {
        renderLogin();
      });
    });
  }

  watchPageEnter();
  bindRipple();
  boot();
})();

/* ---- PWA：离线壳（只在 http/https 下注册，file:// 双击打开时自动跳过） ---- */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) { return; }
  if (location.protocol !== 'http:' && location.protocol !== 'https:') { return; }
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')['catch'](function () {});
  });
})();

/* ---- PWA：手机上加到桌面（只提示一次，点“以后”不再打扰） ---- */
(function () {
  'use strict';
  if (location.protocol !== 'http:' && location.protocol !== 'https:') { return; }
  var KEY = 'study_install_tip_v1';
  try { if (localStorage.getItem(KEY) === 'off') { return; } } catch (e) { return; }
  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  } catch (e) { }
  if (standalone) { return; }
  try { if (!window.matchMedia || !window.matchMedia('(max-width:700px)').matches) { return; } } catch (e2) { return; }
  var deferred = null;
  var isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  function dismiss() {
    try { localStorage.setItem(KEY, 'off'); } catch (e) { }
    var box = document.getElementById('installTip');
    if (box && box.parentNode) { box.parentNode.removeChild(box); }
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!deferred && !isiOS) { return; }
      var box = document.createElement('div');
      box.id = 'installTip';
      box.className = 'card install-tip';
      box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:calc(64px + env(safe-area-inset-bottom));'
        + 'z-index:40;margin:0';
      box.innerHTML = '<span>' + (isiOS
        ? '把本站加到桌面：点底部“分享”，选“添加到主屏幕”'
        : '把本站加到桌面，下次一点就打开') + '</span>'
        + '<span><button class="btn small primary" id="installGo">安装</button> '
        + '<button class="btn small" id="installNo">以后</button></span>';
      document.body.appendChild(box);
      var go = document.getElementById('installGo');
      if (go) {
        go.onclick = function () {
          var ev = deferred;
          deferred = null;
          if (ev) { ev.prompt(); }
          dismiss();
        };
      }
      var no = document.getElementById('installNo');
      if (no) { no.onclick = dismiss; }
    }, 2500);
  });
})();
