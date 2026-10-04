/* 文件夹模式：让网站直接读你自己电脑上的文件夹（只在你授权之后），
   自动按“顶层文件夹=分类 / 后缀=类型”分类，并且能把你整理好的内容写回去。
   说明：浏览器只在 https 或 127.0.0.1 下才允许选文件夹；手机浏览器不支持这个能力。 */
(function () {
  'use strict';
  var DB_NAME = 'study_folder_v1';
  var DB_VERSION = 3;
  var STORE = 'state';
  var DOCS = 'docs';
  var TEXTS = 'texts';

  // 抽出来的文字要和上传文件放同一个检索语料里（store.js 的 matchHits 直接用）。
  // 顶层后缀 -> store.js 抽取器认的类型
  var EXTRACT_KIND = { pdf: 'pdf', doc: 'word', ppt: 'ppt', sheet: 'excel', text: 'text', html: 'web' };
  var MAX_TEXT_BYTES = 60 * 1024 * 1024;
  var MAX_DEPTH = 6;
  var MAX_FILES = 20000;
  var SUBJECT_FALLBACK = '未分类';

  var KINDS = {
    pdf: 'pdf', doc: 'doc', docx: 'doc', ppt: 'ppt', pptx: 'ppt', xls: 'sheet', xlsx: 'sheet',
    csv: 'sheet', txt: 'text', md: 'text', json: 'text', html: 'html', htm: 'html',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
    mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
    mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio'
  };

  var KIND_LABEL = { pdf: 'PDF', doc: '文档', ppt: 'PPT', sheet: '表格', text: '文本',
    html: '网页', image: '图片', video: '视频', audio: '音频', other: '其它' };

  function extOf(name) {
    var i = String(name).lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  function kindOf(name) {
    return KINDS[extOf(name)] || 'other';
  }

  var dbPromise = null;

  // 连接只开一次：上千份资料的循环里每步都 open() 会白开几千个连接。
  function openDB() {
    if (dbPromise) { return dbPromise; }
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        var tx = req.transaction;
        if (!db.objectStoreNames.contains(STORE)) { db.createObjectStore(STORE); }
        // v3：文字改成按 key 精确增删，老表结构用不了，重建（浏览器里的数据，重扫一次就有）。
        if (db.objectStoreNames.contains(DOCS)) { db.deleteObjectStore(DOCS); }
        if (db.objectStoreNames.contains(TEXTS)) { db.deleteObjectStore(TEXTS); }
        db.createObjectStore(DOCS);
        db.createObjectStore(TEXTS);
        // 清掉上次的扫描记录，页面下次打开自动重扫、把文字补回来（文件夹句柄还留着，不用重选）。
        tx.objectStore(STORE).delete('snapshot');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error || new Error('打不开本地数据库')); };
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    });
  }

  // 下面三个是给 docs / texts 两个表用的（按明确 key 存，兼容性最好）。
  function idbAll(storeName) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbGetIn(storeName, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPutIn(storeName, value, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelIn(storeName, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    });
  }

  // 双击打开的本地文件（file://）里浏览器不给读文件夹，这种模式要如实说“用不了”。
  function isFileMode() {
    return !!(window.location && window.location.protocol === 'file:');
  }

  function supported() {
    return !isFileMode() && !!window.showDirectoryPicker && !!window.isSecureContext;
  }

  function why() {
    if (isFileMode()) {
      return '现在是双击打开的本地文件模式，浏览器不允许读文件夹。把这个页面放到网址上（https）打开，'
        + '或者用本站的在线地址打开，就能用文件夹模式了。';
    }
    if (!window.isSecureContext) {
      return '现在这个网址不是“安全上下文”，浏览器不允许读文件夹。'
        + '请在管理员端打开 HTTPS 之后，用 https:// 地址打开本站；127.0.0.1 也算安全上下文。';
    }
    if (!window.showDirectoryPicker) {
      return '这个浏览器不支持“选择文件夹”。请用电脑版 Chrome 或 Edge（手机浏览器都不支持这个能力）。';
    }
    return '';
  }

  // 提示里要带上本站地址，用户才知道该去哪儿打开。
  function pageUrl() {
    try {
      var loc = window.location || {};
      if (loc.origin && loc.pathname) { return String(loc.origin + loc.pathname); }
      if (loc.href) { return String(loc.href).split('#')[0]; }
    } catch (e) {}
    return '本站地址';
  }

  // 内置浏览器（Codex 自带的那种）里实测到的原话：
  // AbortError: Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.
  // 前面那句 “Failed to execute … on 'Window'” 说明是浏览器自己没能把窗口开起来/完成，
  // 不是用户点了取消（用户取消是没有前缀的 The user aborted a request.）。
  function embedderAbort(e) {
    return /Failed to execute 'showDirectoryPicker' on 'Window'/i.test(String((e && e.message) || ''));
  }

  // 浏览器抛出来的是英文 DOMException（例如 The user aborted a request.），这里统一说人话。
  // ms 是从点按钮到报错过了多少毫秒：几百毫秒内就 abort，说明这个浏览器根本没把选文件夹的窗口弹出来。
  // lostFocus = 弹窗期间页面失去过焦点（说明窗口真的弹出来了）。实测：Codex 内置浏览器里窗口会弹、
  // 用户也操作了 8 秒，最后仍然回 AbortError——这种必须说实话，不能反过来冒充“你取消了”。
  function friendly(e, ms, lostFocus) {
    var name = (e && e.name) || '';
    var msg = (e && e.message) || String(e || '');
    var quick = typeof ms === 'number' && ms < 400;
    var cancelled = name === 'AbortError' || /^the user aborted a request/i.test(msg);
    if (cancelled && lostFocus && !quick) {
      return '窗口弹出来了，但这个浏览器没能把选中的文件夹交回来（内置浏览器常见）。'
        + '点「兼容扫描」就能用；或者改用电脑版 Edge / Chrome 打开 ' + pageUrl() + '。';
    }
    if (cancelled && (quick || embedderAbort(e))) {
      return '没能完成选择：这个浏览器没有打开“选文件夹”的窗口（内置浏览器、被管控的浏览器常见）。'
        + '点「兼容扫描」就能用；或者改用电脑版 Edge / Chrome 打开 ' + pageUrl() + '。';
    }
    // 弹窗被关掉（点取消、按 Esc，或者双击进文件夹之后又关掉弹窗）——说清楚怎么才算真的选中。
    if (cancelled) {
      return '没有选中文件夹：弹窗被取消/关掉了。再点一次，在弹窗里点一下文件夹，'
        + '然后点右下角的「选择文件夹」按钮（双击文件夹是“进入”它，不算选中）。';
    }
    if (/cross origin sub frames|not allowed to show a file picker|permissions policy/i.test(msg)) {
      return '这个页面被嵌在别的窗口里，浏览器不让它弹“选文件夹”的窗口（内置浏览器常见）。'
        + '请用电脑版 Edge 或 Chrome 打开 ' + pageUrl() + ' 再选。';
    }
    if (/must be handling a user gesture/i.test(msg)) {
      return '要用鼠标直接点「选择文件夹」这个按钮，脚本或快捷键触发时浏览器会拒绝。';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '浏览器没有给这个文件夹的权限。再点一次，在弹窗里选“允许”，或者换一个文件夹。';
    }
    if (name === 'NotFoundError') {
      return '这个文件（或文件夹）已经不在了，可能被移动、改名或删掉了。点「立即刷新」重新扫一遍。';
    }
    if (name === 'InvalidStateError' || name === 'InvalidModificationError') {
      return '这个文件夹刚好被别的程序改了，稍等一会儿再试一次。';
    }
    if (name === 'QuotaExceededError') {
      return '写不进去：磁盘空间不够，或者浏览器没拿到写入许可。';
    }
    if (/[\u4e00-\u9fa5]/.test(msg)) { return msg; }
    return '文件夹操作没成功：' + (msg || '再试一次。');
  }

  function friendlyError(e, ms, lostFocus) {
    var err = new Error(friendly(e, ms, lostFocus));
    err.cancelled = !!((e && e.name === 'AbortError') || /^the user aborted a request/i.test((e && e.message) || ''));
    err.noDialog = err.cancelled && (typeof ms === 'number' && ms < 400 || embedderAbort(e) || !!lostFocus);
    err.raw = (e && e.message) || '';
    err.rawName = (e && e.name) || '';
    return err;
  }

  // 选文件夹失败的原因只在用户浏览器里发生，服务端看不到：把原始报错送一份到 data/folder_diag.log。
  // 单文件公网版（STUDY_MODE=local）不发任何请求。
  function reportDiag(info) {
    try {
      if (window.STUDY_MODE === 'local') { return; }
      if (!window.navigator || !window.location) { return; }
      if (!/^https?:/.test(String(window.location.protocol))) { return; }
      var body = JSON.stringify(info);
      if (window.navigator.sendBeacon) {
        window.navigator.sendBeacon('/api/folder/diag', new Blob([body], { type: 'application/json' }));
        return;
      }
      if (window.fetch) {
        window.fetch('/api/folder/diag', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: body });
      }
    } catch (e) {}
  }

  function diagOf(where, e, ms, lostFocus) {
    var inFrame = false;
    try { inFrame = window.top !== window.self; } catch (e2) { inFrame = false; }
    return {
      where: where,
      lostFocus: !!lostFocus,
      name: (e && e.name) || '',
      message: (e && e.message) || String(e || ''),
      ms: ms,
      hasPicker: !!window.showDirectoryPicker,
      secure: !!window.isSecureContext,
      inFrame: inFrame,
      href: String((window.location && window.location.href) || ''),
      ua: String((window.navigator && window.navigator.userAgent) || '')
    };
  }

  async function walk(dir, rel, depth, docs, state) {
    if (depth > MAX_DEPTH || docs.length >= MAX_FILES) { return; }
    // 目录整个读不动、或者读到一半读不动（被删/没权限/被占用）时跳过它，别让一次扫描全崩。
    var it;
    try {
      it = dir.values();
    } catch (e) { state.skipped++; return; }
    while (true) {
      if (docs.length >= MAX_FILES) { return; }
      var step;
      try {
        step = await it.next();
      } catch (e) { state.skipped++; return; }
      if (step.done) { return; }
      var entry = step.value;
      var name = entry.name || '';
      if (name.startsWith('.') || name === 'node_modules' || name === 'System Volume Information') { continue; }
      var here = rel ? rel + '/' + name : name;
      var parts = here.split('/');
      var subject = parts.length > 1 ? parts[0] : SUBJECT_FALLBACK;
      try {
        if (entry.kind === 'directory') {
          state.folders++;
          if (!state.subjects[subject]) { state.subjects[subject] = 0; }
          await walk(entry, here, depth + 1, docs, state);
        } else if (entry.kind === 'file') {
          var file = await entry.getFile();
          var kind = kindOf(name);
          if (!state.subjects[subject]) { state.subjects[subject] = 0; }
          state.subjects[subject]++;
          docs.push({
            id: 'f:' + here,
            mode: 'folder',
            name: name,
            subject: subject,
            relPath: here,
            ext: extOf(name),
            kind: kind,
            size: file.size || 0,
            mtime: (file.lastModified || 0) / 1000
          });
          // 扫描时顺手记住句柄，紧接着抽文字就不用再走一遍目录。
          if (state.entries) { state.entries['f:' + here] = entry; }
        }
      } catch (e) {
        state.skipped++;
      }
    }
  }

  async function scan(opts) {
    opts = opts || {};
    var saved = await idbGet('root');
    if (!saved || !saved.handle) { throw new Error('还没有选择文件夹'); }
    var handle = saved.handle;
    var perm = 'granted';
    try {
      if (handle.queryPermission) { perm = await handle.queryPermission({ mode: 'read' }); }
    } catch (e) { perm = 'granted'; }
    if (perm !== 'granted') {
      var err = new Error('浏览器把授权收回了，点“重新选择文件夹”再确认一次就能继续。');
      err.needPermission = true;
      throw err;
    }
    var docs = [];
    var state = { folders: 0, skipped: 0, subjects: {}, entries: {} };
    try {
      await walk(handle, '', 0, docs, state);
    } catch (e) {
      throw friendlyError(e);
    }
    var old = await idbGet('snapshot');
    var oldMap = {};
    (old && old.docs ? old.docs : []).forEach(function (doc) { oldMap[doc.id] = doc; });
    var added = 0;
    var changed = 0;
    docs.forEach(function (doc) {
      var before = oldMap[doc.id];
      if (!before) { added++; return; }
      if (Math.abs((before.mtime || 0) - (doc.mtime || 0)) > 1 || before.size !== doc.size) { changed++; }
    });
    var removedIds = Object.keys(oldMap).filter(function (id) {
      return !docs.some(function (doc) { return doc.id === id; });
    });
    var snapshot = { docs: docs, scannedAt: Date.now(), folder: handle.name || '',
      folders: state.folders, skipped: state.skipped, subjects: state.subjects };
    await idbPut('snapshot', snapshot);

    // 文件不在了：把它的记录和文字一起清掉，别让搜索搜出已经不存在的文件。
    for (var r = 0; r < removedIds.length; r++) {
      await writeDocTexts(removedIds[r], []);
      await idbDelIn(DOCS, removedIds[r]);
    }

    var result = { added: added, changed: changed, removed: removedIds.length };
    if (opts.extract === false) { return Object.assign({}, snapshot, result); }

    // 文字提取：只跑“没抽过”或者“改过”的文件，改一个抽一个。
    var jobs = [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!canExtract(d)) { continue; }
      var rec = await idbGetIn(DOCS, d.id);
      var stale = !rec || rec.mtime !== d.mtime || rec.size !== d.size
        || rec.text_state === undefined || rec.text_state === 'pending' || rec.text_state === 'failed';
      if (stale) { jobs.push(d); }
    }
    var indexed = 0;
    var failed = 0;
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      try {
        var entry = state.entries[job.id];
        var blob = entry ? await entry.getFile() : await fileOf(job.relPath);
        await indexOne(job, blob);
      } catch (e) { failed++; }
      indexed++;
      if (opts.onProgress) {
        try { opts.onProgress({ done: indexed, total: jobs.length, name: job.name, failed: failed }); } catch (e2) {}
      }
    }
    return Object.assign({}, snapshot, result,
      { indexed: indexed, indexFailed: failed, indexTotal: jobs.length });
  }

  function canExtract(doc) {
    if (!window.StudyStore || !window.StudyStore.extractFor) { return false; }
    return !!EXTRACT_KIND[doc.kind] && (doc.size || 0) <= MAX_TEXT_BYTES;
  }

  function needsVision(doc) {
    return doc.kind === 'image' || doc.kind === 'pdf';
  }

  // 只动这一份资料的 key（记录里存着上次写了哪些），不要每次全表扫描。
  async function writeDocTexts(docId, pages) {
    var rec = (await idbGetIn(DOCS, docId)) || {};
    var olds = rec.text_keys || [];
    for (var i = 0; i < olds.length; i++) { await idbDelIn(TEXTS, olds[i]); }
    var keys = [];
    for (var j = 0; j < pages.length; j++) {
      var p = pages[j];
      var key = docId + ':' + p.page;
      await idbPutIn(TEXTS, { key: key, material_id: docId, page: p.page,
        origin: p.origin || 'extract', content: String(p.content || '') }, key);
      keys.push(key);
    }
    return keys;
  }

  async function saveDocRecord(doc, patch) {
    var rec = (await idbGetIn(DOCS, doc.id)) || {};
    var next = Object.assign({}, rec, {
      id: doc.id, name: doc.name, subject: doc.subject, kind: doc.kind, ext: doc.ext,
      size: doc.size, mtime: doc.mtime, relPath: doc.relPath, origin: doc.origin || 'folder'
    }, patch || {});
    await idbPutIn(DOCS, next, doc.id);
    return next;
  }

  async function indexOne(doc, blob) {
    var pages = [];
    try {
      pages = await window.StudyStore.extractFor(blob, EXTRACT_KIND[doc.kind], doc.ext);
    } catch (e) { pages = []; }
    var keys = await writeDocTexts(doc.id, pages);
    var has = pages.some(function (p) { return String(p.content || '').trim().length > 0; });
    return saveDocRecord(doc, {
      pages: pages.length, text_keys: keys, has_text: has,
      text_state: has ? 'done' : (canExtract(doc) ? 'empty' : 'none'),
      vision_state: has ? 'done' : 'pending', at: Date.now()
    });
  }

  // 交给 store.js 的检索：它会把这里的文字和“上传到浏览器”的资料合在一起搜。
  function searchSources() {
    return Promise.all([idbAll(DOCS), idbAll(TEXTS)]).then(function (res) {
      var docs = (res[0] || []).filter(function (d) { return d.has_text; });
      return { docs: docs, texts: res[1] || [] };
    });
  }

  function stats() {
    return Promise.all([activeSnapshot(), idbAll(DOCS)]).then(function (res) {
      var snap = res[0] || {};
      var recs = {};
      (res[1] || []).forEach(function (d) { recs[d.id] = d; });
      var list = snap.docs || [];
      var searchable = 0;
      var needAi = 0;
      var waiting = 0;
      list.forEach(function (d) {
        var rec = recs[d.id];
        if (rec && rec.has_text) { searchable++; return; }
        if (needsVision(d)) { needAi++; return; }
        if (canExtract(d)) { waiting++; }
      });
      return { total: list.length, searchable: searchable, need_ai: needAi,
        waiting: waiting, indexed: (res[1] || []).length };
    });
  }

  // 扫描件 / 图片：用你自己的视觉密钥认字，认完就能搜到。
  async function visionOne(relPath) {
    var docId = 'f:' + relPath;
    if (!window.StudyStore || !window.StudyStore.visionTextOf) {
      throw new Error('这个页面没有带上识图功能，Ctrl+F5 强刷一下。');
    }
    var blob = await fileOf(relPath);
    var text = await window.StudyStore.visionTextOf(blob);
    if (!text) { throw new Error('AI 没有认出文字，换一张更清楚的图试试。'); }
    var keys = await writeDocTexts(docId, [{ page: 1, origin: 'vision', content: text }]);
    var snap = await activeSnapshot();
    var doc = ((snap && snap.docs) || []).filter(function (d) { return d.id === docId; })[0]
      || { id: docId, name: relPath.split('/').pop(), subject: SUBJECT_FALLBACK,
           kind: kindOf(relPath), ext: extOf(relPath), size: 0, mtime: 0, relPath: relPath };
    await saveDocRecord(doc, { pages: 1, text_keys: keys, has_text: true,
      text_state: 'done', vision_state: 'done', at: Date.now() });
    return { chars: text.length };
  }

  // 「提取文字」按钮：把还没抽过的再跑一遍（比如上次跳过了大文件、或者中途关了页面）。
  async function indexPending(opts) {
    opts = opts || {};
    var snap = await activeSnapshot();
    if (!snap || !snap.docs) { throw new Error('还没有选择文件夹'); }
    var jobs = [];
    for (var i = 0; i < snap.docs.length; i++) {
      var d = snap.docs[i];
      if (!canExtract(d)) { continue; }
      var rec = await idbGetIn(DOCS, d.id);
      if (!rec || !rec.has_text) { jobs.push(d); }
    }
    var done = 0;
    for (var j = 0; j < jobs.length; j++) {
      try { await indexOne(jobs[j], await fileOf(jobs[j].relPath)); } catch (e) {}
      done++;
      if (opts.onProgress) { try { opts.onProgress({ done: done, total: jobs.length, name: jobs[j].name }); } catch (e2) {} }
    }
    return { indexed: done, total: jobs.length };
  }

  // ---- 兼容扫描：内置浏览器（Electron 外壳）不给文件夹句柄，但普通的“选文件夹上传”能用。----
  // 只能一次性读进来：文件对象留在本次会话里，文字进索引，关掉页面要重选（重选同一个文件夹即恢复）。
  var compatInput = null;
  var compatFiles = {};

  function compatSupported() {
    try {
      var probe = document.createElement('input');
      return 'webkitdirectory' in probe || probe.webkitdirectory !== undefined;
    } catch (e) { return false; }
  }

  function compatWhy() {
    if (isFileMode()) { return '双击打开的本地文件模式下浏览器不让读文件夹。放到网址上（https）打开就能用。'; }
    if (!compatSupported()) { return '这个浏览器不支持整目录选择，请用电脑版 Chrome 或 Edge。'; }
    return '';
  }

  function relPathOf(file) {
    var rel = String((file && file.webkitRelativePath) || '') || String((file && file.name) || '');
    var parts = rel.split('/');
    // webkitRelativePath 的第一段是用户选中的那个文件夹本身，去掉它，和句柄模式保持一致。
    if (parts.length > 1) { parts = parts.slice(1); }
    return parts.join('/');
  }

  function rootNameOf(file) {
    var parts = String((file && file.webkitRelativePath) || '').split('/');
    return parts.length > 1 ? parts[0] : '选择的文件夹';
  }

  // 弹出“选文件夹”窗口（普通 input，不需要句柄权限）。取消时 reject。
  function compatPickFiles() {
    return new Promise(function (resolve, reject) {
      if (!compatInput) {
        compatInput = document.createElement('input');
        compatInput.type = 'file';
        compatInput.multiple = true;
        compatInput.setAttribute('webkitdirectory', '');
        compatInput.setAttribute('directory', '');
        compatInput.style.display = 'none';
        document.body.appendChild(compatInput);
      }
      var done = false;
      function detach() {
        try {
          compatInput.removeEventListener('change', onChange);
          compatInput.removeEventListener('cancel', onCancel);
          window.removeEventListener('blur', onBlur);
          window.removeEventListener('focus', onFocus);
        } catch (e) {}
      }
      function finish(files) {
        if (done) { return; }
        done = true;
        detach();
        if (!files || !files.length) {
          reject(new Error('没有选中文件夹：选择窗口被取消/关掉了。再点一次，选一个文件夹，然后点「选择文件夹」/「打开」。'));
          return;
        }
        resolve(files);
      }
      function onChange() { finish(compatInput.files); }
      function onCancel() { finish(null); }
      var blurred = false;
      function onBlur() { blurred = true; }
      function onFocus() {
        setTimeout(function () {
          if (!done && blurred && (!compatInput.files || !compatInput.files.length)) { finish(null); }
        }, 500);
      }
      compatInput.addEventListener('change', onChange);
      compatInput.addEventListener('cancel', onCancel);
      try { window.addEventListener('blur', onBlur); } catch (e) {}
      try { window.addEventListener('focus', onFocus); } catch (e) {}
      compatInput.value = '';
      compatInput.click();
    });
  }

  // 把 input 给的这些文件当成一次目录扫描：顶层文件夹=学科、后缀=类型，文字抽进索引。
  async function compatScan(fileList, opts) {
    opts = opts || {};
    var docs = [];
    var folders = 0;
    var seenFolders = {};
    var rootName = '';
    for (var i = 0; i < fileList.length; i++) {
      if (docs.length >= MAX_FILES) { break; }
      var file = fileList[i];
      var rel = relPathOf(file);
      if (!rel) { continue; }
      var segs = rel.split('/');
      var hidden = false;
      for (var s = 0; s < segs.length; s++) { if (segs[s].charAt(0) === '.') { hidden = true; break; } }
      if (hidden) { continue; }
      if (!rootName) { rootName = rootNameOf(file); }
      var name = segs[segs.length - 1];
      var subject = segs.length > 1 ? segs[0] : SUBJECT_FALLBACK;
      var dirKey = segs.slice(0, -1).join('/');
      if (dirKey && !seenFolders[dirKey]) { seenFolders[dirKey] = 1; folders++; }
      docs.push({
        id: 'f:' + rel, mode: 'folder', origin: 'compat', name: name, subject: subject,
        relPath: rel, ext: extOf(name), kind: kindOf(name),
        size: file.size || 0, mtime: (file.lastModified || 0) / 1000
      });
      compatFiles[rel] = file;
    }
    var subjects = {};
    docs.forEach(function (d) { subjects[d.subject] = (subjects[d.subject] || 0) + 1; });
    await idbDel('root');
    await idbDel('snapshot');
    await idbPut('compat_root', { name: rootName, at: Date.now() });
    var old = await idbGet('compat_snapshot');
    var oldMap = {};
    (old && old.docs ? old.docs : []).forEach(function (doc) { oldMap[doc.id] = doc; });
    var added = 0;
    var changed = 0;
    docs.forEach(function (doc) {
      var before = oldMap[doc.id];
      if (!before) { added++; return; }
      if (Math.abs((before.mtime || 0) - (doc.mtime || 0)) > 1 || before.size !== doc.size) { changed++; }
    });
    var removedIds = Object.keys(oldMap).filter(function (id) {
      return !docs.some(function (doc) { return doc.id === id; });
    });
    var snapshotData = { docs: docs, scannedAt: Date.now(), folder: rootName, compat: true,
      folders: folders, skipped: 0, subjects: subjects };
    await idbPut('compat_snapshot', snapshotData);
    for (var r = 0; r < removedIds.length; r++) {
      await writeDocTexts(removedIds[r], []);
      await idbDelIn(DOCS, removedIds[r]);
    }
    var result = { added: added, changed: changed, removed: removedIds.length, compat: true };
    if (opts.extract === false) { return Object.assign({}, snapshotData, result); }
    var jobs = [];
    for (var d2 = 0; d2 < docs.length; d2++) {
      var doc2 = docs[d2];
      if (!canExtract(doc2)) { continue; }
      var rec = await idbGetIn(DOCS, doc2.id);
      var stale = !rec || rec.mtime !== doc2.mtime || rec.size !== doc2.size
        || rec.text_state === undefined || rec.text_state === 'pending' || rec.text_state === 'failed';
      if (stale) { jobs.push(doc2); }
    }
    var indexed = 0;
    var failed = 0;
    for (var j = 0; j < jobs.length; j++) {
      try { await indexOne(jobs[j], compatFiles[jobs[j].relPath]); } catch (e) { failed++; }
      indexed++;
      if (opts.onProgress) {
        try { opts.onProgress({ done: indexed, total: jobs.length, name: jobs[j].name, failed: failed }); } catch (e2) {}
      }
    }
    return Object.assign({}, snapshotData, result,
      { indexed: indexed, indexFailed: failed, indexTotal: jobs.length });
  }

  var picking = false;

  async function pick() {
    if (!supported()) { throw new Error(why()); }
    if (picking) { throw new Error('选文件夹的弹窗还开着，完成它或者把它关掉再来一次。'); }
    picking = true;
    // 选文件夹的窗口一弹出来，页面就会失去焦点。记下来，下次看日志就知道“到底有没有弹过窗口”。
    var lostFocus = false;
    function markBlur() { lostFocus = true; }
    try { window.addEventListener('blur', markBlur); } catch (e) {}
    try {
      var handle = null;
      var t0 = Date.now();
      try {
        // 只要“读”权限：连写入一起要的话，浏览器会在选完文件夹后再弹一个“允许修改文件”的确认，
        // 那个小窗口很容易被忽略或点掉，用户看到的就是“明明选了文件夹却说没选中”。写权限等真要写的时候再要。
        handle = await window.showDirectoryPicker({ id: 'study-materials', mode: 'read' });
      } catch (e) {
        var ms = Date.now() - t0;
        reportDiag(diagOf('pick', e, ms, lostFocus));
        throw friendlyError(e, ms, lostFocus);
      }
      var perm = 'granted';
      try {
        if (handle.queryPermission) { perm = await handle.queryPermission({ mode: 'read' }); }
      } catch (e) { perm = 'granted'; }
      if (perm !== 'granted') {
        var noRead = { name: 'NotAllowedError', message: 'read permission was not granted' };
        reportDiag(diagOf('permission', noRead, Date.now() - t0));
        throw friendlyError(noRead);
      }
      // 用句柄模式了就清掉兼容扫描留下的那套，两套只留一套，免得列表里一半能打开一半打不开。
      await forgetCompat();
      await idbPut('root', { handle: handle, at: Date.now() });
      return await scan();
    } finally {
      picking = false;
      try { window.removeEventListener('blur', markBlur); } catch (e2) {}
    }
  }

  function snapshot() { return activeSnapshot(); }
  function rootInfo() { return idbGet('root'); }
  function compatRoot() { return idbGet('compat_root'); }
  function sessionFile(relPath) { return !!compatFiles[String(relPath || '')]; }

  // 句柄模式和兼容扫描只会有一套生效：有句柄读 snapshot，否则读兼容扫描留下的那份。
  async function activeSnapshot() {
    var saved = await idbGet('root');
    if (saved && saved.handle) { return idbGet('snapshot'); }
    var compat = await idbGet('compat_snapshot');
    return compat || null;
  }

  // 丢掉兼容扫描那一套（换成句柄模式时用）。
  async function forgetCompat() {
    var snap = await idbGet('compat_snapshot');
    var ids = ((snap && snap.docs) || []).map(function (d) { return d.id; });
    for (var i = 0; i < ids.length; i++) {
      await writeDocTexts(ids[i], []);
      await idbDelIn(DOCS, ids[i]);
    }
    await idbDel('compat_snapshot');
    await idbDel('compat_root');
    compatFiles = {};
  }

  async function forget() {
    var all = await idbAll(TEXTS);
    for (var i = 0; i < all.length; i++) { await idbDelIn(TEXTS, all[i].key); }
    var recs = await idbAll(DOCS);
    for (var j = 0; j < recs.length; j++) { await idbDelIn(DOCS, recs[j].id); }
    await idbDel('root');
    await idbDel('snapshot');
    await idbDel('compat_root');
    await idbDel('compat_snapshot');
    compatFiles = {};
    return true;
  }

  async function fileOf(relPath) {
    var saved = await idbGet('root');
    if (!saved || !saved.handle) {
      // 兼容扫描模式：文件只在本次会话里（关掉页面就要重选一次文件夹）。
      var held = compatFiles[String(relPath || '')];
      if (held) { return held; }
      var compat = await idbGet('compat_root');
      if (compat) {
        throw new Error('这个文件要重新选一次文件夹才能打开：兼容扫描只在本次会话里拿得到文件。'
          + '点「兼容扫描」再选同一个文件夹就行。');
      }
      throw new Error('还没有选择文件夹');
    }
    try {
      var parts = String(relPath).split('/');
      var dir = saved.handle;
      for (var i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
      }
      var handle = await dir.getFileHandle(parts[parts.length - 1]);
      return handle.getFile();
    } catch (e) {
      throw friendlyError(e);
    }
  }

  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
  }

  // 同名不覆盖：自动变成“名字 (1).pdf”这样。
  async function freeName(dir, name) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var candidate = name;
    for (var i = 1; i < 500; i++) {
      var exists = true;
      try { await dir.getFileHandle(candidate); } catch (e) { exists = false; }
      if (!exists) { return candidate; }
      candidate = stem + ' (' + i + ')' + ext;
    }
    return stem + ' (new)' + ext;
  }

  // 选文件夹时只拿了“读”权限；真要写回用户电脑之前，单独要一次写入权限。
  async function ensureWritable(handle) {
    if (!handle) {
      var saved = await idbGet('root');
      if (!saved || !saved.handle) { throw new Error('还没有选择文件夹，先去「文件夹」页选一个。'); }
      handle = saved.handle;
    }
    if (!handle.queryPermission) { return; }
    try {
      var perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && handle.requestPermission) {
        perm = await handle.requestPermission({ mode: 'readwrite' });
      }
      if (perm !== 'granted') {
        throw new Error('这个文件夹没有写入权限，去「文件夹」页重新选一次并点“允许”。');
      }
    } catch (e) {
      throw friendlyError(e);
    }
  }

  async function writeText(subDir, fileName, text) {
    var saved = await idbGet('root');
    if (!saved || !saved.handle) { throw new Error('还没有选择文件夹'); }
    var dir = saved.handle;
    var segs = String(subDir || '').split('/').filter(function (x) { return x; });
    var safe = String(fileName || 'file.md').replace(/[\\/:*?"<>|]/g, '_');
    try {
      await ensureWritable(dir);
      for (var i = 0; i < segs.length; i++) {
        dir = await dir.getDirectoryHandle(segs[i], { create: true });
      }
      var handle = await dir.getFileHandle(safe, { create: true });
      var writable = await handle.createWritable();
      await writable.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      await writable.close();
    } catch (e) {
      throw friendlyError(e);
    }
    return segs.concat(safe).join('/');
  }

  // 把用户上传的文件直接写进他自己的文件夹（受浏览器“安全上下文”限制，手机不支持）。
  async function writeFile(subDir, fileName, blob) {
    var saved = await idbGet('root');
    if (!saved || !saved.handle) { throw new Error('还没有选择文件夹，先去「文件夹」页选一个。'); }
    var handle = saved.handle;
    var segs = String(subDir || '').split('/').filter(function (x) { return x; });
    try {
      await ensureWritable(handle);
      var dir = handle;
      for (var i = 0; i < segs.length; i++) {
        dir = await dir.getDirectoryHandle(segs[i], { create: true });
      }
      var name = await freeName(dir, safeName(fileName));
      var fileHandle = await dir.getFileHandle(name, { create: true });
      var writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      throw friendlyError(e);
    }
    return segs.concat(name).join('/');
  }

  function label(kind) { return KIND_LABEL[kind] || '其它'; }

  window.StudyFolder = {
    supported: supported,
    why: why,
    pick: pick,
    scan: scan,
    compatSupported: compatSupported,
    compatWhy: compatWhy,
    compatScan: compatScan,
    compatPickFiles: compatPickFiles,
    compatRoot: compatRoot,
    sessionFile: sessionFile,
    indexPending: indexPending,
    visionOne: visionOne,
    docs: function () { return idbAll(DOCS); },
    searchSources: searchSources,
    stats: stats,
    snapshot: snapshot,
    rootInfo: rootInfo,
    forget: forget,
    fileOf: fileOf,
    writeText: writeText,
    writeFile: writeFile,
    ensureWritable: ensureWritable,
    kindLabel: label,
    friendlyError: friendlyError,
    kindOf: kindOf,
    _walk: walk,
    extOf: extOf
  };
})();