/* 文件夹模式的扫描/分类单测：喂一棵内存目录树，检查分类与增量统计。
   运行：node tests\folder_unit.js      （纯 node，不需要服务、不联网） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'folder.js'), 'utf8');
const sandbox = {
  window: {}, console: console, Blob: class Blob { constructor(parts) { this.parts = parts; } },
  Promise: Promise, Object: Object, Math: Math, Date: Date, JSON: JSON, Number: Number, String: String,
  Array: Array, setTimeout: setTimeout
};
sandbox.window = sandbox;
// 内存版 IndexedDB：按 store 名分表，支持 get/put/delete/getAll，够 folder.js 的 state/docs/texts 用。
const tables = {};
function table(name) { if (!tables[name]) { tables[name] = {}; } return tables[name]; }
sandbox.indexedDB = {
  open: function () {
    var db = {
      objectStoreNames: { contains: function (n) { return Object.prototype.hasOwnProperty.call(tables, n); } },
      createObjectStore: function (n) { table(n); return {}; },
      deleteObjectStore: function (n) { delete tables[n]; return true; },
      transaction: function (name) {
        var tx = { oncomplete: null, onerror: null, error: null };
        tx.objectStore = function (n) {
          var t = table(n);
          return {
            get: function (key) {
              var req = {};
              setTimeout(function () { req.result = t[key]; if (req.onsuccess) { req.onsuccess(); } }, 0);
              return req;
            },
            put: function (value, key) { t[key] = value; return {}; },
            delete: function (key) { delete t[key]; return {}; },
            getAll: function () {
              var req = {};
              setTimeout(function () {
                req.result = Object.keys(t).map(function (k) { return t[k]; });
                if (req.onsuccess) { req.onsuccess(); }
              }, 0);
              return req;
            }
          };
        };
        setTimeout(function () { if (tx.oncomplete) { tx.oncomplete(); } }, 0);
        return tx;
      }
    };
    var open = {};
    setTimeout(function () {
      open.result = db;
      open.transaction = db.transaction('state', 'readwrite');
      if (open.onupgradeneeded) { open.onupgradeneeded(); }
      if (open.onsuccess) { open.onsuccess(); }
    }, 0);
    return open;
  }
};
const store = table('state');
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
// folder.js 现在把“抽文字 / 认字”交给 store.js，这里按类型伪造一份。
sandbox.StudyStore = {
  extractFor: async function (blob, kind, ext) {
    if (kind === 'text') { return [{ page: 1, origin: 'extract', content: '正文内容 ' + String(blob && blob.name) }]; }
    if (kind === 'pdf') { return [{ page: 1, origin: 'extract', content: 'PDF 第一页' },
                                  { page: 2, origin: 'extract', content: 'PDF 第二页' }]; }
    return [];
  },
  visionTextOf: async function () { return '识别出来的文字'; }
};

const F = sandbox.StudyFolder;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

check('支持的浏览器能力判定（无 picker 时给原因）', F.supported() === false && String(F.why()).length > 0);

function file(name, size, mtime) {
  return { kind: 'file', name: name, getFile: async () => ({ name: name, size: size, lastModified: mtime || 1000 }) };
}
function dir(name, kids) {
  return { kind: 'directory', name: name, values: async function* () { for (const k of kids) { yield k; } } };
}

const tree = dir('root', [
  dir('物理', [file('牛顿定律.pdf', 1200), file('笔记.md', 40), dir('章一', [file('力.png', 500)])]),
  dir('化学', [file('方程式.png', 800), file('表.xlsx', 2), file('视频.mp4', 9000)]),
  dir('.git', [file('config', 5)]),
  file('根目录也放一个.txt', 12)
]);

(async () => {
  const docs = [];
  const state = { folders: 0, skipped: 0, subjects: {} };
  await F._walk(tree, '', 0, docs, state);
  const byName = {};
  docs.forEach(d => { byName[d.name] = d; });

  check('顶层文件夹当学科', byName['牛顿定律.pdf'].subject === '物理' && byName['方程式.png'].subject === '化学');
  check('子文件夹继承顶层学科', byName['力.png'].subject === '物理');
  check('根目录下的文件进“未分类”', byName['根目录也放一个.txt'].subject === '未分类');
  check('后缀映射类型：pdf/文档/图片/表格/视频', byName['牛顿定律.pdf'].kind === 'pdf'
    && byName['笔记.md'].kind === 'text' && byName['方程式.png'].kind === 'image'
    && byName['表.xlsx'].kind === 'sheet' && byName['视频.mp4'].kind === 'video');
  check('隐藏目录被跳过（.git）', !byName['config']);
  check('统计到学科数量', Object.keys(state.subjects).length === 3, state.subjects);
  check('相对路径带学科前缀', byName['力.png'].relPath === '物理/章一/力.png', byName['力.png'].relPath);
  check('文件数量正确（7 个可见文件：物理3+化学3+根1）', docs.length === 7, docs.length);

  const old = [{ id: byName['牛顿定律.pdf'].id, mtime: byName['牛顿定律.pdf'].mtime, size: 1200 }];
  const oldMap = {}; old.forEach(d => { oldMap[d.id] = d; });
  let added = 0, changed = 0;
  docs.forEach(d => { const b = oldMap[d.id]; if (!b) { added++; return; } if (Math.abs(b.mtime - d.mtime) > 1 || b.size !== d.size) changed++; });
  let removed = 0; Object.keys(oldMap).forEach(id => { if (!docs.some(d => d.id === id)) removed++; });
  check('增量统计：新增6（1 个已存在）/变化0/消失0', added === 6 && changed === 0 && removed === 0, { added, changed, removed });

  // ---- 上传写进自己的文件夹：新建分类、重名不覆盖、权限提示 ----
  function mockDir(name, kids) {
    const files = new Map();
    const dirs = new Map();
    function fileHandle(n) {
      return {
        kind: 'file', name: n,
        getFile: async () => ({ name: n, size: 0, lastModified: Date.now() }),
        createWritable: async () => ({
          write: async (blob) => { files.set(n, blob); },
          close: async () => {}
        })
      };
    }
    return {
      kind: 'directory', name: name, _files: files, _dirs: dirs,
      values: async function* () { for (const k of (kids || [])) { yield k; } },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async function (n, opts) {
        if (files.has(n)) { return fileHandle(n); }
        if (opts && opts.create) { files.set(n, null); return fileHandle(n); }
        throw new Error('not found: ' + n);
      },
      getDirectoryHandle: async function (n, opts) {
        if (dirs.has(n)) { return dirs.get(n); }
        if (opts && opts.create) { const d = mockDir(n, []); dirs.set(n, d); return d; }
        throw new Error('没有这个目录：' + n);
      }
    };
  }

  const rootDir = mockDir('资料库');
  store['root'] = { handle: rootDir, at: Date.now() };
  const payload = { kind: 'blob', text: 'hello' };
  const p1 = await F.writeFile('物理', '牛顿定律.pdf', payload);
  check('上传写进文件夹：分类目录自动创建', p1 === '物理/牛顿定律.pdf', p1);
  check('写进去的就是我们给的那个文件', rootDir._dirs.get('物理')._files.get('牛顿定律.pdf') === payload);
  const p2 = await F.writeFile('物理', '牛顿定律.pdf', payload);
  check('重名不覆盖，自动加序号', p2 === '物理/牛顿定律 (1).pdf', p2);
  const p3 = await F.writeFile('', '根目录.txt', payload);
  check('没选分类就写在根目录', p3 === '根目录.txt', p3);
  const p4 = await F.writeFile('化学/有机', 'a:b?.png', payload);
  check('非法字符替换 + 多级目录一起建', p4 === '化学/有机/a_b_.png', p4);

  const lockedDir = mockDir('锁住的');
  lockedDir.queryPermission = async () => 'denied';
  lockedDir.requestPermission = async () => 'denied';
  store['root'] = { handle: lockedDir, at: Date.now() };
  let denied = '';
  try { await F.writeFile('x', 'y.txt', payload); } catch (e) { denied = String(e && e.message); }
  check('没有写权限时给的是看得懂的提示', denied.indexOf('写入权限') >= 0, denied);
  store['root'] = { handle: rootDir, at: Date.now() };

  // file://（双击打开的单文件版）里浏览器不给读文件夹，要如实报不支持
  sandbox.window.isSecureContext = true;
  sandbox.window.showDirectoryPicker = function () {};
  sandbox.window.location = { protocol: 'http:' };
  check('在线地址下支持文件夹模式', F.supported() === true);
  sandbox.window.location = { protocol: 'file:' };
  check('双击打开的本地文件模式如实报不支持', F.supported() === false && String(F.why()).indexOf('本地文件模式') >= 0, F.why());

  // ---- 扫描时抽取文字（搜索 / AI 问答要用），并验证增量与统计 ----
  function mfile(name) {
    const f = { kind: 'file', name: name };
    f._size = 40; f._mtime = 1000;
    f.getFile = async () => ({ name: name, size: f._size, lastModified: f._mtime });
    return f;
  }
  // 既能被 walk 遍历、又能被 fileOf 顺路径拿到的目录（fileOf 要 getFileHandle）。
  function scanDir(name, kids) {
    const list = kids || [];
    return {
      kind: 'directory', name: name,
      values: async function* () { for (const k of list) { yield k; } },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async function (n) {
        for (const k of list) { if (k.kind === 'directory' && k.name === n) { return k; } }
        throw new Error('没有这个目录：' + n);
      },
      getFileHandle: async function (n) {
        for (const k of list) { if (k.kind === 'file' && k.name === n) { return k; } }
        throw new Error('没有这个文件：' + n);
      }
    };
  }
  const physicsKids = [];
  const scanTree = scanDir('资料库', [scanDir('物理', physicsKids), file('根目录.txt', 12, 1000),
                                      file('扫描页.png', 500, 1000)]);
  physicsKids.push(mfile('笔记.md'));
  store.root = { handle: scanTree, at: Date.now() };

  const scanRes = await F.scan();
  check('扫描时把可读文件抽成文字（md + txt）', scanRes.indexTotal === 2 && scanRes.indexed === 2, scanRes.indexTotal);
  let src = await F.searchSources();
  check('抽到的文字进了可搜索集合（1 份 md + 1 份 txt）', src.docs.length === 2 && src.texts.length === 2,
    { docs: src.docs.length, texts: src.texts.length });
  check('文字行的 id 是 f: 开头的相对路径', src.texts.every(t => String(t.material_id).indexOf('f:') === 0));
  check('抽出来的就是文件正文', String(src.texts[0].content).indexOf('正文内容') === 0, src.texts[0].content);

  const scanRes2 = await F.scan();
  check('第二次扫描不重复抽取（增量）', scanRes2.indexTotal === 0 && scanRes2.added === 0, scanRes2);
  src = await F.searchSources();
  check('重扫不会把文字写两份', src.texts.length === 2, src.texts.length);

  let st = await F.stats();
  check('统计：共 3 份 / 可搜索 2 / 待识别 1 / 等待提取 0',
    st.total === 3 && st.searchable === 2 && st.need_ai === 1 && st.waiting === 0, st);

  const mf = physicsKids[0];
  mf._size = 80; mf._mtime = 2000;
  const scanRes3 = await F.scan();
  check('改了内容只重抽这一份', scanRes3.indexTotal === 1 && scanRes3.changed === 1, scanRes3);
  src = await F.searchSources();
  check('重抽替换旧文字而不是堆两份', src.texts.length === 2, src.texts.length);

  const vis = await F.visionOne('扫描页.png');
  check('AI 识别写入文字', vis.chars > 0, vis);
  src = await F.searchSources();
  const vrows = src.texts.filter(t => t.origin === 'vision');
  check('识别出来的文字挂在图片这份资料上',
    vrows.length === 1 && vrows[0].material_id === 'f:扫描页.png', vrows);
  st = await F.stats();
  check('识别后：待识别归零、可搜索 +1', st.need_ai === 0 && st.searchable === 3, st);

  const pend = await F.indexPending();
  check('没有可提取的了（提取按钮空跑）', pend.total === 0, pend);

  await F.forget();
  const afterForget = await Promise.all([F.docs(), F.snapshot(), F.rootInfo()]);
  check('忘记文件夹：记录、扫描快照、句柄都清掉',
    afterForget[0].length === 0 && !afterForget[1] && !afterForget[2]);

  // ---- 浏览器抛的英文错误要说人话（点“取消”尤其不能弹红条）----
  const fe1 = F.friendlyError({ name: 'AbortError', message: 'The user aborted a request.' });
  check('点取消 -> 中文提示，并告诉你怎么才算选中',
    fe1.cancelled === true && fe1.message.indexOf('没有选中文件夹') >= 0
    && fe1.message.indexOf('选择文件夹') >= 0, fe1.message);
  const fe2 = F.friendlyError({ name: 'NotFoundError', message: 'The object can not be found here.' });
  check('文件不在了 -> 中文提示 + 建议刷新',
    fe2.cancelled === false && fe2.message.indexOf('立即刷新') >= 0, fe2.message);
  const fe3 = F.friendlyError(new Error('这个文件夹没有写入权限，去「文件夹」页重新选一次并点“允许”。'));
  check('本来就写好的中文原样保留', fe3.message.indexOf('写入权限') >= 0, fe3.message);

  sandbox.window.location = { protocol: 'http:' };
  sandbox.window.isSecureContext = true;
  sandbox.window.showDirectoryPicker = function () {
    return Promise.reject({ name: 'AbortError', message: 'The user aborted a request.' });
  };
  let cancelErr = null;
  try { await F.pick(); } catch (e) { cancelErr = e; }
  check('选文件夹时点取消：报“取消”而不是英文报错',
    !!cancelErr && cancelErr.cancelled === true && String(cancelErr.message).indexOf('aborted') < 0,
    cancelErr && cancelErr.message);

  const fe4 = F.friendlyError({ name: 'UnknownError', message: 'The request was aborted by something else.' });
  check('别的报错不会被当成“取消”，也不冒充取消提示',
    fe4.cancelled === false && fe4.message.indexOf('没有选中文件夹') < 0, fe4.message);

  // 一个目录整个读不动（权限 / 被删 / 被占用）不能让整次扫描崩掉、让页面停在“还没有选文件夹”
  const badSub = { kind: 'directory', name: '打不开的目录',
    values: async function* () { throw new Error('这个目录读不动'); } };
  store.root = { handle: scanDir('资料库', [badSub, file('好的.txt', 20, 1000)]), at: Date.now() };
  const resScan = await F.scan();
  check('一个目录读不动只跳过它，扫描继续',
    resScan.docs.length === 1 && resScan.skipped === 1,
    { docs: resScan.docs.length, skipped: resScan.skipped });

  // 真的选中了文件夹（弹窗返回了句柄）：句柄要存下来、能扫出快照
  const okHandle = scanDir('我选的文件夹', [file('a.txt', 30, 1000)]);
  sandbox.window.showDirectoryPicker = function () { return Promise.resolve(okHandle); };
  const picked = await F.pick();
  check('真的选中文件夹：扫描出快照、文件夹名对得上',
    !!picked && picked.docs.length === 1 && picked.folder === '我选的文件夹',
    { n: picked && picked.docs.length, folder: picked && picked.folder });
  const savedRoot = await F.rootInfo();
  check('选中之后 rootInfo 里存着这个文件夹',
    !!savedRoot && !!savedRoot.handle && savedRoot.handle.name === '我选的文件夹');

  // ---- 选文件夹只申请“读”：不再连带弹“允许修改文件”，写权限留到真要写的时候 ----
  let pickOpts = null;
  const readOnlyDir = scanDir('只读目录', [file('a.txt', 30, 1000)]);
  sandbox.window.showDirectoryPicker = function (opts) { pickOpts = opts; return Promise.resolve(readOnlyDir); };
  await F.pick();
  check('选文件夹只要读权限（不再连写一起要）', !!pickOpts && pickOpts.mode === 'read', pickOpts);

  // 内置浏览器这类“窗口根本弹不出来”的情况：几百毫秒内就 abort，要说清是浏览器没弹窗，
  // 并给出电脑版 Edge/Chrome 的出路；不能糊成“你自己取消了”。
  sandbox.window.showDirectoryPicker = function () {
    return Promise.reject({ name: 'AbortError', message: 'The user aborted a request.' });
  };
  let quickErr = null;
  try { await F.pick(); } catch (e) { quickErr = e; }
  check('窗口没弹出来就 abort：不冒充“你取消了”，并给出 Edge/Chrome 的出路',
    !!quickErr && quickErr.cancelled === true && quickErr.noDialog === true
    && /Edge|Chrome/.test(quickErr.message) && quickErr.message.indexOf('没有选中文件夹') < 0,
    quickErr && quickErr.message);

  // 内置浏览器里实测到的原话（Codex 自带浏览器，日志里 ms=3126/5062/6076）：
  // AbortError: Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.
  const embedderErr = F.friendlyError({ name: 'AbortError',
    message: "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request." }, 3126);
  check('内置浏览器把窗口开不起来：说是浏览器没弹窗，并给出电脑版 Edge/Chrome 的出路',
    embedderErr.noDialog === true && /Edge|Chrome/.test(embedderErr.message)
    && embedderErr.message.indexOf('没有选中文件夹：弹窗被取消') < 0,
    embedderErr.message);

  // 反过来：用户真的点了取消（等了 3 秒才关、消息里没有那句 Failed to execute）不能被赖到浏览器头上
  const realCancel = F.friendlyError({ name: 'AbortError', message: 'The user aborted a request.' }, 3000);
  check('真的点了取消（3 秒后才关）仍然说是取消，不赖浏览器',
    realCancel.noDialog === false && realCancel.message.indexOf('没有选中文件夹') >= 0,
    realCancel.message);

  // 嵌在别的窗口里（内置浏览器常见）浏览器直接拒，别说成“没给权限”
  const fe6 = F.friendlyError({ name: 'SecurityError',
    message: "Cross origin sub frames aren't allowed to show a file picker." });
  check('被嵌在其它窗口里时给出可照做的提示',
    fe6.message.indexOf('嵌') >= 0 && /Edge|Chrome/.test(fe6.message), fe6.message);

  // 只读文件夹里导出：要先要写权限，提示要告诉用户去点“允许”
  const lockedRead = mockDir('只读的');
  lockedRead.queryPermission = async () => 'denied';
  lockedRead.requestPermission = async () => 'denied';
  store.root = { handle: lockedRead, at: Date.now() };
  let expErr = '';
  try { await F.writeText('导出', 'a.md', 'hi'); } catch (e) { expErr = String(e && e.message); }
  check('导出到只读文件夹：中文提示要点“允许”',
    expErr.indexOf('写入权限') >= 0 && expErr.indexOf('允许') >= 0, expErr);

  // 导出前先要写权限：不传参数就该用当前存着的那个文件夹
  let preErr = '';
  try { await F.ensureWritable(); } catch (e) { preErr = String(e && e.message); }
  check('不带参数的 ensureWritable 用当前文件夹，没权限时给中文提示',
    preErr.indexOf('写入权限') >= 0, preErr);
  store.root = { handle: rootDir, at: Date.now() };

  let pickCalls = 0;
  sandbox.window.showDirectoryPicker = function () { pickCalls++; return new Promise(function () {}); };
  const pendingPick = F.pick();
  let secondErr = null;
  try { await F.pick(); } catch (e) { secondErr = e; }
  check('弹窗还开着时再点：说人话，也不会开第二个弹窗',
    pickCalls === 1 && !!secondErr && String(secondErr.message).indexOf('还开着') >= 0,
    { calls: pickCalls, msg: secondErr && secondErr.message });
  pendingPick.catch(function () {});

  // 选中文件夹之后，那个文件夹本身读到一半读不动（Chrome 常见：The operation was aborted.）：
  // 以前整次扫描会中断，页面还弹「已取消：没有选择文件夹」，看着像白选了一样。
  const halfBroken = { kind: 'directory', name: '读一半的文件夹', values: async function* () {
    yield file('还能读.txt', 10, 1000);
    throw new Error('The operation was aborted.');
  } };
  store.root = { handle: halfBroken, at: Date.now() };
  const halfScan = await F.scan();
  check('选中后文件夹读到一半失败：已经读到的照样收下，不再整次中断',
    halfScan.docs.length === 1 && halfScan.skipped === 1,
    { docs: halfScan.docs.length, skipped: halfScan.skipped });
  const fe5 = F.friendlyError(new Error('The operation was aborted.'));
  check('“The operation was aborted.”不算用户取消，也不冒充取消提示',
    fe5.cancelled === false && fe5.message.indexOf('没有选中文件夹') < 0, fe5.message);


  // ---- 兼容扫描：内置浏览器没有 showDirectoryPicker 时的兜底 ----
  sandbox.document = {
    createElement: function () {
      var el = { type: '', multiple: false, style: {}, files: [], value: '',
        webkitdirectory: '', _on: {},
        setAttribute: function () {},
        addEventListener: function (k, fn) { (el._on[k] = el._on[k] || []).push(fn); },
        removeEventListener: function (k, fn) { var a = el._on[k] || []; var i = a.indexOf(fn); if (i >= 0) { a.splice(i, 1); } },
        click: function () {}, appendChild: function () {} };
      return el;
    },
    body: { appendChild: function () {} }
  };
  check('兼容扫描的能力判定：有 webkitdirectory 就算支持',
    F.compatSupported() === true && F.compatWhy() === '', F.compatWhy());

  function cfile(rel, size, mtime) {
    var parts = String(rel).split('/');
    return { name: parts[parts.length - 1], webkitRelativePath: rel, size: size,
      lastModified: (mtime || 1000) * 1000 };
  }

  await F.forget();
  var compatList = [
    cfile('我的资料/物理/牛顿定律.pdf', 1200, 5000),
    cfile('我的资料/物理/笔记.md', 40, 5000),
    cfile('我的资料/化学/方程式.png', 800, 5000),
    cfile('我的资料/化学/表.xlsx', 2, 5000),
    cfile('我的资料/根目录.txt', 12, 5000),
    cfile('我的资料/.git/config', 5, 5000)
  ];
  var cres = await F.compatScan(compatList, {});
  var cby = {};
  cres.docs.forEach(function (d) { cby[d.name] = d; });
  check('兼容扫描：顶层文件夹当学科、根目录文件进“未分类”',
    cby['牛顿定律.pdf'].subject === '物理' && cby['方程式.png'].subject === '化学'
    && cby['根目录.txt'].subject === '未分类',
    [cby['牛顿定律.pdf'].subject, cby['方程式.png'].subject, cby['根目录.txt'].subject]);
  check('兼容扫描：后缀映射类型',
    cby['牛顿定律.pdf'].kind === 'pdf' && cby['笔记.md'].kind === 'text'
    && cby['方程式.png'].kind === 'image' && cby['表.xlsx'].kind === 'sheet', cres.docs.length);
  check('兼容扫描：相对路径与句柄模式对齐（去掉选中的那个文件夹本身）',
    cby['牛顿定律.pdf'].relPath === '物理/牛顿定律.pdf', cby['牛顿定律.pdf'].relPath);
  check('兼容扫描：隐藏目录被跳过', cres.docs.length === 5 && !cby['config'], cres.docs.length);
  check('兼容扫描：只记下文件夹的名字，不记路径',
    (await F.compatRoot()).name === '我的资料', await F.compatRoot());

  var cst = await F.stats();
  check('兼容扫描后的可搜索/待识别/等待提取数字',
    cst.total === 5 && cst.searchable === 3 && cst.need_ai === 1 && cst.waiting === 1, cst);

  var csrc = await F.searchSources();
  check('兼容扫描抽到的文字能被 searchSources 搜到',
    csrc.docs.length === 3 && csrc.texts.some(function (t) { return t.content === 'PDF 第一页'; })
    && csrc.texts.some(function (t) { return String(t.content).indexOf('正文内容 笔记.md') >= 0; }),
    { docs: csrc.docs.length, texts: csrc.texts.length });

  check('兼容扫描的文件在本次会话里能打开',
    F.sessionFile('物理/牛顿定律.pdf') === true && F.sessionFile('物理/没有这个.pdf') === false);

  var cagain = await F.compatScan(compatList, {});
  check('兼容扫描是增量的：同一批文件第二次不重复抽文字',
    cagain.indexTotal === 0 && cagain.added === 0 && cagain.changed === 0, cagain.indexTotal);

  var cres2 = await F.compatScan([cfile('我的资料/物理/牛顿定律.pdf', 9999, 9000)], {});
  check('兼容扫描：改过的文件重抽、消失的文件被清掉',
    cres2.changed === 1 && cres2.removed === 4, { changed: cres2.changed, removed: cres2.removed });

  await F.forget();
  check('forget 之后兼容扫描的记录、文件夹名、会话文件都清掉了',
    (await F.snapshot()) === null && !(await F.compatRoot())
    && F.sessionFile('物理/牛顿定律.pdf') === false);

  var cres3 = await F.compatScan(compatList, {});
  check('重新选同一个文件夹：按相对路径把文件接回本次会话',
    cres3.docs.length === 5 && F.sessionFile('物理/牛顿定律.pdf') === true);

  var compatErr = F.friendlyError({ name: 'AbortError',
    message: "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request." }, 3126, true);
  check('内置浏览器选文件夹失败的提示里不出现英文原文',
    !/Abort|Failed to execute|showDirectoryPicker/.test(compatErr.message), compatErr.message);

  console.log('\nfolder 单测：共 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();