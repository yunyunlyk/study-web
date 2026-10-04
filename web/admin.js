/* 管理端前端：账号管理、违规检查、操作日志、AI 接入与数据位置设置。 */
(function () {
  'use strict';

  var S = {
    me: null, tab: 'overview', users: [], totals: {}, violations: [],
    audit: [], auditUser: '', auditLevel: '', auditAction: '', auditLimit: 150,
    settings: null, feedback: [], fbStatus: '',
    uPage: 1, uSize: 20, uSort: 'id', uOrder: 'asc', uStatus: 'all', uQuery: '',
    uSel: {}, uPages: 1, uMatched: 0, resetCode: null
  };

  var ACTIONS = [
    ['register', '注册账号'], ['login', '登录'], ['login_fail', '登录失败'],
    ['logout', '退出登录'], ['upload', '上传资料'], ['download', '下载原文件'],
    ['export', '导出资料'], ['collect', '网上收集'], ['ask', 'AI 问答'],
    ['index', '手动索引'], ['storage', '修改数据位置'], ['forbidden', '越权访问'],
    ['admin', '管理操作'], ['feedback', '提交反馈'], ['reset', '用重置码改密码'],
    ['reset_fail', '重置码不对/过期']
  ];

  var LEVELS = [['info', '正常'], ['warn', '警告'], ['alert', '危险']];

  function el(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, isErr) {
    var box = el('toast');
    var node = document.createElement('div');
    node.className = 'toast' + (isErr ? ' err' : '');
    node.textContent = msg;
    box.appendChild(node);
    setTimeout(function () { if (node.parentNode) { node.parentNode.removeChild(node); } }, isErr ? 6000 : 2600);
  }

  function api(path, options) {
    var opt = options || {};
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
          err.status = res.status; err.payload = data;
          throw err;
        }
        return data;
      });
    });
  }

  function human(n, label) {
    if (label) { return label; }
    var v = Number(n || 0);
    if (v < 1024) { return v + ' B'; }
    if (v < 1048576) { return (v / 1024).toFixed(1) + ' KB'; }
    if (v < 1073741824) { return (v / 1048576).toFixed(1) + ' MB'; }
    return (v / 1073741824).toFixed(2) + ' GB';
  }

  function statBox(title, value, hint) {
    return '<div class="sub"><div class="c">' + esc(title) + '</div>' +
      '<div class="n" style="font-size:22px">' + esc(value) + '</div>' +
      '<div class="c small">' + esc(hint) + '</div></div>';
  }

  function levelTag(level) {
    var name = { info: '正常', warn: '警告', alert: '危险' }[level] || level;
    return '<span class="tag ' + esc(level) + '">' + esc(name) + '</span>';
  }

  // ---------- 顶栏 / 标签 ----------
  function renderTop() {
    var bar = el('topbar');
    bar.innerHTML =
      '<div class="bar">' +
        '<span class="brand">学习网页 · 管理端</span>' +
        '<span class="spacer"></span>' +
        '<span class="who">' + esc(S.me ? S.me.username : '') + '（管理员）</span>' +
        '<a class="btn small" href="/">返回用户端</a>' +
        '<button class="btn small" id="admLogout">退出</button>' +
      '</div>';
    el('admLogout').onclick = function () {
      api('/api/logout', { json: {} }).then(function () { location.href = '/'; });
    };
  }

  function renderTabs() {
    var badge = (S.totals && S.totals.feedback_new)
      ? ' <span class="tag alert">' + S.totals.feedback_new + '</span>' : '';
    var map = [['overview', '概览'], ['users', '账号管理'], ['violations', '违规检查'],
               ['feedback', '用户反馈' + badge], ['audit', '操作日志'], ['backup', '数据备份'],
               ['settings', '系统设置']];
    el('admTabs').innerHTML = map.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-tab'); go(); };
    });
  }

  // ---------- 概览 ----------
  function viewOverview() {
    var t = S.totals || {};
    var flagged = (S.violations || []).length;
    var top = (S.violations || []).slice(0, 6).map(function (v) {
      return '<tr><td>' + levelTag(v.level) + '</td><td>' + esc(v.username) + '</td>' +
        '<td>' + esc(v.label) + '</td><td class="num">' + v.count + '</td>' +
        '<td class="muted small">' + esc(v.last_at || '') + '</td></tr>';
    }).join('');
    // 账号列表现在是分页的，S.users 只是当前一页，这里不再逐个列举，改成能点过去的入口。
    var disabledList = t.disabled
      ? '<button class="btn small" id="ovDisabled">看已停用的 ' + t.disabled + ' 个账号</button>'
      : '';

    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>这台服务器现在的情况</h2>' +
          '<div class="grid g-stat">' +
            statBox('注册账号', t.users || 0, '所有账号') +
            statBox('管理员', t.admins || 0, '可以进管理端') +
            statBox('已停用账号', t.disabled || 0, '被停用后不能登录') +
            statBox('违规标记', flagged, flagged ? '去「违规检查」看详情' : '目前没有异常') +
            statBox('待处理反馈', t.feedback_new || 0, (t.feedback_new ? '去「用户反馈」看内容' : '还没有新的反馈')) +
          '</div>' +
          (disabledList ? '<div class="row" style="margin-top:12px">' + disabledList + '</div>' : '') +
        '</div>' +
        '<div class="card"><h2>需要留意的账号</h2>' +
          (top ? '<div class="scroll"><table class="adm"><thead><tr><th>级别</th><th>账号</th><th>情况</th><th class="num">次数</th><th>最近一次</th></tr></thead><tbody>' + top + '</tbody></table></div>'
               : '<p class="muted">目前没有触发任何检查规则。</p>') +
          '<p class="muted small" style="margin-top:10px">规则说明：别人的私密资料是<b>打不开</b>的——程序会直接拦下、返回“找不到”，这里统计的只是他尝试了几次。系统只盯这几种行为：30 分钟内登录失败 5 次以上（危险）、1 小时内反复尝试打开别人的私密资料 5 次以上（危险）、1 小时内调用 AI 200 次以上（警告）、上传 exe/bat/ps1 等可执行或脚本文件（危险）。<b>上传多少文件不作限制</b>，一次传几百个也正常，不算违规。</p>' +
        '</div>' +
        '<div class="card"><h2>管理员要做的事</h2>' +
          '<ul class="muted small" style="margin:0;padding-left:18px">' +
            '<li>在「系统设置」里配置 AI 接入（默认用本机代理，免密钥）。</li>' +
            '<li>在「账号管理」里停用可疑账号、重置密码。</li>' +
            '<li>在「违规检查」里核对异常行为，必要时停用该账号。</li>' +
            '<li>在「用户反馈」里看用户提了什么、回复他们。</li>' +
            '<li>在「系统设置」里可以把数据目录换到大一点的硬盘。</li>' +
          '</ul>' +
        '</div>' +
      '</div>';
    if (el('ovDisabled')) {
      el('ovDisabled').onclick = function () { S.tab = 'users'; S.uStatus = 'disabled'; S.uPage = 1; go(); };
    }
  }

  // ---------- 账号管理 ----------
  function userRow(u) {
    var role = u.is_admin ? '<span class="tag info">管理员</span>' : '<span class="tag">普通用户</span>';
    var status = u.disabled ? '<span class="tag alert">已停用</span>' : '<span class="tag ok">正常</span>';
    var flag = u.flags ? '<span class="tag alert">' + u.flags + '</span>' : '<span class="muted">—</span>';
    return '<tr>' +
      '<td><input type="checkbox" data-pick="' + u.id + '"' + (S.uSel[u.id] ? ' checked' : '') + '></td>' +
      '<td><b>' + esc(u.username) + (u.nickname ? ' <span class="muted small">（' + esc(u.nickname) + '）</span>' : '') + '</b><div class="muted small">' + esc(u.created_at || '') + '</div></td>' +
      '<td>' + role + ' ' + status + '</td>' +
      '<td class="muted small">' + esc(u.last_login_at || '从未登录') + '<br>' + esc(u.last_ip || '') + '</td>' +
      '<td class="num">' + u.uploads + '</td>' +
      '<td class="num">' + u.notes + '</td>' +
      '<td class="num">' + u.favorites + '</td>' +
      '<td class="num">' + u.quizzes + '</td>' +
      '<td class="num">' + u.logins + '</td>' +
      '<td class="num">' + (u.login_fails ? '<span class="tag warn">' + u.login_fails + '</span>' : '0') + '</td>' +
      '<td class="num">' + (u.forbidden ? '<span class="tag alert">' + u.forbidden + '</span>' : '0') + '</td>' +
      '<td class="num">' + u.asks + '</td>' +
      '<td class="num">' + esc(u.bytes_label || human(u.bytes)) + '</td>' +
      '<td class="num">' + (u.quota_mb ? esc(String(u.quota_mb)) + ' MB' : '<span class="muted">不限</span>') + '</td>' +
      '<td class="num">' + flag + '</td>' +
      '<td><div class="acts">' +
        '<button class="btn" data-act="toggle" data-id="' + u.id + '">' + (u.disabled ? '启用' : '停用') + '</button>' +
        '<button class="btn" data-act="pwd" data-id="' + u.id + '">重置密码</button>' +
        '<button class="btn" data-act="reset" data-id="' + u.id + '">重置码</button>' +
        '<button class="btn" data-act="del" data-id="' + u.id + '">删除</button>' +
      '</div></td>' +
    '</tr>';
  }

  function viewUsers() {
    var rows = S.users.map(userRow).join('');
    var allChecked = S.users.length > 0 && S.users.every(function (u) { return S.uSel[u.id]; });
    var picked = Object.keys(S.uSel).length;
    var t = S.totals || {};
    var sortOpts = [['id', '编号'], ['username', '用户名'], ['last_login', '最近登录'],
                    ['actions', '操作数'], ['bytes', '占用']].map(function (o) {
      return '<option value="' + o[0] + '"' + (S.uSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    var statusOpts = [['all', '全部'], ['active', '正常'], ['disabled', '已停用'],
                      ['admin', '管理员'], ['flagged', '有违规标记']].map(function (o) {
      return '<option value="' + o[0] + '"' + (S.uStatus === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>账号管理</h2>' +
          (S.resetCode ? '<div class="hintbox" style="margin-top:10px">一次性重置码 —— 给 <b>' + esc(S.resetCode.username) +
            '</b>：<code style="font-size:15px;letter-spacing:1px">' + esc(S.resetCode.code) + '</code>　' +
            esc(String(S.resetCode.minutes)) + ' 分钟内有效，只显示这一次。' +
            '<button class="btn small" id="uCodeClose" style="margin-left:8px">知道了</button></div>' : '') +
          '<div class="row" style="margin-top:10px">' +
            '<input type="search" id="uFilter" placeholder="搜用户名或昵称" value="' + esc(S.uQuery) + '" style="min-width:180px">' +
            '<select id="uStatus">' + statusOpts + '</select>' +
            '<select id="uSort">' + sortOpts + '</select>' +
            '<button class="btn small" id="uOrder">' + (S.uOrder === 'asc' ? '升序 ↑' : '降序 ↓') + '</button>' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">每页 ' +
              '<input type="number" id="uSize" min="5" max="200" value="' + S.uSize + '" style="width:72px"></label>' +
            '<span class="muted small">匹配 <b>' + S.uMatched + '</b> / 共 ' + (t.users || 0) + ' 个账号　·　服务器端占用合计 ' +
              esc(t.bytes_label || human(t.bytes)) + '</span>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<span class="muted small">已勾选 <b>' + picked + '</b> 个：</span>' +
            '<button class="btn small" data-bulk="disable">停用</button>' +
            '<button class="btn small" data-bulk="enable">启用</button>' +
            '<button class="btn small" data-bulk="reset_password">重置密码</button>' +
            '<button class="btn small" data-bulk="set_admin">设为管理员</button>' +
            '<button class="btn small" data-bulk="unset_admin">取消管理员</button>' +
            '<button class="btn small" data-bulk="quota">设配额</button>' +
            '<button class="btn small" data-bulk="delete">删除</button>' +
            '<button class="btn small" id="uClear">清空勾选</button>' +
          '</div>' +
          '<p class="muted small" style="margin-top:8px">占用只统计<b>上传到服务器</b>的文件；用户存在自己电脑或浏览器里的资料服务器看不到，不计入。配额 0 表示不限（默认）。</p>' +
        '</div>' +
        '<div class="card"><div class="scroll"><table class="adm">' +
          '<thead><tr><th style="width:26px"><input type="checkbox" id="uAll"' + (allChecked ? ' checked' : '') + '></th>' +
          '<th>账号</th><th>身份 / 状态</th><th>最近登录</th>' +
          '<th class="num">上传</th><th class="num">笔记</th><th class="num">收藏</th><th class="num">做题</th>' +
          '<th class="num">登录</th><th class="num">失败</th><th class="num">越权</th><th class="num">AI</th>' +
          '<th class="num">占用</th><th class="num">配额</th><th class="num">违规</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="16" class="muted">没有匹配的账号。</td></tr>') + '</tbody>' +
        '</table></div>' +
        '<div class="row" style="margin-top:10px">' +
          '<button class="btn small" id="uPrev"' + (S.uPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<span class="muted small">第 ' + S.uPage + ' / ' + S.uPages + ' 页</span>' +
          '<button class="btn small" id="uNext"' + (S.uPage >= S.uPages ? ' disabled' : '') + '>下一页</button>' +
        '</div></div>' +
      '</div>';
    function reload() { S.uSel = {}; loadUsers().then(function () { renderTabs(); viewUsers(); }); }
    el('uFilter').oninput = function () { S.uQuery = el('uFilter').value; S.uPage = 1; };
    el('uFilter').onchange = reload;
    el('uFilter').onkeydown = function (ev) { if (ev.key === 'Enter') { reload(); } };
    el('uStatus').onchange = function () { S.uStatus = el('uStatus').value; S.uPage = 1; reload(); };
    el('uSort').onchange = function () { S.uSort = el('uSort').value; S.uPage = 1; reload(); };
    el('uOrder').onclick = function () { S.uOrder = (S.uOrder === 'asc' ? 'desc' : 'asc'); reload(); };
    el('uSize').onchange = function () {
      S.uSize = Math.max(5, Math.min(200, parseInt(el('uSize').value, 10) || 20));
      S.uPage = 1; reload();
    };
    el('uPrev').onclick = function () { if (S.uPage > 1) { S.uPage--; loadUsers().then(viewUsers); } };
    el('uNext').onclick = function () { if (S.uPage < S.uPages) { S.uPage++; loadUsers().then(viewUsers); } };
    el('uClear').onclick = function () { S.uSel = {}; viewUsers(); };
    if (el('uCodeClose')) {
      el('uCodeClose').onclick = function () { S.resetCode = null; viewUsers(); };
    }
    el('uAll').onclick = function () {
      var on = el('uAll').checked;
      S.users.forEach(function (u) { if (on) { S.uSel[u.id] = true; } else { delete S.uSel[u.id]; } });
      viewUsers();
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-pick]'), function (box) {
      box.onclick = function () {
        var id = parseInt(box.getAttribute('data-pick'), 10);
        if (box.checked) { S.uSel[id] = true; } else { delete S.uSel[id]; }
        viewUsers();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () { userAction(b.getAttribute('data-act'), parseInt(b.getAttribute('data-id'), 10)); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-bulk]'), function (b) {
      b.onclick = function () { bulkAction(b.getAttribute('data-bulk')); };
    });
  }

  function findUser(id) {
    var out = null;
    S.users.forEach(function (u) { if (u.id === id) { out = u; } });
    return out;
  }

  function userAction(act, id) {
    var u = findUser(id);
    if (!u) { return; }
    if (act === 'toggle') {
      api('/api/admin/users/' + id + '/disable', { json: { disabled: !u.disabled } })
        .then(function () { toast(u.disabled ? '已启用 ' + u.username : '已停用 ' + u.username); refresh(); })
        .catch(function (e) { toast(e.message, true); });
      return;
    }
    if (act === 'pwd') {
      UI.prompt('给 ' + u.username + ' 设置新密码（至少 6 位）', '', { placeholder: '至少 6 位' }).then(function (np) {
        if (np === null || np === undefined) { return; }
        api('/api/admin/users/' + id + '/password', { json: { password: np } })
          .then(function () { toast('密码已重置，请把新密码告诉对方'); refresh(); })
          .catch(function (e) { toast(e.message, true); });
      });
      return;
    }
    if (act === 'reset') {
      UI.confirm('给 ' + u.username + ' 生成一次性重置码？15 分钟内有效。把码告诉他，'
        + '他自己去登录页点「忘记密码」，用用户名 + 重置码设新密码。', { okText: '生成' })
        .then(function (yes) {
          if (!yes) { return; }
          api('/api/admin/users/' + id + '/reset-code', { json: {} }).then(function (r) {
            S.resetCode = { username: r.username || u.username, code: r.code, minutes: r.minutes };
            toast('重置码已生成，' + r.minutes + ' 分钟内有效');
            viewUsers();
          }).catch(function (e) { toast(e.message, true); });
        });
      return;
    }
    if (act === 'del') {
      UI.confirm('删除账号 ' + u.username + '？他的上传文件会一起删掉，收藏、笔记、做题记录也会消失。此操作不可恢复。',
        { okText: '删除' }).then(function (yes) {
        if (!yes) { return; }
        api('/api/admin/users/' + id + '/delete', { json: {} })
          .then(function (r) { toast('已删除，连带清理 ' + (r.removed || 0) + ' 个文件'); refresh(); })
          .catch(function (e) { toast(e.message, true); });
      });
    }
  }

  // ---------- 批量操作 ----------
  function bulkAction(action) {
    var ids = Object.keys(S.uSel).map(function (k) { return parseInt(k, 10); })
      .filter(function (n) { return !isNaN(n); });
    if (!ids.length) { toast('先勾选要处理的账号', true); return; }
    if (action === 'delete') {
      UI.confirm('删除勾选的 ' + ids.length + ' 个账号？他们的上传文件、笔记、收藏、做题记录会一起消失，不可恢复。',
        { okText: '删除' }).then(function (yes) {
        if (yes) { sendBulk(action, ids); }
      });
      return;
    }
    if (action === 'reset_password') {
      UI.prompt('把勾选的 ' + ids.length + ' 个账号的密码都设成（至少 6 位）', '',
        { placeholder: '至少 6 位' }).then(function (pw) {
        if (pw === null || pw === undefined || pw === '') { return; }
        sendBulk(action, ids, { password: pw });
      });
      return;
    }
    if (action === 'quota') {
      UI.prompt('给勾选的 ' + ids.length + ' 个账号设服务器端配额（MB，0 表示不限）', '0',
        { placeholder: '比如 500；0 = 不限' }).then(function (v) {
        if (v === null || v === undefined || v === '') { return; }
        sendBulk(action, ids, { quota_mb: parseInt(v, 10) || 0 });
      });
      return;
    }
    sendBulk(action, ids);
  }

  function sendBulk(action, ids, extra) {
    var payload = { action: action, ids: ids };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { payload[k] = extra[k]; } } }
    api('/api/admin/users/bulk', { json: payload }).then(function (r) {
      toast(r.note || ('已处理 ' + r.done + ' 个账号'));
      S.uSel = {};
      refresh();
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------- 违规检查 ----------
  function viewViolations() {
    var rows = (S.violations || []).map(function (v) {
      return '<tr><td>' + levelTag(v.level) + '</td><td><b>' + esc(v.username) + '</b></td>' +
        '<td>' + esc(v.label) + '<div class="muted small">规则代码：' + esc(v.rule) + '</div></td>' +
        '<td class="num">' + v.count + '</td>' +
        '<td class="muted small">' + esc(v.detail || '') + '</td>' +
        '<td class="muted small">' + esc(v.last_at || '') + '</td>' +
        '<td><button class="btn" data-vuser="' + v.user_id + '">看这个人的记录</button></td></tr>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>违规检查</h2>' +
          '<p class="muted small">系统只盯“安全性”行为，命中就列在这里。它只是提示，是否真的有问题由你判断。</p>' +
          '<div class="hintbox" style="margin-top:10px">' +
            '<div>先说明一点：<b>别人的私密资料打不开</b>。不是“能访问但记一笔”，而是请求会被直接拦下、返回“找不到”。下面那一条只表示“他试过几次”。</div>' +
            '<div>· 30 分钟内登录失败 ≥ 5 次 —— 疑似在试别人的密码（危险）</div>' +
            '<div>· 1 小时内反复尝试打开别人的私密资料 ≥ 5 次 —— 每次都被拦下了，但值得看一眼（危险）</div>' +
            '<div>· 1 小时内调用 AI ≥ 200 次 —— 疑似用脚本刷接口（警告）</div>' +
            '<div>· 上传 exe / bat / ps1 / vbs / js 等可执行或脚本文件 —— 直接标危险</div>' +
            '<div>· 上传文件的数量<b>不作限制</b>：一次传几百个资料也是正常使用，不会被标记。</div>' +
          '</div>' +
        '</div>' +
        '<div class="card"><div class="scroll"><table class="adm">' +
          '<thead><tr><th>级别</th><th>账号</th><th>情况</th><th class="num">次数</th><th>说明</th><th>最近一次</th><th>操作</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="7" class="muted">目前没有命中任何规则，一切正常。</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-vuser]'), function (b) {
      b.onclick = function () {
        var _vu = b.getAttribute('data-vuser');
    S.auditUser = (_vu && /^\d+$/.test(_vu)) ? _vu : '';
        S.tab = 'audit';
        go();
      };
    });
  }

  // ---------- 用户反馈 ----------
  var FB_KINDS = [['suggestion', '功能建议'], ['bug', '问题反馈'], ['content', '内容需求'], ['other', '其他']];

  function fbKindLabel(k) {
    var out = k;
    FB_KINDS.forEach(function (x) { if (x[0] === k) { out = x[1]; } });
    return out;
  }

  function fbStatusTag(v) {
    var m = { new: ['alert', '待处理'], read: ['warn', '已看过'], done: ['ok', '已处理'] };
    var it = m[v] || ['', v];
    return '<span class="tag ' + it[0] + '">' + it[1] + '</span>';
  }

  function viewFeedback() {
    var filters = [['', '全部'], ['new', '待处理'], ['read', '已看过'], ['done', '已处理']].map(function (f) {
      return '<button class="btn small' + (S.fbStatus === f[0] ? ' primary' : '') +
        '" data-fb="' + f[0] + '">' + f[1] + '</button>';
    }).join(' ');
    var rows = (S.feedback || []).map(function (f) {
      return '<div style="border-top:1px solid var(--line);padding:12px 0">' +
        '<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
          fbStatusTag(f.status) +
          '<span class="tag">' + esc(fbKindLabel(f.kind)) + '</span>' +
          '<b>' + esc(f.username || ('#' + f.user_id)) + '</b>' +
          '<span class="muted small">' + esc(f.created_at) + (f.page ? ' · 来自 ' + esc(f.page) : '') + '</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn small" data-fbact="read" data-id="' + f.id + '">标记已看</button>' +
          '<button class="btn small" data-fbact="reply" data-id="' + f.id + '">回复</button>' +
          '<button class="btn small" data-fbact="del" data-id="' + f.id + '">删除</button>' +
        '</div>' +
        '<div style="white-space:pre-wrap;margin-top:6px">' + esc(f.content) + '</div>' +
        (f.contact ? '<div class="muted small" style="margin-top:4px">联系方式：' + esc(f.contact) + '</div>' : '') +
        (f.reply ? '<div class="muted small" style="margin-top:6px;padding:8px 10px;background:var(--bg);border-radius:8px;white-space:pre-wrap">' +
          '我的回复：' + esc(f.reply) + '</div>' : '') +
        '<div class="fb-box" id="fbBox' + f.id + '" hidden>' +
          '<textarea id="fbText' + f.id + '" rows="3" placeholder="写一句回复，用户会在「我的 → 反馈」里看到"></textarea>' +
          '<div class="row" style="margin-top:8px;gap:6px">' +
            '<button class="btn small primary" data-fbsend="' + f.id + '">发送回复并标记处理</button>' +
            '<button class="btn small" data-fbcancel="' + f.id + '">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>用户反馈</h2>' +
          '<p class="muted small">用户在「我的 → 反馈」提交的内容会到这里。你标记已看或回复后，用户名下也会看到状态和你的回复。</p>' +
          '<div class="row" style="margin-top:10px;gap:6px;align-items:center">' + filters +
            '<span class="spacer"></span><button class="btn small" id="fbReload">刷新</button></div>' +
        '</div>' +
        '<div class="card">' + (rows || '<p class="muted">还没有收到反馈。</p>') + '</div>' +
      '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-fb]'), function (b) {
      b.onclick = function () { S.fbStatus = b.getAttribute('data-fb'); loadFeedback().then(draw); };
    });
    if (el('fbReload')) { el('fbReload').onclick = function () { refresh(); }; }
    Array.prototype.forEach.call(document.querySelectorAll('[data-fbact]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id');
        var act = b.getAttribute('data-fbact');
        if (act === 'del') {
          UI.confirm('删除这条反馈？删掉就找不回来了。', { okText: '删除' }).then(function (yes) {
            if (!yes) { return; }
            api('/api/feedback/' + id + '/delete', { json: {} })
              .then(function () { toast('已删除'); refresh(); })
              .catch(function (e) { toast(e.message, true); });
          });
          return;
        }
        if (act === 'reply') {
          var box = el('fbBox' + id);
          if (box) { box.hidden = false; }
          var ta = el('fbText' + id);
          if (ta) { ta.focus(); }
          return;
        }
        api('/api/feedback/' + id + '/status', { json: { status: 'read' } })
          .then(function () { toast('已标记为看过'); refresh(); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-fbsend]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-fbsend');
        var ta = el('fbText' + id);
        var text = ta ? String(ta.value || '').trim() : '';
        if (!text) { toast('回复不能为空', true); if (ta) { ta.focus(); } return; }
        api('/api/feedback/' + id + '/status', { json: { status: 'done', reply: text } })
          .then(function () { toast('已回复并标记处理'); refresh(); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-fbcancel]'), function (b) {
      b.onclick = function () {
        var box = el('fbBox' + b.getAttribute('data-fbcancel'));
        if (box) { box.hidden = true; }
      };
    });
  }

  // ---------- 操作日志 ----------
  function viewAudit() {
    var userOpts = '<option value="">全部账号</option>' + S.users.map(function (u) {
      return '<option value="' + u.id + '"' + (String(S.auditUser) === String(u.id) ? ' selected' : '') + '>' + esc(u.username) + '</option>';
    }).join('');
    var levelOpts = '<option value="">全部级别</option>' + LEVELS.map(function (l) {
      return '<option value="' + l[0] + '"' + (S.auditLevel === l[0] ? ' selected' : '') + '>' + l[1] + '</option>';
    }).join('');
    var actOpts = '<option value="">全部动作</option>' + ACTIONS.map(function (a) {
      return '<option value="' + a[0] + '"' + (S.auditAction === a[0] ? ' selected' : '') + '>' + a[1] + '</option>';
    }).join('');
    var rows = S.audit.map(function (it) {
      return '<tr><td class="muted small">' + esc(it.created_at) + '</td>' +
        '<td><b>' + esc(it.username || ('#' + it.user_id)) + '</b></td>' +
        '<td>' + esc(it.action_label || it.action) + '</td>' +
        '<td>' + levelTag(it.level) + '</td>' +
        '<td>' + esc(it.detail) + '</td>' +
        '<td class="muted small">' + esc(it.ip || '') + '</td></tr>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>操作日志</h2>' +
          '<p class="muted small">谁在什么时候做了什么，都会记在这里。按时间从新到旧排列。</p>' +
          '<div class="row" style="margin-top:10px">' +
            '<select id="aUser">' + userOpts + '</select>' +
            '<select id="aLevel">' + levelOpts + '</select>' +
            '<select id="aAction">' + actOpts + '</select>' +
            '<select id="aLimit">' +
              [80, 150, 300, 500].map(function (n) {
                return '<option value="' + n + '"' + (S.auditLimit === n ? ' selected' : '') + '>' + n + ' 条</option>';
              }).join('') +
            '</select>' +
            '<button class="btn primary" id="aGo">刷新</button>' +
          '</div>' +
        '</div>' +
        '<div class="card"><div class="scroll"><table class="adm">' +
          '<thead><tr><th>时间</th><th>账号</th><th>动作</th><th>级别</th><th>详情</th><th>IP</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="6" class="muted">没有符合条件的日志。</td></tr>') + '</tbody>' +
        '</table></div></div>' +
      '</div>';
    el('aGo').onclick = function () {
      S.auditUser = el('aUser').value;
      S.auditLevel = el('aLevel').value;
      S.auditAction = el('aAction').value;
      S.auditLimit = parseInt(el('aLimit').value, 10) || 150;
      loadAudit();
    };
  }

  // ---------- 系统设置 ----------
  function viewSettings() {
    var st = (S.settings && S.settings.storage) || {};
    var ai = (S.settings && S.settings.ai) || {};
    var reg = (S.settings && S.settings.registration) || {};
    var lan = (S.settings && S.settings.lan_url) || '';
    var shareAi = !!(S.settings && S.settings.allow_shared_ai);
    var br = (S.settings && S.settings.bridge) || {};
    var site = (S.settings && S.settings.site) || {};
    var tlsConf = (S.settings && S.settings.tls) || {};
    var lanUrls = (S.settings && S.settings.lan_urls) || [];
    var scan = (S.settings && S.settings.scan) || {};
    var scanLast = (S.settings && S.settings.scan_last) || {};
    var allRoots = (S.settings && S.settings.source_roots) || [];
    var defRoot = allRoots[0] || { path: scan.dir || '' };
    S.roots = allRoots.filter(function (n) { return !!n.id; }).map(function (n) {
      return { id: n.id, name: n.name || '', path: n.path || '', enabled: n.enabled !== false };
    });
    var sitePresets = (window.StudyTheme && window.StudyTheme.presets) || {};
    var siteTheme = (site.theme && site.theme.preset) || '';
    var themeOpts = '<option value="">跟随系统默认（浅色）</option>'
      + Object.keys(sitePresets).map(function (key) {
          return '<option value="' + esc(key) + '"' + (siteTheme === key ? ' selected' : '') + '>'
            + esc(sitePresets[key].label) + '</option>';
        }).join('');
    var wb = S.webbuild || {};
    var presets = ai.presets || [];
    var presetOpts = '<option value="">自定义 / 手动填写</option>' + presets.map(function (pr, i) {
      return '<option value="' + i + '">' + esc(pr.name) + '</option>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>站点外观与访问方式</h2>' +
          '<p class="muted small">站点名字、公告、默认主题，以及是否允许用户自己换外观。' +
          '这些对所有账号生效。</p>' +
          '<div class="fields">' +
            '<label>站点名字<input type="text" id="siteName" maxlength="40" value="' + esc(site.name || '') + '"></label>' +
            '<label>站点默认主题<select id="siteTheme">' + themeOpts + '</select></label>' +
          '</div>' +
          '<label class="muted small" style="display:flex;gap:6px;align-items:center;margin-top:10px">' +
            '<input type="checkbox" id="siteAllowTheme"' + (site.allow_user_theme === false ? '' : ' checked') +
            '> 允许用户自己换外观（关掉后所有人只能用站点主题）</label>' +
          '<div class="fields" style="margin-top:10px">' +
            '<label>首页公告（可留空，最多 500 字）<textarea id="siteAnn" rows="3">' + esc(site.announcement || '') + '</textarea></label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<button class="btn primary" id="siteSave">保存站点设置</button>' +
            '<span class="muted small" id="siteOut"></span>' +
          '</div>' +
          '<h3>局域网地址（发给别人）</h3>' +
          '<div class="hintbox">' +
            (lanUrls.length
              ? lanUrls.map(function (u) { return '<div>手机/平板同一个 Wi-Fi 下打开：<code>' + esc(u) + '</code></div>'; }).join('')
              : '<div>没有检测到局域网地址。</div>') +
            '<div class="muted small" style="margin-top:6px">列出的第一个是真实网卡；如果上面还出现了 100.64.x.x 之类的地址，那是加速器/虚拟网卡，别发给别人。</div>' +
          '</div>' +
          '<h3>HTTPS（手机/平板要用“文件夹模式”就必须开）</h3>' +
          '<p class="muted small">浏览器的安全策略：只有在 https 或 127.0.0.1 下才允许网页读你选的文件夹。' +
          '开着网站的那台电脑（你）用 127.0.0.1 不受影响；但手机、平板通过局域网地址访问时，必须是 https。</p>' +
          '<div class="row" style="margin-top:8px">' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">' +
              '<input type="checkbox" id="tlsOn"' + (tlsConf.enabled ? ' checked' : '') + '> 用 https 启动（自签证书，重启后生效）</label>' +
            '<button class="btn primary small" id="tlsSave">保存</button>' +
            '<span class="muted small" id="tlsOut">' + (tlsConf.enabled ? '现在是 https 模式' : '现在是 http 模式') + '</span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:8px">开启后：双击「停止.bat」再「启动.bat」，' +
          '然后访问 <code>https://' + esc((lanUrls[0] || 'http://127.0.0.1:' + (tlsConf.port || 8787)).replace('http://', '').split(':')[0])
          + ':' + esc(String(tlsConf.port || 8787)) + '</code>。手机第一次打开会提示“不安全”，点“继续访问”就好。</p>' +
        '</div>' +
        '<div class="card"><h2>资料目录（只读扫描）</h2>' +
          '<p class="muted small">可以加多个资料目录，程序只读、绝不改动里面的文件。每个目录的顶层文件夹当成学科，按扩展名自动分类。删掉目录或改路径，会连它已收录的资料记录一起清掉（不动磁盘文件）。</p>' +
          '<div class="hintbox" style="margin-top:10px">默认资料目录：<code>' + esc(defRoot.path || '') + '</code>（不可删除）</div>' +
          '<div id="rootList" style="margin-top:8px"></div>' +
          '<div class="row" style="margin-top:8px">' +
            '<button class="btn small" id="rootAdd">+ 添加目录</button>' +
            '<button class="btn primary small" id="rootSave">保存目录</button>' +
            '<span class="muted small" id="rootOut"></span>' +
          '</div>' +
          '<h3 style="margin-top:16px">自动扫描</h3>' +
          '<p class="muted small">开了以后，服务每隔一段时间重扫一次上面所有目录，新放进去的文件会自动出现在网站里，不用手动点。默认关闭。</p>' +
          '<div class="row" style="margin-top:10px">' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">' +
              '<input type="checkbox" id="scanOn"' + (scan.enabled ? ' checked' : '') + '> 开启自动扫描</label>' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">每 ' +
              '<input type="number" id="scanMin" min="' + esc(String(scan.min_minutes || 5)) + '" max="' + esc(String(scan.max_minutes || 1440)) + '" value="' + esc(String(scan.minutes || 30)) + '" style="width:84px"> 分钟一次</label>' +
            '<button class="btn primary small" id="scanSave">保存</button>' +
            '<button class="btn small" id="scanNow">立即扫一次</button>' +
          '</div>' +
          '<p class="muted small" id="scanOut" style="margin-top:8px">' + esc(scanLast.at ? (scanLast.at + '　' + scanLast.text) : '还没有扫过。') + '</p>' +
        '</div>' +
        '<div class="card"><h2>AI 接入</h2>' +
          '<p class="muted small">AI 问答、AI 摘要、看图识字、自动出题都要靠一个“大模型接口”。默认已经指向这台电脑上的本机代理（不用密钥、不花钱），只要 CC Switch 开着就能用。也可以换成 DeepSeek、硅基流动、阿里云百炼、智谱等云端服务，只要填对地址和密钥。</p>' +
          '<div class="hintbox" style="margin-top:10px">' +
            '当前状态：' + (ai.has_key ? '<b>已填写密钥</b>' : '<b>未填密钥</b>') +
            '　·　接口地址：<code>' + esc(ai.base_url || '') + '</code>' +
            '　·　文字模型：<code>' + esc(ai.model_text || '') + '</code>' +
            '　·　看图模型：<code>' + esc(ai.model_vision || '') + '</code>' +
          '</div>' +
          '<div class="fields">' +
            '<label>服务商预设<select id="aiPreset">' + presetOpts + '</select></label>' +
            '<label>接口地址（base_url）<input type="text" id="aiUrl" value="' + esc(ai.base_url || '') + '" placeholder="http://127.0.0.1:15721/v1"></label>' +
            '<label>密钥（API Key，本机代理留空）<input type="password" id="aiKey" placeholder="' + (ai.has_key ? '已保存，留空表示不改' : '粘贴你的密钥；本机代理可留空') + '" autocomplete="off"></label>' +
            '<label>文字模型（摘要 / 出题 / 深度思考）<input type="text" id="aiText" value="' + esc(ai.model_text || '') + '"></label>' +
            '<label>看图模型（扫描件识别 / 普通问答）<input type="text" id="aiVision" value="' + esc(ai.model_vision || '') + '"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:12px">' +
            '<button class="btn primary" id="aiSave">保存</button>' +
            '<button class="btn" id="aiTest">测试连接</button>' +
            '<button class="btn" id="aiReset">恢复默认</button>' +
            '<span class="muted small" id="aiOut"></span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:10px">说明：保存后立即生效，索引里排队等识别的图片会用新配置继续跑。密钥只存在本机 <code>storage.json</code> 里，不会发到用户端页面。</p>' +
        '</div>' +
        '<div class="card"><h2>谁能用这个网站</h2>' +
          '<p class="muted small">决定别人怎么拿到账号。第一个注册的账号会成为管理员——这个站点里只有你这一个管理员。</p>' +
          '<div class="fields">' +
            '<label>注册方式<select id="regMode">' +
              '<option value="invite"' + (reg.open ? '' : ' selected') + '>需要邀请码</option>' +
              '<option value="open"' + (reg.open ? ' selected' : '') + '>开放注册（谁都能注册）</option>' +
            '</select></label>' +
            '<label>邀请码<input type="text" id="regCode" value="' + esc(reg.invite_code || '') + '" style="text-transform:uppercase"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<button class="btn primary" id="regSave">保存</button>' +
            '<button class="btn" id="regNew">换一个新邀请码</button>' +
            '<span class="muted small" id="regOut"></span>' +
          '</div>' +
          '<div class="hintbox" style="margin-top:12px">' +
            '别人和你在同一个 Wi-Fi 下时，让他打开：<code>' + esc(lan) + '</code><br>' +
            (reg.open ? '现在是开放注册：知道网址的人都能自己注册。'
                      : '现在需要邀请码：把网址和上面的邀请码一起发给他。') +
          '</div>' +
          '<div class="row" style="margin-top:14px">' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">' +
              '<input type="checkbox" id="aiShare"' + (shareAi ? ' checked' : '') + '> ' +
              '允许局域网里的人共用我的 AI（会消耗我的额度）</label>' +
            '<button class="btn small" id="aiShareSave">保存</button>' +
            '<span class="muted small" id="aiShareOut"></span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:8px">默认<b>关闭</b>：别人用 AI 会走他自己的密钥，不花你的钱。' +
            '关掉后，他们的 AI 按钮会变灰并提示原因。</p>' +
        '</div>' +
        '<div class="card"><h2>发布公网版（发给所有人用）</h2>' +
          '<p class="muted small">生成一个<b>单文件 HTML</b>：别人双击就能用，也可以传到 GitHub Pages 变成一个网址。' +
          '它<b>不含你的任何资料、账号、笔记和密钥</b>，别人上传的文件只存在他自己的浏览器里——' +
          '不占你的硬盘、不花你的钱。打开它需要一个分享码。</p>' +
          '<div class="fields">' +
            '<label>分享码<input type="text" id="wbCode" value="' + esc(wb.share_code || '') + '" style="text-transform:uppercase"></label>' +
            '<label>文件标题<input type="text" id="wbTitle" value="学习资料库"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<button class="btn primary" id="wbBuild">生成</button>' +
            '<button class="btn" id="wbNew">换一个分享码</button>' +
            '<a class="btn" href="/api/webbuild/download">下载</a>' +
            '<span class="muted small" id="wbOut"></span>' +
          '</div>' +
          '<div class="hintbox" style="margin-top:12px">' +
            (wb.built
              ? ('上次生成：' + esc(wb.built.at) + '　·　大小 ' + esc(wb.built.size_label)
                 + '<br>文件：<code>' + esc(wb.built.path) + '</code>')
              : '还没有生成过。点“生成”会打包界面、21 个模型动画和 AI 工具，第一次要下载 pdf.js，稍等一会儿。') +
          '</div>' +
          '<p class="muted small" style="margin-top:8px">分享码是给人进门的，不是加密：懂技术的人仍可能看到里面的<b>工具代码</b>，' +
            '但因为里面没有你的任何资料，所以没有泄露风险。换了分享码之后要重新生成、重新发文件。</p>' +
        '</div>' +
        '<div class="card"><h2>公网版借用本机抓取</h2>' +
          '<p class="muted small">公网单文件版（发给别人的那个 html）自己抓不了网页。打开这个开关后，' +
          '对方在页面里填上你的地址和连接码，就能借你这台机器搜索、抓正文、按主题收集——' +
          '抓到的内容存在<b>他自己浏览器</b>里，不占你的硬盘、不花你的钱。</p>' +
          '<div class="fields">' +
            '<label>连接码<input type="text" id="brToken" value="' + esc(br.token || '') + '" placeholder="点下面“换一个连接码”生成" style="text-transform:uppercase"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center">' +
              '<input type="checkbox" id="brOn"' + (br.enabled ? ' checked' : '') + '> 允许公网版借用（默认关闭）</label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<button class="btn primary" id="brSave">保存</button>' +
            '<button class="btn" id="brNew">换一个连接码</button>' +
            '<span class="muted small" id="brOut"></span>' +
          '</div>' +
          '<div class="hintbox" style="margin-top:12px">' +
            '把这两样填进公网版页面的「连接服务器」里：地址 <code>' + esc(lan || '') + '</code>　连接码 <code>' + esc(br.token || '（还没生成）') + '</code><br>' +
            '同一个 Wi-Fi 下才连得上；想让校外的人也连，需要内网穿透（不在本工具范围内）。' +
          '</div>' +
        '</div>' +
        '<div class="card"><h2>数据存放位置</h2>' +
          '<p class="muted small">数据库、上传的资料、缩略图和导出文件都放在这个文件夹里。换到空间更大的硬盘时，可以勾选“复制过去”，原来的文件不会删。</p>' +
          '<div class="hintbox" style="margin-top:10px">' +
            '当前目录：<code>' + esc(st.dir || '') + '</code><br>' +
            '所在磁盘剩余空间：<b>' + esc(st.free_label || human(st.free)) + '</b>' +
            (st.is_default ? '　·　正在用默认位置' : '　·　已经改成自定义位置') +
          '</div>' +
          '<div class="fields">' +
            '<label style="grid-column:1/-1">新的数据目录<input type="text" id="stDir" value="' + esc(st.dir || '') + '" placeholder="例如 D:\\学习网页数据"></label>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<label class="muted small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="stCopy" checked> 把现有数据复制到新目录</label>' +
          '</div>' +
          '<div class="row" style="margin-top:12px">' +
            '<button class="btn" id="stPick">选择文件夹…</button>' +
            '<button class="btn primary" id="stSave">保存</button>' +
            '<span class="muted small" id="stOut"></span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:10px">改完要重启服务才会生效：先运行 <code>停止.bat</code>，再运行 <code>启动.bat</code>。</p>' +
        '</div>' +
      '</div>';
    renderRoots();
    bindSettings();
  }

  function rootsHtml() {
    var list = S.roots || [];
    if (!list.length) {
      return '<div class="muted small">还没有额外目录。点「+ 添加目录」选一个文件夹，比如放网课视频或试卷的盘。</div>';
    }
    return list.map(function (n, i) {
      return '<div class="rootrow" data-id="' + esc(n.id || '') + '" data-idx="' + i + '"' +
        ' style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px">' +
        '<input type="text" class="rootName" maxlength="30" placeholder="名称（如 网课资料）" value="' + esc(n.name || '') + '" style="width:150px">' +
        '<input type="text" class="rootPath" placeholder="绝对路径，例如 E:' + esc(String.fromCharCode(92)) + '我的资料" value="' + esc(n.path || '') + '" style="flex:1;min-width:220px">' +
        '<label class="muted small" style="display:flex;gap:4px;align-items:center">' +
          '<input type="checkbox" class="rootOn"' + (n.enabled !== false ? ' checked' : '') + '> 启用</label>' +
        '<button class="btn small rootDel" type="button">删除</button>' +
        '</div>';
    }).join('');
  }

  function renderRoots() {
    var box = el('rootList');
    if (!box) { return; }
    box.innerHTML = rootsHtml();
    var dels = box.querySelectorAll('.rootDel');
    for (var i = 0; i < dels.length; i++) {
      dels[i].onclick = function () {
        var row = this.closest ? this.closest('.rootrow') : null;
        var idx = row ? parseInt(row.getAttribute('data-idx'), 10) : -1;
        if (idx >= 0 && S.roots) { S.roots.splice(idx, 1); }
        renderRoots();
      };
    }
  }

  function collectRoots() {
    var box = el('rootList');
    if (!box) { return []; }
    var rows = box.querySelectorAll('.rootrow');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var path = rows[i].querySelector('.rootPath').value.trim();
      out.push({ id: rows[i].getAttribute('data-id') || '', name: rows[i].querySelector('.rootName').value.trim(),
                 path: path, enabled: rows[i].querySelector('.rootOn').checked });
    }
    return out;
  }

  function bindSettings() {
    var ai = (S.settings && S.settings.ai) || {};
    var presets = ai.presets || [];
    if (el('regSave')) {
      el('regSave').onclick = function () {
        el('regOut').textContent = '保存中…';
        api('/api/settings/registration', { json: {
          mode: el('regMode').value, invite_code: el('regCode').value
        } }).then(function () {
          el('regOut').textContent = '已保存';
          toast('注册方式已更新');
          loadSettings().then(draw);
        }).catch(function (e) { el('regOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('regNew')) {
      el('regNew').onclick = function () {
        api('/api/settings/registration', { json: { regenerate: true } }).then(function (r) {
          el('regCode').value = (r.registration && r.registration.invite_code) || '';
          toast('换好了，把新邀请码发给别人');
        }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('aiShareSave')) {
      el('aiShareSave').onclick = function () {
        api('/api/settings/shared-ai', { json: { allow: el('aiShare').checked } }).then(function (r) {
          el('aiShareOut').textContent = r.allow_shared_ai ? '已开启' : '已关闭';
          toast(r.allow_shared_ai ? '已允许局域网共用 AI' : '已关闭共用 AI');
        }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('wbBuild')) {
      el('wbBuild').onclick = function () {
        el('wbBuild').disabled = true;
        el('wbOut').textContent = '正在生成…（第一次要下载 pdf.js，可能要半分钟）';
        api('/api/webbuild', { json: { share_code: el('wbCode').value, title: el('wbTitle').value } })
          .then(function (r) {
            el('wbOut').textContent = '生成好了：' + r.size_label;
            if (r.share_code) { el('wbCode').value = r.share_code; }
            toast('已生成，点“下载”拿走');
            loadSettings().then(draw);
          }).catch(function (e) { el('wbOut').textContent = ''; toast(e.message, true); })
          .then(function () { el('wbBuild').disabled = false; });
      };
    }
    if (el('wbNew')) {
      el('wbNew').onclick = function () {
        api('/api/webbuild', { json: { regenerate: true } }).then(function (r) {
          if (r.share_code) { el('wbCode').value = r.share_code; }
          toast('换好了，记得重新生成、重新发文件');
          loadSettings().then(draw);
        }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('brSave')) {
      el('brSave').onclick = function () {
        api('/api/settings/bridge', { json: { enabled: el('brOn').checked, token: el('brToken').value } })
          .then(function (r) {
            var b = r.bridge || {};
            el('brToken').value = b.token || '';
            el('brOut').textContent = b.enabled ? '已开启，对方可以用连接码连接。' : '已关闭。';
            toast(b.enabled ? '已允许公网版借用' : '已关闭借用');
            loadSettings().then(draw);
          }).catch(function (e) { el('brOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('brNew')) {
      el('brNew').onclick = function () {
        api('/api/settings/bridge', { json: { regenerate: true, enabled: el('brOn').checked } })
          .then(function (r) {
            var b = r.bridge || {};
            el('brToken').value = b.token || '';
            el('brOut').textContent = '换了新连接码，记得重新告诉对方。';
            toast('已换新连接码');
            loadSettings().then(draw);
          }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('siteSave')) {
      el('siteSave').onclick = function () {
        var themeValue = el('siteTheme').value;
        el('siteOut').textContent = '保存中…';
        api('/api/settings/site', { json: {
          name: el('siteName').value,
          announcement: el('siteAnn').value,
          theme: themeValue ? { preset: themeValue } : '',
          allow_user_theme: !!el('siteAllowTheme').checked
        } }).then(function (r) {
          el('siteOut').textContent = '已保存';
          toast('站点设置已保存');
          loadSettings().then(draw);
        }).catch(function (e) { el('siteOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('tlsSave')) {
      el('tlsSave').onclick = function () {
        el('tlsOut').textContent = '保存中…';
        api('/api/settings/tls', { json: { enabled: !!el('tlsOn').checked } }).then(function (r) {
          el('tlsOut').textContent = r.note || '已保存';
          toast('已保存，重启服务后生效');
        }).catch(function (e) { el('tlsOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('rootAdd')) {
      el('rootAdd').onclick = function () {
        S.roots = S.roots || [];
        S.roots.push({ id: '', name: '', path: '', enabled: true });
        renderRoots();
        var rows = el('rootList').querySelectorAll('.rootrow');
        if (rows.length) { rows[rows.length - 1].querySelector('.rootPath').focus(); }
      };
    }
    if (el('rootSave')) {
      el('rootSave').onclick = function () {
        el('rootOut').textContent = '保存中…';
        el('rootSave').disabled = true;
        api('/api/settings/source-roots', { json: { roots: collectRoots() } }).then(function (r) {
          toast(r.note || '已保存');
          el('rootOut').textContent = r.removed ? ('已清理 ' + r.removed + ' 条旧记录') : '';
          loadSettings().then(draw);
        }).catch(function (e) {
          el('rootOut').textContent = '';
          toast(e.message, true);
        }).then(function () { var b = el('rootSave'); if (b) { b.disabled = false; } });
      };
    }
    if (el('scanSave')) {
      el('scanSave').onclick = function () {
        el('scanOut').textContent = '保存中…';
        api('/api/settings/scan', { json: { enabled: !!el('scanOn').checked, minutes: el('scanMin').value } })
          .then(function (r) {
            toast(r.note || '已保存');
            loadSettings().then(draw);
          }).catch(function (e) { toast(e.message, true); });
      };
    }
    if (el('scanNow')) {
      el('scanNow').onclick = function () {
        el('scanNow').disabled = true;
        el('scanOut').textContent = '正在扫描，资料多的时候要一会儿…';
        api('/api/settings/scan', { json: { now: true } }).then(function (r) {
          el('scanOut').textContent = (r.last && r.last.at) ? (r.last.at + '　' + r.last.text) : (r.note || '扫完了');
          toast(r.ok ? '扫描完成' : '扫描失败', !r.ok);
        }).catch(function (e) { toast(e.message, true); })
          .then(function () { var b = el('scanNow'); if (b) { b.disabled = false; } });
      };
    }
    if (el('aiPreset')) {
      el('aiPreset').onchange = function () {
        var idx = parseInt(el('aiPreset').value, 10);
        if (isNaN(idx) || !presets[idx]) { return; }
        var pr = presets[idx];
        el('aiUrl').value = pr.base_url;
        el('aiText').value = pr.model_text;
        el('aiVision').value = pr.model_vision;
        toast('已填入「' + pr.name + '」的参数，别忘了填密钥再保存');
      };
    }
    if (el('aiSave')) {
      el('aiSave').onclick = function () {
        var payload = { base_url: el('aiUrl').value.trim(), model_text: el('aiText').value.trim(),
                        model_vision: el('aiVision').value.trim() };
        var key = el('aiKey').value;
        if (key) { payload.api_key = key; }
        el('aiOut').textContent = '保存中…';
        api('/api/settings/ai', { json: payload }).then(function (r) {
          el('aiOut').textContent = r.note || '已保存';
          el('aiKey').value = '';
          toast('AI 接入已保存');
          loadSettings();
        }).catch(function (e) { el('aiOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('aiTest')) {
      el('aiTest').onclick = function () {
        el('aiOut').textContent = '正在连接模型…';
        api('/api/settings/ai/test', { json: {} }).then(function (r) {
          var res = r.result || {};
          el('aiOut').textContent = res.ok ? ('连接成功：' + (res.message || '可用') + '（模型 ' + (res.model || '') + '）')
                                           : ('连接失败：' + (res.message || '未知原因'));
          toast(res.ok ? '模型可用' : '模型不可用', !res.ok);
        }).catch(function (e) { el('aiOut').textContent = ''; toast(e.message, true); });
      };
    }
    if (el('aiReset')) {
      el('aiReset').onclick = function () {
        UI.confirm('恢复成默认的本机代理设置？').then(function (yes) {
          if (!yes) { return; }
          api('/api/settings/ai/reset', { json: {} }).then(function () {
            toast('已恢复默认'); loadSettings();
          }).catch(function (e) { toast(e.message, true); });
        });
      };
    }
    if (el('stPick')) {
      el('stPick').onclick = function () {
        el('stOut').textContent = '正在打开选择窗口，请看任务栏…';
        api('/api/settings/storage/pick', { json: {} }).then(function (r) {
          if (r.picked) { el('stDir').value = r.picked; el('stOut').textContent = '已选择：' + r.picked; }
          else { el('stOut').textContent = '没有选择文件夹。'; }
        }).catch(function (e) { el('stOut').textContent = e.message; });
      };
    }
    if (el('stSave')) {
      el('stSave').onclick = function () {
        el('stOut').textContent = '正在保存…';
        api('/api/settings/storage', { json: { dir: el('stDir').value.trim(), copy: !!el('stCopy').checked } })
          .then(function (r) {
            el('stOut').textContent = r.note || '已保存，重启后生效。';
            toast('数据位置已保存' + (r.copied ? '，复制了 ' + r.copied + ' 个文件' : ''));
            loadSettings();
          })
          .catch(function (e) { el('stOut').textContent = ''; toast(e.message, true); });
      };
    }
  }

  // ---------- 数据加载 ----------
  function loadUsers() {
    var qs = 'page=' + S.uPage + '&size=' + S.uSize
      + '&sort=' + encodeURIComponent(S.uSort) + '&order=' + encodeURIComponent(S.uOrder)
      + '&status=' + encodeURIComponent(S.uStatus);
    if (S.uQuery) { qs += '&q=' + encodeURIComponent(S.uQuery); }
    return api('/api/admin/users?' + qs).then(function (d) {
      S.users = d.items || []; S.violations = d.violations || []; S.totals = d.totals || {};
      S.uPages = d.pages || 1; S.uMatched = d.matched || 0; S.uPage = d.page || 1;
    });
  }

  function loadAudit() {
    var qs = 'limit=' + S.auditLimit;
    if (S.auditUser) { qs += '&user_id=' + encodeURIComponent(S.auditUser); }
    if (S.auditLevel) { qs += '&level=' + encodeURIComponent(S.auditLevel); }
    if (S.auditAction) { qs += '&action=' + encodeURIComponent(S.auditAction); }
    return api('/api/admin/audit?' + qs).then(function (d) { S.audit = d.items || []; });
  }

  function loadFeedback() {
    var qs = S.fbStatus ? ('?status=' + encodeURIComponent(S.fbStatus)) : '';
    return api('/api/feedback' + qs).then(function (d) {
      S.feedback = d.items || [];
      S.fbNew = d.new_count || 0;
    });
  }

  function loadSettings() {
    return api('/api/settings').then(function (d) { S.settings = d; })
      .then(function () {
        return api('/api/webbuild/info')
          .then(function (w) { S.webbuild = w; })
          .catch(function () { S.webbuild = {}; });
      });
  }

  function loadBackup() {
    return api('/api/admin/backup/info').then(function (d) { S.backup = d.info || {}; });
  }

  // ---------- 数据备份 ----------
  function viewBackup() {
    var b = S.backup || {};
    var db = b.db || {};
    var up = b.uploads || {};
    var last = b.last;
    var items = (up.items || []).map(function (f) {
      return '<tr><td>' + esc(f.path) + '</td><td class="num">' + esc(f.size_label) + '</td>' +
        '<td class="muted small">' + esc(f.at) + '</td></tr>';
    }).join('');
    el('app').innerHTML =
      '<div class="wrap">' +
        '<div class="card"><h2>数据备份</h2>' +
          '<div class="grid g-stat">' +
            statBox('数据库', db.size_label || human(db.bytes), (db.materials || 0) + ' 份资料的索引与文字') +
            statBox('上传的文件', up.count || 0, (up.size_label || human(up.bytes)) + '（存在本机）') +
            statBox('最近快照', last ? last.at : '还没生成过', last ? ('大小 ' + last.size_label) : '点下面的按钮生成') +
            statBox('磁盘可用', b.disk_free_label || human(b.disk_free), '数据目录所在磁盘') +
          '</div>' +
          '<div class="row" style="margin-top:14px">' +
            '<button class="btn primary" id="bkDb">下载数据库快照</button>' +
            '<button class="btn" id="bkManifest">下载资料清单（JSON）</button>' +
            '<span class="muted small" id="bkOut"></span>' +
          '</div>' +
          '<p class="muted small" style="margin-top:10px">' + esc(b.note || '') +
            '　快照只在本机保留最近 ' + esc(String(b.keep || 1)) + ' 份，目录：<code>' +
            esc(b.backup_dir || '') + '</code></p>' +
        '</div>' +
        '<div class="card"><h2>数据库里有什么</h2>' +
          '<p class="muted small">路径：<code>' + esc(db.path || '') + '</code>　·　' +
            esc(db.library_label || human(db.library_bytes)) + ' 的资料索引（原文件不在数据库里）</p>' +
          '<p class="muted small">账号、笔记、收藏、做题记录、AI 总结、答疑、反馈都在这个文件里；换电脑或者重装时把它放回 <code>data\</code> 就能恢复。</p>' +
        '</div>' +
        '<div class="card"><h2>本机上传目录里的文件</h2>' +
          '<p class="muted small">目录：<code>' + esc(up.dir || '') + '</code>　·　共 ' + (up.count || 0) +
            ' 个（下面最多列 60 个；完整的在"资料清单"里）</p>' +
          (items ? '<div class="scroll"><table class="adm"><thead><tr><th>文件</th><th class="num">大小</th><th>修改时间</th></tr></thead><tbody>' +
            items + '</tbody></table></div>' : '<p class="muted small">这个目录还是空的。</p>') +
        '</div>' +
      '</div>';
    el('bkDb').onclick = function () {
      el('bkOut').textContent = '正在生成快照（' + (db.size_label || '') + '，要等几秒）…';
      window.location.href = '/api/admin/backup/db';
      setTimeout(function () {
        if (el('bkOut')) { el('bkOut').textContent = '已开始下载。刷新本页可以看到最近快照时间。'; }
      }, 4000);
    };
    el('bkManifest').onclick = function () {
      el('bkOut').textContent = '正在整理清单…';
      window.location.href = '/api/admin/backup/manifest';
      setTimeout(function () { if (el('bkOut')) { el('bkOut').textContent = '清单已开始下载。'; } }, 2000);
    };
  }

  // 重新拉一遍"当前这页"的数据再画。以前只重画不重拉，
  // 结果管理员回复/删除反馈后页面还是旧的，看着像"操作没生效"。
  function refresh() {
    return loadUsers().then(function () {
      renderTabs();
      if (S.tab === 'feedback') { return loadFeedback(); }
      if (S.tab === 'audit') { return loadAudit(); }
      if (S.tab === 'settings') { return loadSettings(); }
      if (S.tab === 'backup') { return loadBackup(); }
      return null;
    }).then(draw);
  }

  function draw() {
    if (S.tab === 'overview') { viewOverview(); return; }
    if (S.tab === 'users') { viewUsers(); return; }
    if (S.tab === 'violations') { viewViolations(); return; }
    if (S.tab === 'feedback') { viewFeedback(); return; }
    if (S.tab === 'audit') { viewAudit(); return; }
    if (S.tab === 'backup') { viewBackup(); return; }
    if (S.tab === 'settings') { viewSettings(); return; }
  }

  function go() {
    renderTabs();
    el('app').innerHTML = '<div class="loading">正在加载…</div>';
    loadUsers().then(function () {
      if (S.tab === 'feedback') { return loadFeedback(); }
    if (S.tab === 'audit') { return loadAudit(); }
      if (S.tab === 'settings') { return loadSettings(); }
      if (S.tab === 'backup') { return loadBackup(); }
      return null;
    }).then(draw).catch(function (e) {
      el('app').innerHTML = '<div class="wrap"><div class="card">读取失败：' + esc(e.message) + '</div></div>';
    });
  }

  function boot() {
    api('/api/me').then(function (d) {
      S.me = d.user;
      if (!S.me || !S.me.is_admin) { location.href = '/'; return; }
      renderTop();
      go();
    }).catch(function () { location.href = '/'; });
  }

  boot();
})();
