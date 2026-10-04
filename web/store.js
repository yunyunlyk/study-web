/* 浏览器本地存储层：公网静态版和非管理员上传都用它。
   所有文件只留在使用者自己的浏览器里（IndexedDB），不会上传到任何服务器。 */
(function () {
  'use strict';

  var DB_NAME = 'study_local';
  var DB_VERSION = 1;
  var ID_BASE = 900000000;
  var LOCAL_USER = { id: 1, username: '本机用户', is_admin: false, local: true };

  // ---------------- IndexedDB 基础 ----------------
  var dbPromise = null;

  function openDb() {
    if (dbPromise) { return dbPromise; }
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('这个浏览器不支持本地存储')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('docs')) { db.createObjectStore('docs', { keyPath: 'id' }); }
        if (!db.objectStoreNames.contains('files')) { db.createObjectStore('files'); }
        if (!db.objectStoreNames.contains('texts')) { db.createObjectStore('texts', { keyPath: 'key' }); }
        if (!db.objectStoreNames.contains('settings')) { db.createObjectStore('settings'); }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开本地数据库')); };
      req.onblocked = function () { reject(new Error('本地数据库被其它标签页占用，请关掉多余的标签页')); };
    });
    return dbPromise;
  }

  function reqp(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('本地数据库出错')); };
    });
  }

  function run(storeNames, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeNames, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error || new Error('本地数据库出错')); };
        t.onabort = function () { reject(t.error || new Error('本地数据库被中断')); };
        try { out = fn(t); } catch (err) { try { t.abort(); } catch (e) {} reject(err); }
      });
    });
  }

  function getAll(storeName) {
    return run(storeName, 'readonly', function (t) { return reqp(t.objectStore(storeName).getAll()); });
  }

  function getOne(storeName, key) {
    return run(storeName, 'readonly', function (t) { return reqp(t.objectStore(storeName).get(key)); });
  }

  function putOne(storeName, value, key) {
    return run(storeName, 'readwrite', function (t) {
      if (key === undefined) { t.objectStore(storeName).put(value); }
      else { t.objectStore(storeName).put(value, key); }
    });
  }

  function deleteOne(storeName, key) {
    return run(storeName, 'readwrite', function (t) { t.objectStore(storeName).delete(key); });
  }

  // ---------------- 本地设置（AI 接入等） ----------------
  function settingsGet(key, fallback) {
    return getOne('settings', key).then(function (v) { return v === undefined ? fallback : v; });
  }
  function settingsSet(key, value) { return putOne('settings', value, key); }

  // ---------------- 小工具 ----------------
  var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'avif'];
  var VIDEO_EXTS = ['mp4', 'mpg', 'mpeg', 'rm', 'rmvb', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'm4v', '3gp', 'ts', 'swf'];
  var AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'wma'];
  var WORD_EXTS = ['doc', 'docx', 'rtf'];
  var PPT_EXTS = ['ppt', 'pptx'];
  var EXCEL_EXTS = ['xls', 'xlsx', 'csv'];
  var TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'log'];
  var ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz', 'iso'];
  var WEB_EXTS = ['html', 'htm', 'mhtml', 'webarchive'];
  var CODE_EXTS = ['py', 'js', 'c', 'cpp', 'java', 'cs', 'css'];

  var KIND_LABELS = {
    pdf: 'PDF', word: '文档', ppt: '演示文稿', excel: '表格', image: '图片', video: '视频',
    audio: '音频', text: '文本', web: '网页', archive: '压缩包', other: '其他'
  };

  function inList(list, v) { return list.indexOf(v) >= 0; }

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function kindOf(ext) {
    if (ext === 'pdf') { return 'pdf'; }
    if (inList(WORD_EXTS, ext)) { return 'word'; }
    if (inList(PPT_EXTS, ext)) { return 'ppt'; }
    if (inList(EXCEL_EXTS, ext)) { return 'excel'; }
    if (inList(IMAGE_EXTS, ext)) { return 'image'; }
    if (inList(VIDEO_EXTS, ext)) { return 'video'; }
    if (inList(AUDIO_EXTS, ext)) { return 'audio'; }
    if (inList(WEB_EXTS, ext)) { return 'web'; }
    if (inList(TEXT_EXTS, ext) || inList(CODE_EXTS, ext)) { return 'text'; }
    if (inList(ARCHIVE_EXTS, ext)) { return 'archive'; }
    return 'other';
  }

  function humanSize(num) {
    var value = Number(num || 0);
    var units = ['B', 'KB', 'MB', 'GB'];
    for (var i = 0; i < units.length; i++) {
      if (value < 1024 || i === units.length - 1) {
        if (i === 0) { return Math.round(value) + ' B'; }
        return value.toFixed(1) + ' ' + units[i];
      }
      value = value / 1024;
    }
    return Math.round(num) + ' B';
  }

  function nowIso() { return new Date().toISOString().slice(0, 19); }

  function uniqueName(taken, name) {
    if (!taken[name.toLowerCase()]) { return name; }
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var tail = dot > 0 ? name.slice(dot) : '';
    var n = 2;
    while (taken[(stem + ' (' + n + ')' + tail).toLowerCase()]) { n++; }
    return stem + ' (' + n + ')' + tail;
  }

  // ---------------- 浏览器内文字提取 ----------------
  function b64ToText(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }

  function xmlToText(xml) {
    var s = String(xml || '')
      .replace(/<\/w:p>/g, '\n').replace(/<\/a:p>/g, '\n')
      .replace(/<w:br[^>]*>/g, '\n').replace(/<a:br[^>]*>/g, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function unzipEntries(buf) {
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var eocd = -1;
    var lowest = Math.max(0, u8.length - 65558);
    for (var i = u8.length - 22; i >= lowest; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('这个文件不是有效的 Office/zip 格式'); }
    var count = view.getUint16(eocd + 10, true);
    var p = view.getUint32(eocd + 16, true);
    var entries = [];
    for (var n = 0; n < count; n++) {
      if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) { break; }
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      entries.push({
        name: new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen)),
        method: view.getUint16(p + 10, true),
        compSize: view.getUint32(p + 20, true),
        localOff: view.getUint32(p + 42, true)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function readZipText(buf, entry) {
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var off = entry.localOff;
    if (off + 30 > u8.length || view.getUint32(off, true) !== 0x04034b50) {
      throw new Error('压缩包里有一条记录损坏');
    }
    var start = off + 30 + view.getUint16(off + 26, true) + view.getUint16(off + 28, true);
    var data = u8.subarray(start, start + entry.compSize);
    if (entry.method === 0) { return Promise.resolve(new TextDecoder('utf-8').decode(data)); }
    if (entry.method !== 8) { return Promise.resolve(''); }
    if (typeof DecompressionStream !== 'function') { return Promise.resolve(''); }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) {
      return new TextDecoder('utf-8').decode(ab);
    });
  }

  function pickEntries(entries, test) {
    return entries.filter(function (e) { return test(e.name); })
      .sort(function (a, b) {
        var na = parseInt((a.name.match(/(\d+)\.xml$/) || [0, '0'])[1], 10);
        var nb = parseInt((b.name.match(/(\d+)\.xml$/) || [0, '0'])[1], 10);
        return na - nb;
      });
  }

  function officeText(file, kind) {
    return file.arrayBuffer().then(function (buf) {
      var entries = unzipEntries(buf);
      var wanted;
      if (kind === 'word') {
        wanted = pickEntries(entries, function (n) { return n === 'word/document.xml'; });
      } else if (kind === 'ppt') {
        wanted = pickEntries(entries, function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); });
      } else {
        wanted = pickEntries(entries, function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); });
      }
      if (!wanted.length) { return []; }
      var shared = '';
      var sharedEntry = entries.filter(function (e) { return e.name === 'xl/sharedStrings.xml'; })[0];
      var head = sharedEntry ? readZipText(buf, sharedEntry).then(function (t) { shared = t; }) : Promise.resolve();
      return head.then(function () {
        var pages = [];
        var chain = Promise.resolve();
        wanted.forEach(function (entry, idx) {
          chain = chain.then(function () {
            return readZipText(buf, entry).then(function (xml) {
              var text = xmlToText(xml);
              if (kind === 'excel' && shared) { text = excelSheetText(xml, shared); }
              pages.push({ page: idx + 1, origin: 'extract', content: text });
            });
          });
        });
        return chain.then(function () { return pages; });
      });
    });
  }

  var pdfReady = null;

  function ensurePdfJs() {
    if (window.pdfjsLib) { return Promise.resolve(window.pdfjsLib); }
    if (pdfReady) { return pdfReady; }
    var lib = window.STUDY_PDFJS_BASE64 || '';
    var worker = window.STUDY_PDFJS_WORKER_BASE64 || '';
    if (!lib) { return Promise.reject(new Error('这个版本没有内置 PDF 阅读组件')); }
    pdfReady = new Promise(function (resolve, reject) {
      try {
        var s = document.createElement('script');
        s.text = b64ToText(lib);
        document.head.appendChild(s);
        if (worker) {
          var url = URL.createObjectURL(new Blob([b64ToText(worker)], { type: 'text/javascript' }));
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = url;
        }
        if (window.pdfjsLib) { resolve(window.pdfjsLib); }
        else { reject(new Error('PDF 组件没有加载成功')); }
      } catch (err) { reject(err); }
    });
    return pdfReady;
  }

  function pdfText(file) {
    return ensurePdfJs().then(function (lib) {
      return file.arrayBuffer().then(function (buf) {
        return lib.getDocument({ data: buf }).promise;
      });
    }).then(function (doc) {
      var total = doc.numPages;
      var limit = Math.min(total, 500);
      var pages = [];
      var chain = Promise.resolve();
      for (var i = 1; i <= limit; i++) {
        (function (n) {
          chain = chain.then(function () {
            return doc.getPage(n).then(function (page) { return page.getTextContent(); })
              .then(function (tc) {
                var txt = (tc.items || []).map(function (it) { return it.str; })
                  .join(' ').replace(/\s+/g, ' ').trim();
                pages.push({ page: n, origin: 'extract', content: txt });
              }).catch(function () { pages.push({ page: n, origin: 'extract', content: '' }); });
          });
        })(i);
      }
      return chain.then(function () {
        try { doc.destroy(); } catch (e) {}
        return { pages: pages, total: total };
      });
    });
  }
  function excelSheetText(sheetXml, sharedXml) {
    var strs = [];
    String(sharedXml || '').replace(/<si>([\s\S]*?)<\/si>/g, function (m, inner) {
      var parts = [];
      String(inner).replace(/<t[^>]*>([\s\S]*?)<\/t>/g, function (mm, g) { parts.push(decodeEntities(g)); return mm; });
      strs.push(parts.join(''));
      return m;
    });
    var filled = String(sheetXml || '').replace(/<c([^>]*)>([\s\S]*?)<\/c>/g, function (m, attrs, inner) {
      if (/t="s"/.test(attrs)) {
        var v = (inner.match(/<v>(\d+)<\/v>/) || [])[1];
        if (v !== undefined && strs[parseInt(v, 10)] !== undefined) {
          return '<c' + attrs + '>' + strs[parseInt(v, 10)] + '</c>';
        }
      }
      return m;
    });
    return xmlToText(filled);
  }

  function extractFor(file, kind, ext) {
    if (kind === 'excel' && ext === 'csv') {
      return file.text().then(function (t) { return [{ page: 1, origin: 'extract', content: String(t).trim() }]; });
    }
    if (kind === 'word' || kind === 'ppt' || kind === 'excel') {
      return officeText(file, kind);
    }
    if (kind === 'pdf') { return pdfText(file).then(function (r) { return r.pages; }); }
    if (kind === 'text' || kind === 'web') {
      return file.text().then(function (t) {
        return [{ page: 1, origin: 'extract', content: String(t).slice(0, 400000) }];
      });
    }
    return Promise.resolve([]);
  }

  // ---------------- 本地资料库 API ----------------
  function listDocs() {
    return getAll('docs').then(function (rows) {
      return (rows || []).sort(function (a, b) { return b.id - a.id; });
    });
  }

  function addFile(file, subject) {
    var name = file.name || '未命名';
    var ext = extOf(name);
    var kind = kindOf(ext);
    return listDocs().then(function (docs) {
      var taken = {};
      var maxId = 0;
      docs.forEach(function (d) {
        taken[String(d.name).toLowerCase()] = true;
        if (d.id > maxId) { maxId = d.id; }
      });
      var id = Math.max(ID_BASE, maxId + 1);
      var doc = {
        id: id, name: uniqueName(taken, name), subject: subject || '未分类', group_path: '',
        ext: ext, kind: kind, kind_label: KIND_LABELS[kind] || kind,
        size: file.size, size_label: humanSize(file.size), mtime: file.lastModified || Date.now(),
        pages: 0, source: 'upload', visibility: 'private', shared: false, mine: true,
        text_state: 'pending', vision_state: 'pending', has_text: false, needs_ai: false,
        fav: false, created_at: nowIso(), mime: file.type || '', position: 0,
        note: '', summary: '', quiz: null, attempts: []
      };
      return putOne('files', file, id).then(function () {
        return extractFor(file, kind, ext).then(function (pages) {
          var chain = Promise.resolve();
          pages.forEach(function (p) {
            chain = chain.then(function () {
              return putOne('texts', {
                key: id + ':' + p.page, material_id: id, page: p.page,
                origin: p.origin || 'extract', content: p.content || ''
              });
            });
          });
          return chain.then(function () {
            doc.pages = pages.length;
            doc.has_text = pages.some(function (p) { return String(p.content || '').trim().length > 0; });
            doc.needs_ai = !doc.has_text;
            doc.text_state = doc.has_text ? 'done' : 'skipped';
            doc.vision_state = doc.has_text ? 'done' : 'pending';
            return putOne('docs', doc).then(function () { return doc; });
          });
        }).catch(function (err) {
          doc.text_state = 'failed';
          doc.needs_ai = true;
          doc.text_note = String((err && err.message) || err);
          return putOne('docs', doc).then(function () { return doc; });
        });
      });
    });
  }

  function docTexts(id) {
    return getAll('texts').then(function (rows) {
      return (rows || []).filter(function (t) { return t.material_id === id; })
        .sort(function (a, b) { return a.page - b.page; });
    });
  }

  // 和服务端 app.py 的检索保持一致的三级兜底：整句查不到 -> 去掉疑问词再查 -> 切成两字词查。
  var QUESTION_WORDS = ['有什么区别', '有什么不同', '有什么', '是什么样', '是什么', '什么是',
    '为什么', '怎么样', '怎么', '怎样', '如何', '哪些', '哪个', '多少', '请问', '介绍一下',
    '解释一下', '解释', '说明', '讲讲', '关于', '请', '一下', '吗', '呢', '吧'];
  var STOP_WORDS = ['一下', '一些', '什么', '这个', '那个', '这些', '那些', '我们', '你们',
    '可以', '应该', '就是', '还是', '但是', '怎么', '怎样', '如何', '哪些', '多少', '请问',
    '介绍', '解释', '说明', '关于'];

  function queryNeedles(q) {
    var s = String(q || '');
    var i;
    for (i = 0; i < QUESTION_WORDS.length; i++) { s = s.split(QUESTION_WORDS[i]).join(' '); }
    s = s.replace(/[\s,，。！？、；：""''（）()【】《》<>~!@#$%^&*_+=|\\/.:;\-]+/g, ' ');
    var parts = s.split(' ').filter(function (p) {
      return p.length >= 2 && STOP_WORDS.indexOf(p) < 0;
    });
    parts.sort(function (a2, b2) { return b2.length - a2.length; });
    return parts.slice(0, 2).map(function (p) { return p.toLowerCase(); });
  }

  function queryGramNeedles(q) {
    var terms = queryNeedles(q);
    if (!terms.length) { return []; }
    var longest = terms[0];
    var out = [];
    for (var i = 0; i < longest.length - 1; i++) {
      var g = longest.slice(i, i + 2);
      if (out.indexOf(g) < 0) { out.push(g); }
    }
    return out.slice(0, 8);
  }

  function collectLocalHits(docs, texts, needles, withText) {
    if (!needles.length) { return []; }
    var byId = {};
    docs.forEach(function (d) { byId[d.id] = d; });
    var groups = {};
    texts.forEach(function (t) {
      var content = String(t.content || '');
      var lower = content.toLowerCase();
      var idx = -1;
      var len = 0;
      var score = 0;
      needles.forEach(function (n) {
        var at = lower.indexOf(n);
        if (at < 0) { return; }
        score++;
        if (idx < 0 || at < idx) { idx = at; len = n.length; }
      });
      if (idx < 0 || !byId[t.material_id]) { return; }
      var g = groups[t.material_id];
      if (!g) {
        g = groups[t.material_id] = { doc: byId[t.material_id], count: 0, score: 0, page: t.page, snippet: '', text: '' };
      }
      g.count++;
      g.score += score;
      if (withText) { g.text = (g.text + content + "\n").slice(0, 1500); }
      if (!g.snippet) {
        var start = Math.max(0, idx - 40);
        var end = Math.min(content.length, idx + len + 90);
        g.snippet = (start > 0 ? '… ' : '') + content.slice(start, idx)
          + '[[' + content.slice(idx, idx + len) + ']]'
          + content.slice(idx + len, end) + (end < content.length ? ' …' : '');
      }
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  // 本地资料的 id 是数字，文件夹来的 id 是 "f:相对路径"，排序要兼容两种。
  function idCompare(a, b) {
    var x = a.doc.id;
    var y = b.doc.id;
    if (typeof x === 'number' && typeof y === 'number') { return x - y; }
    return String(x).localeCompare(String(y));
  }

  function toHitList(groups, limit, withText) {
    groups.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return idCompare(a, b);
    });
    return groups.slice(0, limit || 60).map(function (g) {
      var hit = {
        material_id: g.doc.id, name: g.doc.name, subject: g.doc.subject,
        kind: g.doc.kind, page: g.page, snippet: g.snippet, matches: g.count
      };
      if (withText) { hit.text = g.text || ''; }
      return hit;
    });
  }

  // 文件夹模式（用户自己授权、只在他浏览器里读的目录）抽出来的文字也一起搜。
  function folderSources() {
    try {
      if (window.StudyFolder && window.StudyFolder.searchSources) {
        return Promise.resolve(window.StudyFolder.searchSources()).catch(function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  // 三级兜底：整句查不到 -> 去掉疑问词再查 -> 切成两字词查。文件夹那边也复用这一套。
  function matchHits(docs, texts, q, limit, opts) {
    var withText = !!(opts && opts.withText);
    var needle = String(q || '').trim().toLowerCase();
    if (!needle) { return []; }
    var groups = collectLocalHits(docs, texts, [needle], withText);
    if (!groups.length) { groups = collectLocalHits(docs, texts, queryNeedles(q), withText); }
    if (!groups.length) { groups = collectLocalHits(docs, texts, queryGramNeedles(q), withText); }
    return toHitList(groups, limit, withText);
  }

  function searchLocal(q, limit) {
    if (!String(q || '').trim()) { return Promise.resolve([]); }
    return Promise.all([getAll('docs'), getAll('texts'), folderSources()]).then(function (res) {
      var folder = res[2] || {};
      var docs = (res[0] || []).concat(folder.docs || []);
      var texts = (res[1] || []).concat(folder.texts || []);
      return matchHits(docs, texts, q, limit);
    });
  }

  // 给 AI 问答当上下文：本人浏览器里的上传资料 + 文件夹资料的命中正文。
  function localContexts(q, limit) {
    if (!String(q || '').trim()) { return Promise.resolve([]); }
    return Promise.all([getAll('docs'), getAll('texts'), folderSources()]).then(function (res) {
      var folder = res[2] || {};
      var docs = (res[0] || []).concat(folder.docs || []);
      var texts = (res[1] || []).concat(folder.texts || []);
      return matchHits(docs, texts, q, limit || 6, { withText: true }).map(function (h) {
        return { material_id: h.material_id, title: h.name, subject: h.subject,
                 text: String(h.text || "").trim() };
      }).filter(function (c) { return c.text.length > 0; });
    }).catch(function () { return []; });
  }

  function patchDoc(id, patch) {
    return getOne('docs', id).then(function (doc) {
      if (!doc) { throw new Error('资料不存在'); }
      Object.keys(patch).forEach(function (k) { doc[k] = patch[k]; });
      return putOne('docs', doc).then(function () { return doc; });
    });
  }

  function removeDoc(id) {
    return docTexts(id).then(function (rows) {
      var chain = Promise.resolve();
      rows.forEach(function (r) { chain = chain.then(function () { return deleteOne('texts', r.key); }); });
      return chain.then(function () { return deleteOne('files', id); })
        .then(function () { return deleteOne('docs', id); });
    });
  }

  var blobCache = {};

  function fileBlob(id) {
    return getOne('files', id);
  }

  function objectUrl(id) {
    if (blobCache[id]) { return Promise.resolve(blobCache[id]); }
    return getOne('files', id).then(function (blob) {
      if (!blob) { return ''; }
      var url = URL.createObjectURL(blob);
      blobCache[id] = url;
      return url;
    });
  }

  function usage() {
    return Promise.all([getAll('docs'), getAll('files')]).then(function (res) {
      var docs = res[0] || [];
      var bytes = 0;
      docs.forEach(function (d) { bytes += Number(d.size || 0); });
      var quota = null;
      if (navigator.storage && navigator.storage.estimate) {
        quota = navigator.storage.estimate().then(function (e) { return e; }).catch(function () { return null; });
      }
      return Promise.resolve(quota).then(function (e) {
        return {
          count: docs.length, bytes: bytes, bytes_label: humanSize(bytes),
          quota: e && e.quota ? e.quota : 0, quota_label: e && e.quota ? humanSize(e.quota) : ''
        };
      });
    });
  }
  // ---------------- 分享码门禁 ----------------
  var GATE = window.STUDY_GATE || null;

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return bytes;
  }

  function bytesToHex(buf) {
    var bytes = new Uint8Array(buf);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) { hex += ('0' + bytes[i].toString(16)).slice(-2); }
    return hex;
  }

  function gateRequired() { return !!(GATE && GATE.hash && GATE.salt); }

  function gateUnlocked() {
    if (!gateRequired()) { return true; }
    try { return localStorage.getItem('study_gate_ok') === GATE.hash; } catch (e) { return false; }
  }

  function gateSubmit(code) {
    if (!gateRequired()) { return Promise.resolve(true); }
    var text = String(code || '').trim();
    if (!text) { return Promise.resolve(false); }
    if (!(window.crypto && crypto.subtle)) {
      return Promise.reject(new Error('这个浏览器不支持校验分享码（需要 https 或本地文件打开）'));
    }
    return crypto.subtle.importKey('raw', new TextEncoder().encode(text), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits({
          name: 'PBKDF2', salt: b64ToBytes(GATE.salt), iterations: GATE.iter || 150000, hash: 'SHA-256'
        }, key, 256);
      })
      .then(function (bits) {
        if (bytesToHex(bits) === GATE.hash) {
          try { localStorage.setItem('study_gate_ok', GATE.hash); } catch (e) {}
          return true;
        }
        return false;
      });
  }

  function gateReset() { try { localStorage.removeItem('study_gate_ok'); } catch (e) {} }

  // ---------------- AI（用使用者自己的密钥） ----------------
  function aiConf() {
    return settingsGet('ai', null).then(function (v) {
      return v || { base_url: '', api_key: '', model_text: '', model_vision: '' };
    });
  }

  function aiChat(messages, model, maxTokens, timeoutMs) {
    return aiConf().then(function (conf) {
      if (!conf.base_url) {
        throw new Error('还没有配置 AI 接口。到「我的 → AI 接入」填上你自己的密钥就能用（密钥只存在你自己的浏览器里）。');
      }
      var url = String(conf.base_url).replace(/\/+$/, '') + '/chat/completions';
      var opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || conf.model_text, messages: messages,
          max_tokens: maxTokens || 4000, stream: false
        })
      };
      if (conf.api_key) { opts.headers['Authorization'] = 'Bearer ' + conf.api_key; }
      var timer = null;
      if (typeof AbortController === 'function') {
        var controller = new AbortController();
        opts.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, timeoutMs || 150000);
      }
      return fetch(url, opts).then(function (res) {
        if (timer) { clearTimeout(timer); }
        return res.text().then(function (raw) {
          var data = {};
          try { data = JSON.parse(raw); } catch (e) {}
          if (!res.ok) {
            var detail = (data.error && (data.error.message || data.error.code)) || ('接口返回 ' + res.status);
            throw new Error('AI 接口出错：' + detail);
          }
          var choice = (data.choices || [])[0] || {};
          var node = choice.message || {};
          return {
            content: node.content || '',
            reasoning: node.reasoning_content || node.reasoning || '',
            model: data.model || model
          };
        });
      }).catch(function (err) {
        if (timer) { clearTimeout(timer); }
        if (err && err.name === 'AbortError') { throw new Error('AI 接口超时了，稍后再试或换个说法。'); }
        if (err && err.name === 'TypeError') {
          throw new Error('连不上 AI 接口：可能是地址填错了，或这个服务不允许网页直接调用（浏览器跨域限制）。可以换一个支持网页调用的服务。');
        }
        throw err;
      });
    });
  }

  var SUMMARY_PROMPT = '你在帮一位学习者整理资料。下面是一份资料里提取出来的内容。'
    + '请严格依据资料内容，输出 Markdown 格式的学习笔记，包含四个小节：\n'
    + '## 一句话概括\n## 核心知识点\n## 易错点\n## 复习建议\n'
    + '要求：不要编造资料里没有的内容；知识点分条列出；语言简洁，便于快速阅读。';

  var QUIZ_PROMPT = '根据下面的资料出 6 道练习题，用来检验是否真正掌握。\n\n'
    + '只输出一个 JSON 对象，格式为：\n'
    + '{"questions":[{"type":"choice","stem":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"A","explain":"解析"}]}\n'
    + '说明：\n- 选择题的 type 用 choice，必须给 4 个选项，answer 为 A/B/C/D 之一；\n'
    + '- 填空题的 type 用 blank，options 写空数组 []，answer 是答案文本；\n'
    + '- 不要输出任何解释性文字，不要用代码块包裹；全部使用中文。';

  var ASK_PROMPT = '你是一名学习助手。请依据下面提供的资料片段回答问题，用中文回答。\n\n'
    + '规则：\n1. 优先使用资料片段里的信息，不要编造资料中没有的事实；\n'
    + '2. 如果资料不足，明确说明，并给出通用的学习建议；\n'
    + '3. 用 Markdown 分点作答，篇幅适中；\n'
    + '4. 引用资料时在句子末尾标注来源编号，例如 [1]。';

  var ASK_PROMPT_DEEP = '你是一名学习助手，要一步步把问题讲透。请依据下面提供的资料片段回答，用中文。\n\n'
    + '要求：\n1. 先把推理做完再下结论：判断已知条件、选出公式、逐步推导，中间结果写出来；\n'
    + '2. 正文按“思路 → 步骤 → 结论”组织，关键公式和代入的数都要写清楚；\n'
    + '3. 优先使用资料片段里的信息，不要编造资料中没有的事实；\n'
    + '4. 资料不足时明确说明哪里不足，并给出通用的解题思路；\n'
    + '5. 用 Markdown，引用资料时在句末标注来源编号，例如 [1]。';

  var ANIMATION_SYSTEM = '你是代码生成器。只输出代码本身，不要输出任何思考过程、解释、开场白或 Markdown 代码块。';

  var ANIMATION_PROMPT = '请围绕一个学习主题，写一个紧凑的单文件 HTML（控制在 120 行以内），用 <canvas> 做动画演示。\n\n'
    + '硬性要求：\n1. 从 <!DOCTYPE html> 开始，到 </html> 结束，中间不要有任何解释文字；\n'
    + '2. 所有 CSS 和 JavaScript 都写在文件内部；绝对不能引用 http/https 的外部地址、CDN、外部图片或字体；\n'
    + '3. 必须有 requestAnimationFrame 动画循环，让它真的动起来；\n'
    + '4. 画面上要有中文标注和一条关键公式，便于讲解；\n'
    + '5. 要有“暂停/继续”按钮，以及至少一个可以拖动的参数滑块（input type=range）；\n'
    + '6. 深色背景、浅色文字，字号看得清，页面自适应窗口大小。';

  function trimText(text, limit) {
    var s = String(text || '');
    return s.length > limit ? s.slice(0, limit) : s;
  }

  function parseJsonLoose(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) { text = text.slice(start, end + 1); }
    return JSON.parse(text);
  }

  function collectText(id, limit) {
    return docTexts(id).then(function (rows) {
      var parts = [];
      var total = 0;
      for (var i = 0; i < rows.length; i++) {
        var c = String(rows[i].content || '').trim();
        if (!c) { continue; }
        parts.push(c);
        total += c.length;
        if (total >= (limit || 14000)) { break; }
      }
      return parts.join('\n').slice(0, limit || 14000);
    });
  }
  function localStatus() {
    return listDocs().then(function (docs) {
      return {
        phase: 'idle', running: false, total: docs.length,
        indexed: docs.filter(function (d) { return d.has_text; }).length,
        text_pending: 0, vision_pending: 0, failed: 0, current: null, last_error: ''
      };
    });
  }

  function normAnswer(value) {
    return String(value == null ? '' : value).trim().toLowerCase()
      .replace(/[ \t\n。，、；：（）()【】\[\]]/g, '');
  }

  function extractAgain(id) {
    return getOne('docs', id).then(function (doc) {
      if (!doc) { throw new Error('资料不存在'); }
      return getOne('files', id).then(function (blob) {
        if (!blob) { throw new Error('这个文件不在本地了，请重新上传'); }
        return extractFor(blob, doc.kind, doc.ext).then(function (pages) {
          return docTexts(id).then(function (old) {
            var chain = Promise.resolve();
            old.forEach(function (r) { chain = chain.then(function () { return deleteOne('texts', r.key); }); });
            pages.forEach(function (p) {
              chain = chain.then(function () {
                return putOne('texts', {
                  key: id + ':' + p.page, material_id: id, page: p.page,
                  origin: p.origin || 'extract', content: p.content || ''
                });
              });
            });
            return chain.then(function () {
              var has = pages.some(function (p) { return String(p.content || '').trim().length > 0; });
              return patchDoc(id, {
                pages: pages.length, has_text: has, needs_ai: !has,
                text_state: has ? 'done' : 'skipped', text_note: ''
              });
            });
          });
        });
      });
    });
  }

  function setTexts(id, pages) {
    return docTexts(id).then(function (old) {
      var chain = Promise.resolve();
      old.forEach(function (r) { chain = chain.then(function () { return deleteOne('texts', r.key); }); });
      pages.forEach(function (p) {
        chain = chain.then(function () {
          return putOne('texts', {
            key: id + ':' + p.page, material_id: id, page: p.page,
            origin: p.origin || 'vision', content: p.content || ''
          });
        });
      });
      return chain.then(function () {
        var has = pages.some(function (p) { return String(p.content || '').trim().length > 0; });
        return patchDoc(id, {
          pages: pages.length, has_text: has, needs_ai: !has,
          text_state: has ? 'done' : 'skipped', vision_state: has ? 'done' : 'pending'
        });
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('读不出这个文件')); };
      reader.readAsDataURL(blob);
    });
  }

  var VISION_PROMPT = '把这张图片里的文字全部识别出来，数学公式用 LaTeX 写在 $ $ 之间，'
    + '表格用 Markdown 表格还原。只输出识别结果，不要任何解释。';

  // 传一个 Blob/File 进去就能让视觉模型认字。文件夹模式的图片也走这条。
  function visionTextOf(blob) {
    return blobToDataUrl(blob).then(function (dataUrl) {
      return aiConf().then(function (conf) {
        if (!conf.base_url) {
          throw new Error('还没有配置 AI 接口。到「我的 → AI 接入」填上你自己的密钥就能用（密钥只存在你自己的浏览器里）。');
        }
        var url = String(conf.base_url).replace(/\/+$/, '') + '/chat/completions';
        var opts = {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: conf.model_vision || conf.model_text, max_tokens: 4000, stream: false,
            messages: [{ role: 'user', content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } }
            ] }]
          })
        };
        if (conf.api_key) { opts.headers['Authorization'] = 'Bearer ' + conf.api_key; }
        return fetch(url, opts).then(function (res) {
          return res.text().then(function (raw) {
            var data = {};
            try { data = JSON.parse(raw); } catch (e) {}
            if (!res.ok) {
              throw new Error('AI 接口出错：' + ((data.error && data.error.message) || res.status));
            }
            return String(((((data.choices || [])[0] || {}).message) || {}).content || '').trim();
          });
        });
      });
    });
  }

  function visionRead(id) {
    return Promise.all([getOne('docs', id), getOne('files', id)]).then(function (res) {
      if (!res[0]) { throw new Error('资料不存在'); }
      if (!res[1]) { throw new Error('这个文件不在本地了，请重新上传'); }
      return visionTextOf(res[1]);
    }).then(function (text) {
      if (!text) { throw new Error('AI 没有认出文字，换一张更清楚的图试试。'); }
      return setTexts(id, [{ page: 1, origin: 'vision', content: text }])
        .then(function () { return { chars: text.length }; });
    });
  }

  // ---------------- 公网版：连接你自己的服务器（只借抓取，内容存本地）----------------
  // 单文件版在浏览器里受跨域限制，抓不到别的网站正文。这里把“搜索 + 抓正文”转发给
  // 站长那台服务器（用连接码鉴权），抓到的东西仍存进访客自己的浏览器，不占站长硬盘。
  function bridgeConf() {
    return settingsGet('bridge', null).then(function (v) {
      return v || { url: '', key: '' };
    });
  }

  function bridgeSave(url, key) {
    return settingsSet('bridge', {
      url: String(url || '').trim().replace(/\/+$/, ''),
      key: String(key || '').trim().toUpperCase()
    });
  }

  function bridgeNetError(err) {
    var name = (err && err.name) || '';
    if (name === 'TypeError' || name === 'AbortError') {
      return '连不上服务器：请确认服务器开着、服务正在运行，而且这个页面和服务器在同一个局域网（或者已经做了内网穿透）。';
    }
    return String((err && err.message) || err);
  }

  function qsOf(params) {
    var pairs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null) {
        pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    });
    return pairs.length ? '?' + pairs.join('&') : '';
  }

  function bridgeCall(path, params) {
    return bridgeConf().then(function (conf) {
      if (!conf.url) {
        throw new Error('还没有连接服务器。请先在「连接服务器」里填上服务器地址和连接码。');
      }
      var opts = { method: 'GET', headers: {} };
      if (conf.key) { opts.headers['X-Study-Key'] = conf.key; }
      return fetch(conf.url + path + qsOf(params), opts).catch(function (err) {
        throw new Error(bridgeNetError(err));
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = {};
          try { data = JSON.parse(text); } catch (e) {}
          if (!res.ok) {
            throw new Error((data && data.error) || ('服务器返回 ' + res.status));
          }
          return data || {};
        });
      });
    });
  }

  function nowLabel() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function safeName(name) {
    var out = String(name || '资料').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    return out.slice(0, 50) || '资料';
  }

  function collectedMarkdown(title, url, text, summary) {
    var head = '# ' + title + '\n\n';
    if (summary) { head += '## AI 笔记\n' + summary + '\n\n'; }
    head += '> 来源：' + url + '\n> 收集时间：' + nowLabel() + '\n\n';
    return head + text;
  }

  function saveCollected(fileName, markdown, subject) {
    var name = String(fileName || '收集的资料').trim() || '收集的资料';
    if (!/\.(md|markdown|txt)$/i.test(name)) { name += '.md'; }
    var blob = new File([markdown], name, { type: 'text/markdown' });
    return addFile(blob, subject || '网络收集');
  }

  function maybeSummarize(text, title, want) {
    if (!want) { return Promise.resolve(''); }
    return aiConf().then(function (conf) {
      if (!conf.base_url) { return ''; }
      return aiChat([{ role: 'user', content: SUMMARY_PROMPT + '\n\n资料标题：' + title
        + '\n\n资料内容：\n' + String(text || '').slice(0, 14000) }], null, 6000, 180000)
        .then(function (r) { return String(r.content || '').trim(); })
        .catch(function () { return ''; });
    });
  }

  function maybeQuiz(id, text, want) {
    if (!want) { return Promise.resolve(false); }
    return aiConf().then(function (conf) {
      if (!conf.base_url) { return false; }
      return aiChat([{ role: 'user', content: QUIZ_PROMPT + '\n\n资料内容：\n'
        + String(text || '').slice(0, 14000) }], null, 5000, 180000).then(function (r) {
        var questions = parseJsonLoose(r.content).questions || [];
        if (!questions.length) { return false; }
        return patchDoc(id, { quiz: questions }).then(function () { return true; });
      }).catch(function () { return false; });
    });
  }

  // ---------------- 公网版收集：三个通道依次降级 ----------------
  // 单文件版在浏览器里受跨域限制，抓不到别的网站正文。按稳定性依次尝试：
  //   1) 站长那台服务器（可选，他的电脑开着才可用）
  //   2) 第三方免费抓取代理（免费但经常挂，所以多个依次试）
  //   3) 访客自己密钥的 AI 联网搜索（智谱、阿里云百炼支持；DeepSeek 不支持）
  var REMOTE_PROXIES = [
    { name: 'cors.lol', base: 'https://api.cors.lol/?url=' },
    { name: 'allorigins', base: 'https://api.allorigins.win/raw?url=' },
    { name: 'codetabs', base: 'https://api.codetabs.com/v1/proxy?quest=' }
  ];
  var PROXY_TIMEOUT = 12000;

  function errText(e) { return String((e && e.message) || e || ''); }

  function sourceListMarkdown(sources) {
    return (sources || []).map(function (s) {
      var tail = [];
      if (s.media) { tail.push(s.media); }
      if (s.date) { tail.push(s.date); }
      return '- [' + (s.title || s.url) + '](' + s.url + ')'
        + (tail.length ? '　（' + tail.join(' · ') + '）' : '');
    }).join('\n');
  }

  function fetchTimeout(url, opts, ms) {
    var o = opts || {};
    if (typeof AbortController === 'function') {
      var ctl = new AbortController();
      o.signal = ctl.signal;
      var timer = setTimeout(function () { ctl.abort(); }, ms);
      return fetch(url, o).then(function (res) { clearTimeout(timer); return res; },
                                function (err) { clearTimeout(timer); throw err; });
    }
    return fetch(url, o);
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, function (all, n) { return String.fromCharCode(parseInt(n, 10)); });
  }

  function htmlTitle(html) {
    var m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  }

  function htmlToText(html) {
    var s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    return s.replace(/^\s+|\s+$/g, '');
  }

  function aiRequest(payload, timeoutMs) {
    return aiConf().then(function (conf) {
      if (!conf.base_url) {
        throw new Error('还没有配置 AI 接口。到「我的 → AI 接入」填上你自己的密钥就能用（密钥只存在你自己的浏览器里）。');
      }
      var url = String(conf.base_url).replace(/\/+$/, '') + '/chat/completions';
      var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify(payload) };
      if (conf.api_key) { opts.headers['Authorization'] = 'Bearer ' + conf.api_key; }
      return fetchTimeout(url, opts, timeoutMs || 150000).then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          try { data = JSON.parse(raw); } catch (e) {}
          return { ok: res.ok, status: res.status, data: data };
        });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') { throw new Error('AI 接口超时了，稍后再试。'); }
        if (err && err.name === 'TypeError') {
          throw new Error('连不上 AI 接口：可能是地址填错了，或这个服务不允许网页直接调用（浏览器跨域限制）。');
        }
        throw err;
      });
    });
  }

  var WEB_SEARCH_PROMPT = '请联网搜索下面这个主题，整理成一份学习笔记（Markdown），'
    + '包含「核心知识点」「易错点」「典型例题」三个小节，并给出参考来源。'
    + '只写搜索结果里确实有的内容，不要编造。\n\n主题：';
  var WEB_SEARCH_UNSUPPORTED = '这个 AI 服务不支持联网搜索（智谱 ✅、阿里云百炼 ✅、DeepSeek ❌），'
    + '换个支持的密钥再试，或者用「自己粘贴知识点」/「上传文件」。';

  // 第 3 级：访客自己密钥的 AI 联网搜索（实测返回里来源在顶层 web_search 数组）
  function aiWebSearch(query) {
    return aiConf().then(function (conf) {
      if (!conf.base_url || !conf.api_key) {
        throw new Error('联网搜索要用你自己的 AI 密钥。到「我的 → AI 接入」填一个支持联网搜索的（智谱、阿里云百炼）。');
      }
      var payload = {
        model: conf.model_text || 'glm-4-plus',
        messages: [{ role: 'user', content: WEB_SEARCH_PROMPT + query }],
        tools: [{ type: 'web_search', web_search: { enable: true, search_result: true } }],
        max_tokens: 4000, stream: false
      };
      return aiRequest(payload, 180000).then(function (res) {
        if (!res.ok) {
          if (res.status === 400 || res.status === 404 || res.status === 422) { throw new Error(WEB_SEARCH_UNSUPPORTED); }
          var detail = (res.data.error && (res.data.error.message || res.data.error.code)) || ('接口返回 ' + res.status);
          throw new Error('AI 联网搜索失败：' + detail);
        }
        var data = res.data || {};
        var answer = String(((((data.choices || [])[0] || {}).message) || {}).content || '').trim();
        var raw = Array.isArray(data.web_search) ? data.web_search : [];
        var sources = raw.map(function (it) {
          return {
            title: String((it && it.title) || '').trim(),
            url: String((it && it.link) || '').trim(),
            media: String((it && it.media) || '').trim(),
            date: String((it && it.publish_date) || '').trim(),
            snippet: String((it && it.content) || '').trim()
          };
        }).filter(function (x) { return /^https?:\/\//i.test(x.url); });
        if (!answer && !sources.length) { throw new Error('AI 没有返回搜索结果，换个说法再试。'); }
        return { answer: answer, sources: sources, via: 'AI 联网搜索' };
      });
    });
  }

  // 第 2 级：第三方免费代理抓正文
  function proxyPage(target) {
    var i = 0;
    var fails = [];
    function next() {
      if (i >= REMOTE_PROXIES.length) { throw new Error('免费抓取代理都不可用（' + fails.join('；') + '）'); }
      var p = REMOTE_PROXIES[i++];
      return fetchTimeout(p.base + encodeURIComponent(target), {}, PROXY_TIMEOUT).then(function (res) {
        if (!res.ok) { throw new Error(p.name + ' 返回 ' + res.status); }
        return res.text();
      }).then(function (html) {
        var text = htmlToText(html);
        if (text.length < 80) { throw new Error(p.name + ' 没抓到正文'); }
        return { title: htmlTitle(html) || target, url: target, text: text, via: '免费代理 ' + p.name };
      }).catch(function (err) {
        fails.push(p.name + '：' + errText(err));
        return next();
      });
    }
    return Promise.resolve().then(next);
  }

  // 抓一个网页：服务器 → 免费代理 → AI 联网搜索
  function collectPageChain(target) {
    function step1() {
      return bridgeCall('/api/bridge/page', { url: target }).then(function (r) {
        var text = String(r.text || '');
        if (text.length < 80) { throw new Error('服务器没抓到正文'); }
        return { title: r.title || target, url: r.url || target, text: text, via: '你电脑上的服务器' };
      });
    }
    function step3() {
      return aiWebSearch('请阅读并总结这个网页的内容：' + target).then(function (r) {
        if (!r.answer) { throw new Error('AI 没有返回内容'); }
        return { title: target, url: target, text: r.answer, via: 'AI 联网搜索' };
      });
    }
    var fails = [];
    var tried = 0;
    return Promise.resolve().then(function () { tried++; return step1(); })
      .catch(function (e) { fails.push('① 服务器：' + errText(e)); tried++; return proxyPage(target); })
      .catch(function (e) { fails.push('② 免费代理：' + errText(e)); tried++; return step3(); })
      .catch(function (e) {
        fails.push('③ AI 联网搜索：' + errText(e));
        throw new Error('已尝试 ' + tried + ' 个通道都不可用：' + fails.join('；')
          + '。可以改用「自己粘贴知识点」或「上传文件」。');
      });
  }

  // 搜索若干个来源：服务器 → AI 联网搜索
  function collectSearchChain(q, limit) {
    function viaBridge() {
      return bridgeCall('/api/bridge/search', { q: q, limit: limit }).then(function (r) {
        var hits = (r.hits || []).filter(function (h) { return /^https?:/i.test(String(h.url || '')); });
        if (!hits.length) { throw new Error('服务器没有搜到结果'); }
        return { hits: hits, via: '你电脑上的服务器' };
      });
    }
    function viaAi() {
      return aiWebSearch(q).then(function (r) {
        var hits = r.sources.map(function (x) {
          return { title: x.title || x.url, url: x.url, snippet: x.snippet.slice(0, 300),
                   media: x.media, date: x.date };
        });
        if (!hits.length) { throw new Error('AI 没有返回来源链接'); }
        return { hits: hits, via: 'AI 联网搜索' };
      });
    }
    var fails = [];
    return viaBridge().catch(function (e) { fails.push('① 服务器：' + errText(e)); return viaAi(); })
      .catch(function (e) {
        fails.push('② AI 联网搜索：' + errText(e));
        throw new Error('搜不到内容：' + fails.join('；') + '。可以改用「收集一个网页」直接粘贴网址。');
      });
  }

  // 逐个通道体检（给「测试」按钮用）
  function collectChannelReport() {
    var notes = [];
    return bridgeCall('/api/bridge/ping').then(function () {
      notes.push('① 你电脑上的服务器：可用');
    }, function (e) {
      notes.push('① 你电脑上的服务器：不可用（' + errText(e) + '）');
    }).then(function () {
      return proxyPage('https://example.com/').then(function () {
        notes.push('② 免费抓取代理：可用');
      }, function (e) {
        notes.push('② 免费抓取代理：不可用（' + errText(e) + '）');
      });
    }).then(function () {
      return aiConf().then(function (ai) {
        if (ai.base_url && ai.api_key) { notes.push('③ 你自己的 AI 联网搜索：已配置（' + (ai.model_text || '默认模型') + '）'); }
        else { notes.push('③ 你自己的 AI 联网搜索：还没配置密钥'); }
      });
    }).then(function () {
      return { ok: true, message: notes.join('；'), channels: notes };
    });
  }

  function localApi(path, options) {
    var opt = options || {};
    var body = opt.json || {};
    var raw = String(path);
    var query = {};
    var qi = raw.indexOf('?');
    if (qi >= 0) {
      raw.slice(qi + 1).split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv[0]) { query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }
      });
      raw = raw.slice(0, qi);
    }
    var m;

    function ok(data) { var out = data || {}; out.ok = true; return Promise.resolve(out); }
    function fail(message) { return Promise.reject(new Error(message)); }

    if (raw === '/api/me') { return ok({ user: LOCAL_USER }); }
    if (raw === '/api/login' || raw === '/api/register') { return ok({ user: LOCAL_USER }); }
    if (raw === '/api/logout') { return ok({}); }

    if (raw === '/api/overview') {
      return listDocs().then(function (docs) {
        var subs = {}, kinds = {}, bytes = 0, indexed = 0;
        docs.forEach(function (d) {
          if (!subs[d.subject]) { subs[d.subject] = { name: d.subject, count: 0, bytes: 0 }; }
          subs[d.subject].count++;
          subs[d.subject].bytes += Number(d.size || 0);
          kinds[d.kind] = (kinds[d.kind] || 0) + 1;
          bytes += Number(d.size || 0);
          if (d.has_text) { indexed++; }
        });
        return {
          subjects: Object.keys(subs).map(function (k) { return subs[k]; }),
          kind_counts: kinds,
          kind_order: ['pdf', 'word', 'ppt', 'excel', 'image', 'video', 'web', 'text', 'audio', 'archive', 'other'],
          recent: docs.slice(0, 12),
          continue: docs.filter(function (d) { return Number(d.position || 0) > 0; }).slice(0, 6),
          totals: { files: docs.length, bytes: bytes, bytes_label: humanSize(bytes) },
          index: { phase: 'idle', running: false, total: docs.length, indexed: indexed,
                   text_pending: 0, vision_pending: 0, failed: 0, current: null, last_error: '' },
          ai: { base: '', vision_model: '', text_model: '' },
          source: { root: '你自己的浏览器' },
          is_admin: false, local: true
        };
      }).then(ok);
    }

    if (raw === '/api/materials') {
      return listDocs().then(function (docs) {
        var q = String(query.q || '').toLowerCase();
        var items = docs.filter(function (d) {
          if (query.subject && d.subject !== query.subject) { return false; }
          if (query.kind && d.kind !== query.kind) { return false; }
          if (q && String(d.name).toLowerCase().indexOf(q) < 0) { return false; }
          if (query.fav === '1' && !d.fav) { return false; }
          return true;
        });
        var sort = query.sort || 'name';
        items = items.slice();
        if (sort === 'size') { items.sort(function (a, b) { return b.size - a.size; }); }
        else if (sort === 'new') { items.sort(function (a, b) { return b.id - a.id; }); }
        else if (sort === 'old') { items.sort(function (a, b) { return a.id - b.id; }); }
        else { items.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); }); }
        var limit = Math.min(300, Math.max(1, parseInt(query.limit || '200', 10) || 200));
        var offset = Math.max(0, parseInt(query.offset || '0', 10) || 0);
        return { items: items.slice(offset, offset + limit) };
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)$/))) {
      var did = parseInt(m[1], 10);
      return Promise.all([getOne('docs', did), docTexts(did)]).then(function (res) {
        var doc = res[0];
        if (!doc) { return fail('资料不存在，或者不在这个浏览器里'); }
        return {
          item: doc, note: doc.note || '', summary: doc.summary || '',
          quiz: doc.quiz || null, attempts: doc.attempts || [],
          position: doc.position || 0,
          texts: (res[1] || []).slice(0, 40).map(function (t) {
            return { page: t.page, origin: t.origin, content: String(t.content || '').slice(0, 4000) };
          })
        };
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)\/summary$/))) {
      var sid = parseInt(m[1], 10);
      return getOne('docs', sid).then(function (doc) {
        if (!doc) { throw new Error('资料不存在'); }
        return collectText(sid, 14000).then(function (text) {
          if (!text.trim()) {
            throw new Error('这份资料还没有可用的文字内容。图片和扫描件可以点“AI 识别”让模型看图。');
          }
          return aiChat([{ role: 'user', content: SUMMARY_PROMPT + '\n\n资料标题：' + doc.name + '\n\n资料内容：\n' + text }], null, 6000, 180000);
        }).then(function (r) {
          return patchDoc(sid, { summary: r.content }).then(function () { return { summary: r.content }; });
        });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)\/quiz$/))) {
      var qid = parseInt(m[1], 10);
      return collectText(qid, 14000).then(function (text) {
        if (!text.trim()) { throw new Error('这份资料还没有可用的文字内容。'); }
        return aiChat([{ role: 'user', content: QUIZ_PROMPT + '\n\n资料内容：\n' + text }], null, 5000, 180000);
      }).then(function (r) {
        var questions = parseJsonLoose(r.content).questions || [];
        return patchDoc(qid, { quiz: questions }).then(function () { return { quiz: questions }; });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)\/quiz\/submit$/))) {
      var aid = parseInt(m[1], 10);
      return getOne('docs', aid).then(function (doc) {
        if (!doc || !doc.quiz || !doc.quiz.length) { throw new Error('还没有练习题'); }
        var answers = body.answers || [];
        var detail = [];
        var score = 0;
        doc.quiz.forEach(function (item, index) {
          var given = index < answers.length ? answers[index] : '';
          var good = normAnswer(given) !== '' && normAnswer(given) === normAnswer(item.answer);
          if (good) { score++; }
          detail.push({ given: given, answer: item.answer, ok: good });
        });
        var attempts = (doc.attempts || []).slice();
        attempts.unshift({ score: score, total: doc.quiz.length, created_at: nowIso() });
        return patchDoc(aid, { attempts: attempts.slice(0, 5) }).then(function () {
          return { score: score, total: doc.quiz.length, detail: detail };
        });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)\/index$/))) {
      var iid = parseInt(m[1], 10);
      if (body.mode === 'vision') {
        return visionRead(iid).then(function (r) { return { recognized: r.chars }; }).then(ok);
      }
      return extractAgain(iid).then(function () { return { queued: false, local: true }; }).then(ok);
    }

    if ((m = raw.match(/^\/api\/material\/(\d+)\/visibility$/))) {
      return fail('这是单人的本地版本，你的文件只在自己浏览器里，不需要共享设置。');
    }

    if (raw === '/api/search') { return searchLocal(query.q || '', 60).then(function (hits) { return { query: query.q || '', hits: hits }; }).then(ok); }

    if (raw === '/api/ask') {
      var question = String(body.question || '').trim();
      if (!question) { return fail('请输入问题'); }
      var deep = !!body.deep;
      return searchLocal(question, 24).then(function (hits) {
        if (!hits.length) {
          return { answer: '在你自己上传的资料里没有检索到相关内容。可以再上传一些资料，或者换一种说法再问。', sources: [], reasoning: '', deep: deep };
        }
        var order = [];
        var grouped = {};
        hits.forEach(function (h) {
          if (!grouped[h.material_id]) { grouped[h.material_id] = { title: h.name, subject: h.subject, parts: [] }; order.push(h.material_id); }
          grouped[h.material_id].parts.push(String(h.snippet || '').replace(/\[\[|\]\]/g, ''));
        });
        var contexts = order.slice(0, 6).map(function (id) { return grouped[id]; });
        var blocks = contexts.map(function (c, i) {
          return '[' + (i + 1) + '] 来源：' + c.title + '（' + c.subject + '）\n' + trimText(c.parts.join('\n'), 2600);
        }).join('\n\n');
        var sources = contexts.map(function (c, i) {
          return { index: i + 1, material_id: order[i], name: c.title, subject: c.subject };
        });
        var prompt = (deep ? ASK_PROMPT_DEEP : ASK_PROMPT) + '\n\n资料片段：\n' + blocks + '\n\n问题：' + question;
        return aiChat([{ role: 'user', content: prompt }], null, deep ? 8000 : 5000, deep ? 240000 : 150000)
          .then(function (r) {
            return { answer: r.content, reasoning: deep ? r.reasoning : '', model: r.model, deep: deep, sources: sources };
          });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/notes\/(\d+)$/))) {
      return patchDoc(parseInt(m[1], 10), { note: String(body.content || '') }).then(function () { return {}; }).then(ok);
    }

    if ((m = raw.match(/^\/api\/favorite\/(\d+)$/))) {
      var fid = parseInt(m[1], 10);
      return getOne('docs', fid).then(function (doc) {
        if (!doc) { throw new Error('资料不存在'); }
        var next = !doc.fav;
        return patchDoc(fid, { fav: next }).then(function () { return { fav: next }; });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/progress\/(\d+)$/))) {
      return patchDoc(parseInt(m[1], 10), { position: Number(body.position) || 0 }).then(function () { return {}; }).then(ok);
    }

    if (raw === '/api/me/dashboard') {
      return listDocs().then(function (docs) {
        var notes = docs.filter(function (d) { return String(d.note || '').trim(); })
          .map(function (d) {
            return { material_id: d.id, name: d.name, subject: d.subject, kind: d.kind, content: d.note, updated_at: d.created_at };
          });
        var attempts = [];
        docs.forEach(function (d) {
          (d.attempts || []).forEach(function (a) {
            attempts.push({ material_id: d.id, name: d.name, subject: d.subject, score: a.score, total: a.total, created_at: a.created_at });
          });
        });
        attempts.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
        return { favorites: docs.filter(function (d) { return d.fav; }), notes: notes, attempts: attempts.slice(0, 50) };
      }).then(ok);
    }

    if (raw === '/api/models/custom') {
      return listDocs().then(function (docs) {
        return { items: docs.filter(function (d) { return d.subject === '模型动画'; })
          .map(function (d) { return { id: d.id, name: d.name, group_path: d.group_path || '', created_at: d.created_at }; }) };
      }).then(ok);
    }

    if (raw === '/api/models/generate') {
      var title = String(body.title || '').trim();
      var category = String(body.category || '').trim() || '我的模型';
      var brief = String(body.prompt || '').trim();
      if (!title) { return fail('请先写一个模型名称，例如“带电粒子在磁场中的螺旋运动”'); }
      return aiChat([{ role: 'system', content: ANIMATION_SYSTEM },
        { role: 'user', content: ANIMATION_PROMPT + '\n\n类别：' + category + '\n模型名称：' + title
          + (brief ? '\n补充要求：' + brief : '') }], null, 20000, 200000).then(function (r) {
        var html = String(r.content || '').replace(/^```[a-z]*/i, '').replace(/```$/, '').trim();
        var low = html.toLowerCase();
        if (html.length < 400 || low.indexOf('<html') < 0 || low.indexOf('</html>') < 0) {
          throw new Error('AI 这次没写完整，再点一次试试。');
        }
        if (/(src|href)\s*=\s*["']https?:\/\//i.test(low)) {
          throw new Error('生成的动画引用了外部网址，为了离线也能看，已经拒绝保存。请再生成一次。');
        }
        var fileName = '【模型】' + title.replace(/[\\/:*?"<>|]/g, '_') + '.html';
        var blob = new File([html], fileName, { type: 'text/html' });
        return addFile(blob, '模型动画').then(function (doc) {
          return { material_id: doc.id, name: doc.name, category: category, chars: html.length };
        });
      }).then(ok);
    }

    if ((m = raw.match(/^\/api\/models\/custom\/(\d+)\/delete$/))) {
      return removeDoc(parseInt(m[1], 10)).then(function () { return {}; }).then(ok);
    }

    if (raw === '/api/settings/ai') {
      if (opt.method === 'POST' || body.base_url !== undefined || body.api_key !== undefined || body.model_text !== undefined) {
        return aiConf().then(function (conf) {
          var next = {
            base_url: body.base_url !== undefined ? String(body.base_url || '').trim() : conf.base_url,
            api_key: body.api_key ? String(body.api_key) : conf.api_key,
            model_text: body.model_text !== undefined ? String(body.model_text || '').trim() : conf.model_text,
            model_vision: body.model_vision !== undefined ? String(body.model_vision || '').trim() : conf.model_vision
          };
          return settingsSet('ai', next).then(function () {
            return { ai: { base_url: next.base_url, has_key: !!next.api_key, model_text: next.model_text, model_vision: next.model_vision } };
          });
        }).then(ok);
      }
      return aiConf().then(function (conf) {
        return { ai: { base_url: conf.base_url, has_key: !!conf.api_key, model_text: conf.model_text, model_vision: conf.model_vision } };
      }).then(ok);
    }

    if (raw === '/api/settings/ai/test') {
      return aiChat([{ role: 'user', content: '请回一个字：好' }], null, 20, 40000).then(function (r) {
        return { result: { ok: true, model: r.model, sample: trimText(r.content, 60) } };
      }).then(ok);
    }

    if (raw === '/api/index/status') { return localStatus().then(function (s) { return { status: s }; }).then(ok); }
    if (raw === '/api/index/control') { return ok({}); }
    if (raw === '/api/selftest') { return ok({ result: { ok: true, local: true } }); }

    // ---- 收集（公网版：服务器 → 免费代理 → AI 联网搜索，依次降级；内容存在自己浏览器里）----
    if (raw === '/api/collect/info') {
      return Promise.all([bridgeConf(), aiConf()]).then(function (res) {
        var br = res[0], ai = res[1];
        return { info: {
          local: true, url: br.url, has_key: !!br.key,
          ai_ready: !!(ai.base_url && ai.api_key),
          proxies: REMOTE_PROXIES.length,
          note: '收集会依次尝试：你电脑上的服务器 → 免费抓取代理 → 你自己的 AI 联网搜索。'
        } };
      }).then(ok);
    }

    if (raw === '/api/collect/config') {
      var newUrl = String(body.url || '').trim();
      var typedKey = String(body.key || '').trim().toUpperCase();
      return bridgeConf().then(function (conf) {
        var useKey = typedKey || conf.key || '';
        return bridgeSave(newUrl, useKey).then(function () {
          return bridgeCall('/api/bridge/ping').then(function () {
            return { info: { local: true, url: newUrl, has_key: !!useKey, connected: true,
                             note: '已连上服务器，抓取会更稳。' } };
          }).catch(function (e) {
            return { info: { local: true, url: newUrl, has_key: !!useKey, connected: false, note: errText(e) } };
          });
        });
      }).then(ok);
    }

    if (raw === '/api/collect/test') {
      return collectChannelReport().then(function (r) { return { result: r }; }).then(ok);
    }

    if (raw === '/api/collect/search') {
      return collectSearchChain(query.q || '', 8).then(ok);
    }

    if (raw === '/api/collect/preview') {
      return collectPageChain(query.url || '').then(function (r) {
        return { title: r.title, url: r.url, chars: r.text.length, via: r.via,
                 preview: String(r.text || '').slice(0, 600) };
      }).then(ok);
    }

    if (raw === '/api/collect/url') {
      var colUrl = String(body.url || '').trim();
      if (!colUrl) { return fail('请填写网址'); }
      var colSubject = String(body.subject || '网络收集').trim() || '网络收集';
      return collectPageChain(colUrl).then(function (r) {
        var pageTitle = String(r.title || '网页资料').trim();
        var pageText = String(r.text || '');
        var via = r.via;
        return maybeSummarize(pageText, pageTitle, body.summarize !== false).then(function (summary) {
          var md = collectedMarkdown(pageTitle, r.url, pageText, summary);
          return saveCollected('【网络收集】' + safeName(pageTitle), md, colSubject).then(function (doc) {
            return maybeQuiz(doc.id, pageText, !!body.quiz).then(function () {
              return { filename: doc.name, chars: md.length, material_id: doc.id, via: via };
            });
          });
        });
      }).then(ok);
    }

    if (raw === '/api/collect/topic') {
      var topic = String(body.topic || '').trim();
      if (!topic) { return fail('请填写想收集的主题'); }
      var topicSubject = String(body.subject || '网络收集').trim() || '网络收集';
      var want = Math.min(8, Math.max(1, parseInt(body.limit || 5, 10) || 5));
      return collectSearchChain(topic, Math.min(10, want + 4)).then(function (found) {
        var hits = found.hits || [];
        if (!hits.length) { throw new Error('没有搜到相关网页，换个说法再试。'); }
        var searchVia = found.via;
        var entries = [];
        var firstError = '';
        var chain = Promise.resolve();
        hits.forEach(function (h) {
          chain = chain.then(function () {
            if (entries.length >= want) { return null; }
            return collectPageChain(h.url).then(function (p) {
              entries.push({ title: p.title || h.title, url: p.url || h.url,
                             text: String(p.text || ''), full: true,
                             media: h.media || '', date: h.date || '' });
            }).catch(function (e) {
              if (!firstError) { firstError = errText(e); }
              if (h.snippet) {
                entries.push({ title: h.title, url: h.url, text: String(h.snippet), full: false,
                               media: h.media || '', date: h.date || '' });
              }
            });
          });
        });
        return chain.then(function () {
          if (!entries.length) {
            throw new Error('这些网页都抓不到内容，换个关键词再试。'
              + (firstError ? '（' + firstError + '）' : ''));
          }
          var digest = entries.map(function (d) {
            return '【' + d.title + '】' + d.url + '\n' + d.text.slice(0, 6000);
          }).join('\n\n');
          var list = entries.map(function (d) {
            var line = sourceListMarkdown([d]);
            return line + (d.full ? '' : '（搜索摘要）');
          }).join('\n');
          var rawBlock = entries.map(function (d) {
            var mark = d.full ? '（全文）' : '（搜索摘要，对方网站不允许抓取全文）';
            return '### ' + d.title + ' ' + mark + '\n' + d.url + '\n\n' + d.text.slice(0, 3000);
          }).join('\n\n');
          return maybeSummarize(digest, topic, true).then(function (summary) {
            var head = '# ' + topic + '（网络收集）\n\n';
            head += '> 收集时间：' + nowLabel() + '　·　来源：' + searchVia
              + '　·　共 ' + entries.length + ' 个网络来源\n\n';
            if (summary) { head += '## AI 汇总的知识点\n' + summary + '\n\n'; }
            head += '## 来源\n' + list + '\n\n---\n\n## 原始来源\n' + rawBlock;
            var sources = entries.map(function (d) {
              return { title: d.title, url: d.url, full: d.full,
                       media: d.media || '', date: d.date || '' };
            });
            return saveCollected('【网络收集】' + safeName(topic), head, topicSubject).then(function (doc) {
              return maybeQuiz(doc.id, digest, !!body.quiz).then(function () {
                return { filename: doc.name, chars: digest.length, sources: sources,
                         material_id: doc.id, via: searchVia };
              });
            });
          });
        });
      }).then(ok);
    }

    if (raw === '/api/collect/note') {
      var noteTitle = String(body.title || '').trim() || ('我的笔记 ' + nowLabel());
      var noteBody = String(body.content || '').trim();
      if (noteBody.length < 10) { return fail('内容太短了'); }
      var noteSubject = String(body.subject || '我的笔记').trim() || '我的笔记';
      var noteMd = '# ' + noteTitle + '\n\n> 记录时间：' + nowLabel() + '\n\n' + noteBody;
      return saveCollected('【笔记】' + safeName(noteTitle), noteMd, noteSubject).then(function (doc) {
        return { filename: doc.name, chars: noteBody.length, material_id: doc.id };
      }).then(ok);
    }

    return fail('这个功能需要在你电脑上的本地版里用（公网单文件版不带服务器功能）。');
  }

  window.StudyStore = {
    ready: openDb,
    list: listDocs,
    add: addFile,
    get: function (id) { return getOne('docs', id); },
    remove: removeDoc,
    texts: docTexts,
    setTexts: setTexts,
    search: searchLocal,
    contexts: localContexts,
    objectUrl: objectUrl,
    dataUrl: blobToDataUrl,
    blob: fileBlob,
    patch: patchDoc,
    usage: usage,
    reextract: extractAgain,
    settingsGet: settingsGet,
    settingsSet: settingsSet,
    kindOf: kindOf,
    extractFor: extractFor,
    matchHits: matchHits,
    visionTextOf: visionTextOf,
    humanSize: humanSize,
    KIND_LABELS: KIND_LABELS,
    localUser: LOCAL_USER
  };
  window.StudyGate = { required: gateRequired, unlocked: gateUnlocked, submit: gateSubmit, reset: gateReset };
  window.studyLocalApi = localApi;
})();