/* 学习网页的离线壳（PWA）。策略：网络优先 —— 有网时永远拿最新的页面和脚本，
   断网时才回落到缓存；/api/ 接口一律不缓存，避免看到过期的数据。 */
'use strict';
var CACHE = 'study-shell-v6';
var SHELL = ['/', '/static/style.css', '/static/theme.js', '/static/ui.js', '/static/models.js',
             '/static/store.js', '/static/folder.js', '/static/app.js',
             '/static/manifest.webmanifest', '/static/icons/icon-192.png',
             '/static/icons/icon-512.png', '/static/icons/icon-maskable-512.png',
             '/static/icons/apple-touch-icon.png'];

/* 断网而且连首页都没缓存到时的兜底页（比一行纯文本有用）。 */
var OFFLINE_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>连不上服务器</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f6f8fa;color:#1f2328}' +
  '.box{max-width:430px;margin:16px;padding:28px;text-align:center;background:#fff;border-radius:14px;' +
  'box-shadow:0 6px 24px rgba(0,0,0,.08)}h1{margin:0 0 10px;font-size:20px}' +
  'p{margin:0 0 6px;color:#57606a;line-height:1.7}' +
  'button{margin-top:14px;padding:9px 18px;border:0;border-radius:9px;background:#2563eb;' +
  'color:#fff;font-size:14px;cursor:pointer}</style></head><body><div class="box">' +
  '<h1>现在连不上服务器</h1>' +
  '<p>学习网页的服务可能没有在运行，或者网络断了。</p>' +
  '<p>在手机上打开的话，先确认那台电脑上的「启动.bat」是开着的。</p>' +
  '<button onclick="location.reload()">重新加载</button>' +
  '</div></body></html>';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL)['catch'](function () {});
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      if (k !== CACHE) { return caches['delete'](k); }
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }
  var url = new URL(req.url);
  if (url.origin !== location.origin) { return; }
  if (url.pathname.indexOf('/api/') === 0) { return; }
  e.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.ok && (url.pathname.indexOf('/static/') === 0 || url.pathname === '/')) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return resp;
    })['catch'](function () {
      return caches.match(req).then(function (hit) {
        if (hit) { return hit; }
        if (req.mode === 'navigate') {
          return caches.match('/').then(function (page) {
            if (page) { return page; }
            return new Response(OFFLINE_HTML, {
              status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          });
        }
        return new Response('离线了，这个资源还没有缓存。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});