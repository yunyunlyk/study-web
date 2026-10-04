const fs = require('fs');
const vm = require('vm');
// 路径按本文件的位置算出来。以前写死成本机的绝对路径，
// 项目只要换个目录（或换台电脑）这个单测就直接崩。
const path = require('path').join(__dirname, '..', 'web', 'models.js');
const code = fs.readFileSync(path, 'utf8');
let calls = 0;
function makeCtx() {
  const rec = function () { calls++; };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') { return function () { calls++; return { width: 12 }; }; }
      if (k === 'canvas') { return { width: 640, height: 360 }; }
      if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k)) { return t[k]; }
      return rec;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
const sandbox = { window: {}, Math, console, requestAnimationFrame: function () { return 1; }, cancelAnimationFrame: function () {} };
sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'models.js' });
const models = sandbox.window.MODELS || [];
console.log('模型总数：' + models.length);
let bad = 0;
models.forEach(function (m) {
  const p = {};
  (m.params || []).forEach(function (q) { p[q.key] = q.value; });
  [0, 0.5, 1.7, 5.3, 30].forEach(function (t) {
    calls = 0;
    try {
      m.draw(makeCtx(), 640, 360, t, p);
      if (calls < 3) { throw new Error('几乎没画东西 (calls=' + calls + ')'); }
    } catch (e) {
      bad++;
      console.log('  [FAIL] ' + m.id + ' t=' + t + ' -> ' + e.message);
    }
  });
});
const ids = models.map(function (m) { return m.id; });
const dup = ids.filter(function (x, i) { return ids.indexOf(x) !== i; });
if (dup.length) { console.log('  [FAIL] 重复 id: ' + dup.join(',')); bad++; }
const noDesc = models.filter(function (m) { return !m.desc || !m.title || !m.subject; });
if (noDesc.length) { console.log('  [FAIL] 缺少标题/说明: ' + noDesc.map(function (m) { return m.id; }).join(',')); bad++; }
console.log(bad ? 'FAILED ' + bad : 'ALL OK');
process.exit(bad ? 1 : 0);