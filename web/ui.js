/* 页内对话框：替代原生 window.prompt / window.confirm。
   不少内置浏览器（App 内嵌、部分安全策略下）会直接屏蔽原生对话框，点了完全没反应，
   管理端"回复反馈"就踩过这个坑。所以统一换成页面内的弹窗。 */
(function () {
  var mask = null;
  var cur = null;

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function close(result) {
    if (!mask || !cur) { return; }
    var box = mask;
    var done = cur.resolve;
    cur = null;
    mask = null;
    document.removeEventListener('keydown', onKey, true);
    box.classList.remove('on');
    window.setTimeout(function () {
      if (box.parentNode) { box.parentNode.removeChild(box); }
    }, 180);
    done(result);
  }

  function onKey(ev) {
    if (!cur) { return; }
    if (ev.key === 'Escape') { ev.preventDefault(); close(null); return; }
    if (ev.key !== 'Enter') { return; }
    if (cur.kind === 'prompt') {
      if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); close(cur.input.value); }
      return;
    }
    ev.preventDefault();
    close(true);
  }

  function open(kind, message, opts) {
    opts = opts || {};
    if (mask) { close(null); }
    var box = node('div', 'ui-mask');
    mask = box;
    var card = node('div', 'ui-card');
    card.appendChild(node('div', 'ui-msg', message));
    var input = null;
    if (kind === 'prompt') {
      input = node('input', 'ui-input');
      input.type = 'text';
      input.value = (opts.value === undefined || opts.value === null) ? '' : String(opts.value);
      if (opts.placeholder) { input.placeholder = opts.placeholder; }
      card.appendChild(input);
    }
    var acts = node('div', 'ui-acts');
    var cancel = node('button', 'btn', opts.cancelText || '取消');
    cancel.type = 'button';
    var ok = node('button', 'btn primary', opts.okText || '确定');
    ok.type = 'button';
    acts.appendChild(cancel);
    acts.appendChild(ok);
    card.appendChild(acts);
    box.appendChild(card);
    document.body.appendChild(box);
    window.requestAnimationFrame(function () { box.classList.add('on'); });

    return new Promise(function (resolve) {
      cur = { kind: kind, resolve: resolve, input: input };
      cancel.onclick = function () { close(null); };
      ok.onclick = function () { close(kind === 'prompt' ? input.value : true); };
      box.onclick = function (ev) { if (ev.target === box) { close(null); } };
      if (input) { input.focus(); input.select(); } else { ok.focus(); }
      document.addEventListener('keydown', onKey, true);
    });
  }

  window.UI = {
    confirm: function (message, opts) {
      return open('confirm', message, opts).then(function (v) { return v === true; });
    },
    prompt: function (message, value, opts) {
      if (value !== undefined && value !== null && typeof value === 'object') {
        opts = value;
        value = opts.value;
      }
      opts = opts || {};
      opts.value = value;
      return open('prompt', message, opts);
    }
  };
})();