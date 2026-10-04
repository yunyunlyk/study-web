/* 外观/主题：只改 CSS 变量，不改任何结构，所以不会影响原有页面。 */
(function () {
  'use strict';
  var KEY = 'study_theme_v1';

  var PRESETS = {
    light: { label: '浅色', vars: {} },
    dark: { label: '深色', vars: { '--bg': '#12161c', '--card': '#1b2129', '--fg': '#e6eaf0', '--muted': '#98a2b3',
      '--line': '#2a3340', '--accent': '#60a5fa', '--accent-soft': '#1e293b', '--bar': 'rgba(27,33,41,.94)', '--shadow': '0 1px 3px rgba(0,0,0,.5)' } },
    night: { label: '夜间蓝', vars: { '--bg': '#0b1220', '--card': '#131c2e', '--fg': '#dbe6f5', '--muted': '#8ea2c0',
      '--line': '#22304a', '--accent': '#38bdf8', '--accent-soft': '#16233a', '--bar': 'rgba(19,28,46,.94)', '--shadow': '0 1px 3px rgba(0,0,0,.5)' } },
    eye: { label: '护眼绿', vars: { '--bg': '#eef5ec', '--card': '#ffffff', '--fg': '#23301f', '--muted': '#5c6b58',
      '--line': '#d9e6d4', '--accent': '#2f9e44', '--accent-soft': '#e6f4e6' } },
    pink: { label: '樱花粉', vars: { '--bg': '#fff5f7', '--card': '#ffffff', '--fg': '#3b2b31', '--muted': '#8a6f78',
      '--line': '#f5dbe2', '--accent': '#d6336c', '--accent-soft': '#ffe9ef' } },
    paper: { label: '纸张', vars: { '--bg': '#f7f3e8', '--card': '#fffdf6', '--fg': '#3a3529', '--muted': '#7c7360',
      '--line': '#e6dfc9', '--accent': '#8a6d3b', '--accent-soft': '#f3ecda' } }
  };

  var DEFAULTS = {
    preset: 'light', accent: '', bg: '', card: '', fg: '',
    radius: 14, scale: 100, compact: false, follow: false, wallpaper: ''
  };

  function normalize(raw) {
    var theme = {};
    var key;
    for (key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) { theme[key] = DEFAULTS[key]; }
    }
    if (raw && typeof raw === 'object') {
      for (key in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key) && raw[key] !== undefined && raw[key] !== null) {
          theme[key] = raw[key];
        }
      }
    }
    if (!PRESETS[theme.preset]) { theme.preset = theme.accent || theme.bg ? 'custom' : 'light'; }
    theme.radius = Math.max(0, Math.min(24, parseInt(theme.radius, 10) || 0));
    theme.scale = Math.max(85, Math.min(130, parseInt(theme.scale, 10) || 100));
    theme.compact = !!theme.compact;
    theme.follow = !!theme.follow;
    return theme;
  }

  function effective(theme) {
    var out = normalize(theme);
    if (out.follow) {
      var preferDark = false;
      try { preferDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { preferDark = false; }
      out.preset = preferDark ? 'dark' : 'light';
    }
    return out;
  }

  // 壁纸是本地文件（最大 4 MB 的 data URL），只存在这台设备上，不会同步到账号。
  // 单独存一份：登录后拉取"账号主题"时，账号主题里本来就没有壁纸，
  // 不能把"没有壁纸"当成"用户去掉了壁纸"，否则每次登录壁纸都会被清掉。
  var WALL_KEY = 'study_wallpaper_v1';

  function readWall() {
    try {
      var saved = localStorage.getItem(WALL_KEY);
      if (saved) { return saved; }
      var local = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      return local.wallpaper || '';
    } catch (e) {
      return '';
    }
  }

  function writeWall(value) {
    try {
      if (value) { localStorage.setItem(WALL_KEY, value); } else { localStorage.removeItem(WALL_KEY); }
    } catch (e) { }
  }

  function apply(raw) {
    var theme = effective(raw);
    var root = document.documentElement;
    var preset = PRESETS[theme.preset] || PRESETS.light;
    var names = ['--bg', '--card', '--fg', '--muted', '--line', '--accent', '--accent-soft', '--shadow', '--bar'];
    names.forEach(function (name) { root.style.removeProperty(name); });
    Object.keys(preset.vars).forEach(function (name) { root.style.setProperty(name, preset.vars[name]); });
    if (theme.bg) { root.style.setProperty('--bg', theme.bg); }
    if (theme.card) { root.style.setProperty('--card', theme.card); }
    if (theme.fg) { root.style.setProperty('--fg', theme.fg); }
    if (theme.accent) { root.style.setProperty('--accent', theme.accent); }
    root.style.setProperty('--radius', theme.radius + 'px');
    root.style.setProperty('--fs', String(theme.scale / 100));
    root.setAttribute('data-compact', theme.compact ? '1' : '0');
    root.setAttribute('data-theme', theme.preset);
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        var shade = window.getComputedStyle(root).getPropertyValue('--bg').trim();
        if (shade) { meta.setAttribute('content', shade); }
      }
    } catch (e) { }
    var wall = theme.wallpaper || readWall();
    var body = document.body;
    if (body) {
      if (wall) {
        body.style.backgroundImage = 'linear-gradient(rgba(255,255,255,.72),rgba(255,255,255,.72)),url("' + wall + '")';
        body.style.backgroundSize = 'cover';
        body.style.backgroundAttachment = 'fixed';
        body.style.backgroundPosition = 'center';
      } else {
        body.style.backgroundImage = '';
        body.style.backgroundSize = '';
        body.style.backgroundAttachment = '';
        body.style.backgroundPosition = '';
      }
    }
    return theme;
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? normalize(JSON.parse(raw)) : normalize(null);
    } catch (e) {
      return normalize(null);
    }
  }

  function save(raw, opts) {
    var theme = normalize(raw);
    var forServer = normalize(raw);
    forServer.wallpaper = '';
    try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch (e) { }
    if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'wallpaper')) {
      writeWall(theme.wallpaper);
    }
    apply(theme);
    current = theme;
    if (opts && opts.server && window.studyThemeSave) { return window.studyThemeSave(forServer); }
    return Promise.resolve(theme);
  }

  var current = readLocal();
  apply(current);

  window.StudyTheme = {
    presets: PRESETS,
    defaults: DEFAULTS,
    normalize: normalize,
    apply: apply,
    current: function () { return current; },
    local: readLocal,
    save: save,
    reset: function () { return save(DEFAULTS); },
    followSystem: function () { return current.follow; }
  };

  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (current && current.follow) { apply(current); }
    });
  } catch (e) { }
})();