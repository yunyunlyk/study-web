(function () {
  'use strict';
  /* 数理化模型动画库。要加新模型，往 MODELS 数组里加一项即可。*/
  var C = {
    bg: '#0e1521', panel: '#16202f', grid: '#1d2a3c', axis: '#41536b',
    text: '#cfd9e8', dim: '#7d8da5',
    a: '#4ea1ff', b: '#ff6b6b', c: '#ffd166', d: '#5ee0a0', e: '#c792ea', f: '#ff9f43'
  };

  function clear(ctx, w, h) { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h); }
  function font(ctx, size) { ctx.font = size + "px 'Microsoft YaHei','PingFang SC',sans-serif"; }
  function txt(ctx, str, x, y, color, size, align) {
    font(ctx, size || 12); ctx.fillStyle = color || C.dim;
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }
  function line(ctx, x1, y1, x2, y2, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function dash(ctx, x1, y1, x2, y2, color, width, pattern) {
    ctx.save(); ctx.setLineDash(pattern || [5, 5]);
    line(ctx, x1, y1, x2, y2, color, width || 1); ctx.restore();
  }
  function dot(ctx, x, y, r, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r || 4, 0, Math.PI * 2); ctx.fill();
  }
  function arrow(ctx, x1, y1, x2, y2, color, width) {
    var w = width || 1.8;
    line(ctx, x1, y1, x2, y2, color, w);
    var ang = Math.atan2(y2 - y1, x2 - x1), s = 8 + w;
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - 0.38), y2 - s * Math.sin(ang - 0.38));
    ctx.lineTo(x2 - s * Math.cos(ang + 0.38), y2 - s * Math.sin(ang + 0.38));
    ctx.closePath(); ctx.fill();
  }
  function poly(ctx, pts, color, width, close) {
    if (!pts.length) { return; }
    ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) { ctx.lineTo(pts[i][0], pts[i][1]); }
    if (close) { ctx.closePath(); }
    ctx.stroke();
  }
  function circle(ctx, x, y, r, color, width, fillColor) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
    if (color) { ctx.strokeStyle = color; ctx.lineWidth = width || 1.5; ctx.stroke(); }
  }
  function grid(ctx, w, h, stepX, stepY, color) {
    ctx.save(); ctx.strokeStyle = color || C.grid; ctx.lineWidth = 1;
    var i;
    for (i = stepX; i < w; i += stepX) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke(); }
    for (i = stepY; i < h; i += stepY) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke(); }
    ctx.restore();
  }
  function axes(ctx, ox, oy, w, h, xLabel, yLabel) {
    arrow(ctx, ox, oy, w - 6, oy, C.axis, 1.4);
    arrow(ctx, ox, oy, ox, 8, C.axis, 1.4);
    if (xLabel) { txt(ctx, xLabel, w - 10, oy + 14, C.dim, 12, 'right'); }
    if (yLabel) { txt(ctx, yLabel, ox + 8, 14, C.dim, 12); }
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fmt(v, n) { return (Math.round(v * Math.pow(10, n || 2)) / Math.pow(10, n || 2)).toString(); }

  var MODELS = [];

  /* ---------------- 数学 ---------------- */

  MODELS.push({
    id: 'math-unit-circle', subject: '数学', title: '单位圆与正弦函数',
    desc: '圆上一点匀速转动，它纵坐标的变化正好画出正弦曲线。看懂这个，正弦函数的性质就都通了。',
    params: [
      { key: 'A', label: '半径 A', min: 0.5, max: 1.5, step: 0.05, value: 1 },
      { key: 'w', label: '角速度 ω', min: 0.3, max: 3, step: 0.1, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var cy = h * 0.5, R = Math.min(h * 0.3, w * 0.15) * p.A;
      var cx = w * 0.24, th = p.w * t;
      grid(ctx, w, h, 32, 32);
      axes(ctx, cx, cy, w * 0.46, h, '', '');
      line(ctx, cx - R * 1.5, cy, cx + R * 1.5, cy, C.axis, 1);
      line(ctx, cx, cy - R * 1.5, cx, cy + R * 1.5, C.axis, 1);
      circle(ctx, cx, cy, R, C.axis, 1.4);
      var px = cx + R * Math.cos(th), py = cy - R * Math.sin(th);
      var x0 = w * 0.5, span = (w - x0 - 24) / (2 * Math.PI);
      var amp = Math.min(h * 0.3, 120) * p.A;
      axes(ctx, x0, cy, w - 8, h, 'x', '');
      line(ctx, x0, cy - amp, x0, cy + amp, C.axis, 1);
      var pts = [], n;
      for (n = 0; n <= 240; n++) {
        var ang = (n / 240) * 2 * Math.PI;
        pts.push([x0 + span * ang, cy - amp * Math.sin(ang)]);
      }
      poly(ctx, pts, C.dim, 1.4);
      var upto = [], k;
      var phase = th % (2 * Math.PI);
      for (k = 0; k <= 120; k++) {
        var a2 = (k / 120) * phase;
        upto.push([x0 + span * a2, cy - amp * Math.sin(a2)]);
      }
      poly(ctx, upto, C.a, 2.4);
      dash(ctx, px, py, px, cy, C.b, 2);
      line(ctx, cx, cy, px, cy, C.d, 2);
      line(ctx, cx, cy, px, py, C.c, 1.6);
      dot(ctx, px, py, 5, C.c);
      dot(ctx, x0 + span * phase, py, 5, C.b);
      txt(ctx, 'sin', px + 8, py, C.b, 13);
      txt(ctx, 'cos', (cx + px) / 2, cy + 16, C.d, 12, 'center');
      txt(ctx, 'θ = ' + fmt(th % (2 * Math.PI), 2), cx, cy + R + 24, C.dim, 12, 'center');
      txt(ctx, 'y = A·sin(ωx)', x0 + 12, cy - amp - 14, C.a, 13);
    }
  });

  MODELS.push({
    id: 'math-quadratic', subject: '数学', title: '二次函数 y = ax²+bx+c',
    desc: '拖动三个系数，看开口方向、对称轴、顶点和最值怎么跟着变。',
    params: [
      { key: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 0.5 },
      { key: 'b', label: 'b', min: -4, max: 4, step: 0.2, value: 0 },
      { key: 'c', label: 'c', min: -4, max: 4, step: 0.2, value: 0 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var ox = w * 0.5, oy = h * 0.58, sx = w / 12, sy = h / 10;
      function X(x) { return ox + x * sx; }
      function Y(y) { return oy - y * sy; }
      grid(ctx, w, h, 30, 30);
      line(ctx, 0, oy, w, oy, C.axis, 1.3);
      line(ctx, ox, 0, ox, h, C.axis, 1.3);
      var a = p.a;
      if (Math.abs(a) < 0.08) { a = 0.08 * (a < 0 ? -1 : 1); }
      var pts = [], i;
      for (i = 0; i <= 200; i++) {
        var x = -6 + (i / 200) * 12;
        var y = a * x * x + p.b * x + p.c;
        if (y > 8 || y < -12) { continue; }
        pts.push([X(x), Y(y)]);
      }
      poly(ctx, pts, C.a, 2.6);
      var vx = -p.b / (2 * a), vy = a * vx * vx + p.b * vx + p.c;
      dash(ctx, X(vx), 0, X(vx), h, C.dim, 1, [4, 6]);
      dot(ctx, X(vx), Y(vy), 5.5, C.c);
      txt(ctx, '顶点 (' + fmt(vx) + ', ' + fmt(vy) + ')', X(vx) + 8, Y(vy) - 12, C.c, 12);
      txt(ctx, '对称轴 x = ' + fmt(vx), X(vx) + 8, 18, C.dim, 12);
      txt(ctx, a > 0 ? '开口向上，有最小值' : '开口向下，有最大值', 12, 18, a > 0 ? C.d : C.b, 13);
      var disc = p.b * p.b - 4 * a * p.c;
      txt(ctx, 'Δ = b²-4ac = ' + fmt(disc, 2) + (disc > 0 ? '（两个交点）' : (disc < 0 ? '（无交点）' : '（一个交点）')),
          12, h - 16, C.dim, 12);
    }
  });

  MODELS.push({
    id: 'math-conic', subject: '数学', title: '圆锥曲线的统一定义',
    desc: '动点到焦点与到准线的距离之比等于离心率 e。e<1 是椭圆，e=1 是抛物线，e>1 是双曲线。',
    params: [
      { key: 'e', label: '离心率 e', min: 0.2, max: 2.2, step: 0.05, value: 0.6 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      grid(ctx, w, h, 30, 30);
      var F = { x: w * 0.36, y: h * 0.5 };
      var l = Math.min(w * 0.22, h * 0.42) * 0.75;
      var dd = l / p.e;
      var directrix = F.x - dd;
      if (directrix > 8 && directrix < w - 8) {
        dash(ctx, directrix, 20, directrix, h - 20, C.e, 1.6, [6, 5]);
        txt(ctx, '准线', directrix + 6, 26, C.e, 12);
      }
      dot(ctx, F.x, F.y, 5, C.b);
      txt(ctx, 'F', F.x + 8, F.y - 12, C.b, 13);
      var pts = [], i;
      var lim = p.e < 1 ? Math.PI : Math.acos(-1 / p.e) - 0.02;
      for (i = 0; i <= 400; i++) {
        var th = -lim + (i / 400) * 2 * lim;
        var r = l / (1 + p.e * Math.cos(th));
        if (r > 4000 || r < 0) { continue; }
        pts.push([F.x + r * Math.cos(th), F.y - r * Math.sin(th)]);
      }
      poly(ctx, pts, C.a, 2.2);
      var thp = t * 0.7, rp = l / (1 + p.e * Math.cos(thp));
      if (rp > 0 && rp < 3000) {
        var P = { x: F.x + rp * Math.cos(thp), y: F.y - rp * Math.sin(thp) };
        line(ctx, F.x, F.y, P.x, P.y, C.b, 2);
        line(ctx, P.x, P.y, directrix, P.y, C.d, 2);
        dot(ctx, P.x, P.y, 5, C.c);
        txt(ctx, 'PF = ' + fmt(rp / 60, 2), (F.x + P.x) / 2 + 6, (F.y + P.y) / 2, C.b, 11);
        txt(ctx, 'd = ' + fmt(Math.abs(P.x - directrix) / 60, 2), (P.x + directrix) / 2, P.y - 13, C.d, 11, 'center');
      }
      var name = p.e < 0.98 ? '椭圆' : (p.e > 1.02 ? '双曲线' : '抛物线');
      txt(ctx, name + '　e = ' + fmt(p.e), 14, 22, C.c, 15);
      txt(ctx, 'PF / d = e', 14, 44, C.dim, 12);
    }
  });

  MODELS.push({
    id: 'math-derivative', subject: '数学', title: '导数的几何意义',
    desc: '割线 PQ 上的点 Q 不断靠近 P，割线的极限位置就是切线，斜率就是该点的导数值。',
    params: [
      { key: 'x0', label: '切点 x₀', min: -2, max: 2, step: 0.1, value: 0.8 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var ox = w * 0.5, oy = h * 0.62, sx = w / 7, sy = h / 7;
      function X(x) { return ox + x * sx; }
      function Y(y) { return oy - y * sy; }
      function F(x) { return x * x * x / 3 - x; }
      function dF(x) { return x * x - 1; }
      grid(ctx, w, h, 30, 30);
      line(ctx, 0, oy, w, oy, C.axis, 1.3);
      line(ctx, ox, 0, ox, h, C.axis, 1.3);
      var pts = [], i;
      for (i = 0; i <= 240; i++) {
        var x = -2.6 + (i / 240) * 5.2;
        pts.push([X(x), Y(F(x))]);
      }
      poly(ctx, pts, C.a, 2.4);
      var x0 = p.x0;
      var hh = 1.15 * Math.abs(Math.sin(t * 0.6)) + 0.02;
      var x1 = clamp(x0 + hh, -2.6, 2.6);
      var k = (F(x1) - F(x0)) / (x1 - x0);
      var y0 = F(x0);
      function seg(xa, ka, color, labeled) {
        var ya = F(x0) + ka * (xa - x0);
        var xx1 = X(-2.7), yy1 = Y(y0 + ka * (-2.7 - x0));
        var xx2 = X(2.7), yy2 = Y(y0 + ka * (2.7 - x0));
        line(ctx, xx1, yy1, xx2, yy2, color, labeled ? 2.2 : 1.6);
      }
      seg(x1, k, C.d);
      seg(0, dF(x0), C.c);
      dot(ctx, X(x0), Y(y0), 5, C.c);
      dot(ctx, X(x1), Y(F(x1)), 5, C.d);
      dash(ctx, X(x0), Y(y0), X(x1), Y(y0), C.dim, 1, [4, 4]);
      dash(ctx, X(x1), Y(y0), X(x1), Y(F(x1)), C.dim, 1, [4, 4]);
      txt(ctx, 'P', X(x0) - 14, Y(y0) + 2, C.c, 13);
      txt(ctx, 'Q', X(x1) + 8, Y(F(x1)) - 10, C.d, 13);
      txt(ctx, '切线斜率 = f′(x₀) = ' + fmt(dF(x0), 2), w - 14, 22, C.c, 13, 'right');
      txt(ctx, '割线斜率 = ' + fmt(k, 2) + '　Δx = ' + fmt(x1 - x0, 2), w - 14, 44, C.d, 12, 'right');
      txt(ctx, 'f(x) = x³/3 − x', 14, 22, C.a, 13);
    }
  });

  MODELS.push({
    id: 'math-vector', subject: '数学', title: '向量的平行四边形法则',
    desc: '两个向量始终共起点，它们的和就是平行四边形的对角线，也等于首尾相接的三角形。',
    params: [
      { key: 'len', label: '向量长度', min: 60, max: 150, step: 5, value: 110 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      grid(ctx, w, h, 32, 32);
      var O = { x: w * 0.3, y: h * 0.68 };
      var a1 = t * 0.5, a2 = t * 0.5 + 2.0;
      var L = p.len;
      var A = { x: O.x + L * Math.cos(a1), y: O.y - L * Math.sin(a1) };
      var B = { x: O.x + L * Math.cos(a2), y: O.y - L * Math.sin(a2) };
      var S = { x: A.x + B.x - O.x, y: A.y + B.y - O.y };
      dash(ctx, A.x, A.y, S.x, S.y, C.dim, 1.4);
      dash(ctx, B.x, B.y, S.x, S.y, C.dim, 1.4);
      arrow(ctx, O.x, O.y, A.x, A.y, C.a, 2.4);
      arrow(ctx, O.x, O.y, B.x, B.y, C.b, 2.4);
      arrow(ctx, O.x, O.y, S.x, S.y, C.c, 3);
      dot(ctx, O.x, O.y, 4, C.text);
      txt(ctx, 'a', (O.x + A.x) / 2 + 8, (O.y + A.y) / 2, C.a, 15);
      txt(ctx, 'b', (O.x + B.x) / 2 + 8, (O.y + B.y) / 2, C.b, 15);
      txt(ctx, 'a + b', (O.x + S.x) / 2 + 10, (O.y + S.y) / 2, C.c, 15);
      txt(ctx, '|a| = ' + fmt(L / 60, 2) + '　|b| = ' + fmt(L / 60, 2) + '　|a+b| = ' + fmt(Math.hypot(S.x - O.x, S.y - O.y) / 60, 2),
          14, 22, C.dim, 13);
      txt(ctx, 'a·b = |a||b|cos θ', 14, h - 18, C.d, 13);
    }
  });

  MODELS.push({
    id: 'math-normal', subject: '数学', title: '正态分布曲线',
    desc: 'μ 管位置，σ 管胖瘦。不管怎么调，±1σ、±2σ、±3σ 里的面积比例都是固定的。',
    params: [
      { key: 'mu', label: '均值 μ', min: -3, max: 3, step: 0.2, value: 0 },
      { key: 'sigma', label: '标准差 σ', min: 0.4, max: 2.5, step: 0.1, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var oy = h - 46, ox = w * 0.5, sx = w / 13, sy = (h - 90) * 0.8;
      function X(x) { return ox + x * sx; }
      function Y(y) { return oy - y * sy; }
      grid(ctx, w, h, 30, 30);
      line(ctx, 40, oy, w - 10, oy, C.axis, 1.3);
      var s = p.sigma, mu = p.mu;
      function pdf(x) { return Math.exp(-Math.pow(x - mu, 2) / (2 * s * s)); }
      function band(k, color) {
        var pts = [], i;
        pts.push([X(mu - k * s), oy]);
        for (i = 0; i <= 90; i++) {
          var x = mu - k * s + (i / 90) * 2 * k * s;
          pts.push([X(x), Y(pdf(x))]);
        }
        pts.push([X(mu + k * s), oy]);
        ctx.save(); ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (var j = 1; j < pts.length; j++) { ctx.lineTo(pts[j][0], pts[j][1]); }
        ctx.closePath(); ctx.globalAlpha = 0.22; ctx.fillStyle = color; ctx.fill(); ctx.restore();
      }
      band(3, C.a); band(2, C.d); band(1, C.c);
      var pts = [], i;
      for (i = 0; i <= 400; i++) {
        var x = -6.5 + (i / 400) * 13;
        pts.push([X(x), Y(pdf(x))]);
      }
      poly(ctx, pts, C.text, 2.4);
      [-3, -2, -1, 0, 1, 2, 3].forEach(function (k) {
        var x = mu + k * s;
        dash(ctx, X(x), oy, X(x), Y(pdf(x)), C.axis, 1, [4, 5]);
      });
      line(ctx, X(mu), oy, X(mu), Y(1), C.b, 1.8);
      txt(ctx, 'μ', X(mu), oy + 16, C.b, 13, 'center');
      txt(ctx, '68.3%', X(mu), Y(0.35), C.c, 12, 'center');
      txt(ctx, '95.4%', X(mu), Y(0.12), C.d, 12, 'center');
      txt(ctx, '99.7%', X(mu), Y(0.035), C.a, 12, 'center');
      txt(ctx, 'σ = ' + fmt(s) + '　μ = ' + fmt(mu), 14, 22, C.text, 14);
      txt(ctx, 'P(|X-μ|<σ) ≈ 0.683　P(|X-μ|<2σ) ≈ 0.954　P(|X-μ|<3σ) ≈ 0.997', 14, h - 18, C.dim, 12);
    }
  });

  MODELS.push({
    id: 'math-sine-transform', subject: '数学', title: 'y = A·sin(ωx+φ) 图象变换',
    desc: 'A 管振幅（上下拉伸），ω 管周期（左右压缩），φ 管左右平移，k 管上下平移。',
    params: [
      { key: 'A', label: 'A 振幅', min: 0.2, max: 2, step: 0.1, value: 1 },
      { key: 'w', label: 'ω', min: 0.5, max: 3, step: 0.1, value: 1 },
      { key: 'phi', label: 'φ', min: -3, max: 3, step: 0.1, value: 0 },
      { key: 'k', label: 'k', min: -1.5, max: 1.5, step: 0.1, value: 0 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var oy = h * 0.5, sx = w / (2 * Math.PI), sy = Math.min(h * 0.34, 130);
      function X(x) { return x * sx; }
      grid(ctx, w, h, 30, 30);
      line(ctx, 0, oy - p.k * sy, w, oy - p.k * sy, C.axis, 1.2);
      var base = [], pts = [], i;
      for (i = 0; i <= 400; i++) {
        var x = (i / 400) * 2 * Math.PI;
        base.push([X(x), oy - Math.sin(x) * sy * 0.5 - p.k * sy]);
        pts.push([X(x), oy - (p.A * Math.sin(p.w * x + p.phi) + p.k) * sy]);
      }
      poly(ctx, base, C.dim, 1.4);
      poly(ctx, pts, C.a, 2.6);
      var T = 2 * Math.PI / p.w;
      var px = (t * 0.6) % (2 * Math.PI);
      var py = oy - (p.A * Math.sin(p.w * px + p.phi) + p.k) * sy;
      dot(ctx, X(px), py, 5.5, C.c);
      dash(ctx, X(px), py, X(px), oy, C.c, 1, [4, 4]);
      txt(ctx, 'y = ' + fmt(p.A) + '·sin(' + fmt(p.w) + 'x + ' + fmt(p.phi) + ') + ' + fmt(p.k), 14, 22, C.a, 14);
      txt(ctx, '振幅 ' + fmt(p.A) + '　周期 T = 2π/ω = ' + fmt(T) + '　初相 φ = ' + fmt(p.phi), 14, 46, C.dim, 12);
    }
  });

  window.MODEL_KIT = {
    C: C, clear: clear, font: font, txt: txt, line: line, dash: dash, dot: dot,
    arrow: arrow, poly: poly, circle: circle, grid: grid, axes: axes,
    clamp: clamp, fmt: fmt, MODELS: MODELS
  };
  window.MODELS = MODELS;
})();

(function () {
  'use strict';
  var K = window.MODEL_KIT, C = K.C, txt = K.txt, line = K.line, dash = K.dash;
  var dot = K.dot, arrow = K.arrow, poly = K.poly, circle = K.circle, grid = K.grid,
      axes = K.axes, clamp = K.clamp, fmt = K.fmt, clear = K.clear;
  var G = 9.8;

  K.MODELS.push({
    id: 'phy-projectile', subject: '物理', title: '平抛运动',
    desc: '水平方向匀速直线、竖直方向自由落体，两个分运动合起来就是抛物线。速度方向始终是轨迹的切线。',
    params: [
      { key: 'v0', label: '初速度 v₀ (m/s)', min: 1, max: 10, step: 0.2, value: 4 },
      { key: 'H', label: '抛出高度 (m)', min: 5, max: 45, step: 1, value: 20 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var T = Math.sqrt(2 * p.H / G), R = p.v0 * T;
      var ox = w * 0.1, oy = h * 0.14;
      var s = Math.min((w * 0.82) / Math.max(R, 0.001), (h * 0.7) / p.H);
      var gy = oy + p.H * s;
      line(ctx, 0, gy, w, gy, C.axis, 2);
      txt(ctx, '地面', w - 10, gy + 16, C.dim, 12, 'right');
      dash(ctx, ox, oy, ox, gy, C.axis, 1, [4, 5]);
      txt(ctx, '抛出点', ox + 6, oy - 12, C.dim, 11);
      dash(ctx, ox, oy, ox + R * s, oy, C.axis, 1, [4, 5]);
      var tt = (t * 0.75) % (T * 1.4);
      var te = clamp(tt, 0, T);
      var bx = ox + p.v0 * te * s, by = oy + 0.5 * G * te * te * s;
      var pts = [], i;
      for (i = 0; i <= 120; i++) {
        var ti = (i / 120) * T;
        pts.push([ox + p.v0 * ti * s, oy + 0.5 * G * ti * ti * s]);
      }
      poly(ctx, pts, C.dim, 1.6);
      var trail = [];
      for (i = 0; i <= 60; i++) {
        var tj = (i / 60) * te;
        trail.push([ox + p.v0 * tj * s, oy + 0.5 * G * tj * tj * s]);
      }
      poly(ctx, trail, C.a, 2.4);
      dash(ctx, bx, by, bx, gy, C.d, 1.4);
      dash(ctx, ox, by, bx, by, C.b, 1.4);
      dot(ctx, bx, gy, 4.5, C.d);
      dot(ctx, ox, by, 4.5, C.b);
      dot(ctx, bx, by, 6, C.c);
      var vx = p.v0, vy = G * te;
      var vs = s * 0.18;
      arrow(ctx, bx, by, bx + vx * vs, by, C.d, 2);
      arrow(ctx, bx, by, bx, by + vy * vs, C.b, 2);
      arrow(ctx, bx, by, bx + vx * vs, by + vy * vs, C.c, 2.4);
      txt(ctx, 'v₀ = ' + fmt(vx, 1), bx + 90, by - 12, C.d, 11);
      txt(ctx, 'v_y = gt', bx + 8, by + vy * vs * 0.5, C.b, 11);
      txt(ctx, 't = ' + fmt(te, 2) + ' s', 14, 22, C.text, 14);
      txt(ctx, '水平 x = v₀t = ' + fmt(vx * te, 2) + ' m　竖直 y = ½gt² = ' + fmt(0.5 * G * te * te, 2) + ' m',
          14, 44, C.dim, 12);
      txt(ctx, '落地时间 T = √(2h/g) = ' + fmt(T, 2) + ' s　落点水平距离 ' + fmt(R, 2) + ' m', 14, 64, C.a, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-oblique', subject: '物理', title: '斜抛运动',
    desc: '初速度分解成水平匀速和竖直上抛，轨迹是对称的抛物线。45° 时射程最大。',
    params: [
      { key: 'v0', label: '初速度 v₀ (m/s)', min: 6, max: 28, step: 0.5, value: 18 },
      { key: 'deg', label: '抛射角 θ (°)', min: 10, max: 80, step: 1, value: 45 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var rad = p.deg * Math.PI / 180;
      var vx = p.v0 * Math.cos(rad), vy = p.v0 * Math.sin(rad);
      var T = 2 * vy / G, R = vx * T, H = vy * vy / (2 * G);
      var ox = w * 0.1, oy = h * 0.86;
      var s = Math.min((w * 0.84) / Math.max(R, 0.001), (h * 0.72) / Math.max(H, 0.001));
      line(ctx, 0, oy, w, oy, C.axis, 2);
      var pts = [], i;
      for (i = 0; i <= 140; i++) {
        var ti = (i / 140) * T;
        pts.push([ox + vx * ti * s, oy - (vy * ti - 0.5 * G * ti * ti) * s]);
      }
      poly(ctx, pts, C.dim, 1.6);
      var te = (t * 0.6) % (T * 1.25), tc = clamp(te, 0, T);
      var bx = ox + vx * tc * s, by = oy - (vy * tc - 0.5 * G * tc * tc) * s;
      var trail = [];
      for (i = 0; i <= 60; i++) {
        var tj = (i / 60) * tc;
        trail.push([ox + vx * tj * s, oy - (vy * tj - 0.5 * G * tj * tj) * s]);
      }
      poly(ctx, trail, C.a, 2.6);
      dash(ctx, ox, oy, ox + R * s, oy, C.c, 1.4, [6, 5]);
      dash(ctx, bx, by, bx, oy, C.dim, 1, [4, 5]);
      dot(ctx, bx, by, 6, C.c);
      dot(ctx, ox, oy, 4, C.text);
      arrow(ctx, ox, oy, ox + vx * s * 0.55, oy - vy * s * 0.55, C.d, 2.2);
      txt(ctx, 'v₀', ox + 30, oy - 34, C.d, 13);
      txt(ctx, '射程 R = ' + fmt(R, 1) + ' m', ox + R * s * 0.5, oy + 18, C.c, 12, 'center');
      txt(ctx, '最大高度 H = ' + fmt(H, 1) + ' m', ox + R * s * 0.5, 20, C.a, 12, 'center');
      txt(ctx, 'θ = ' + p.deg + '°　飞行时间 T = ' + fmt(T, 2) + ' s', 14, h - 18, C.text, 13);
      if (Math.abs(p.deg - 45) <= 1) { txt(ctx, '45° 时射程最大', w - 14, h - 18, C.d, 13, 'right'); }
    }
  });

  K.MODELS.push({
    id: 'phy-circular', subject: '物理', title: '匀速圆周运动与向心力',
    desc: '速度始终沿切线，大小不变方向一直在变；向心力始终指向圆心，只改变方向不改变速率。',
    params: [
      { key: 'w', label: '角速度 ω', min: 0.4, max: 3, step: 0.1, value: 1.2 },
      { key: 'r', label: '半径 r', min: 50, max: 130, step: 5, value: 95 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var cx = w * 0.5, cy = h * 0.5, R = p.r;
      circle(ctx, cx, cy, R, C.axis, 1.6);
      dot(ctx, cx, cy, 4, C.text);
      txt(ctx, '圆心 O', cx + 8, cy + 14, C.dim, 12);
      var th = p.w * t;
      var px = cx + R * Math.cos(th), py = cy - R * Math.sin(th);
      var v = p.w * R;
      var tx = -Math.sin(th), ty = -Math.cos(th);
      arrow(ctx, px, py, px + tx * 62, py + ty * 62, C.d, 2.6);
      txt(ctx, 'v', px + tx * 74, py + ty * 74, C.d, 14, 'center');
      arrow(ctx, px, py, cx, cy, C.b, 2.6);
      txt(ctx, 'F 向心', (px + cx) / 2 + 10, (py + cy) / 2 - 10, C.b, 13);
      dash(ctx, px, py, cx, cy, C.dim, 1, [4, 4]);
      dot(ctx, px, py, 6.5, C.c);
      var arc = [];
      for (var i = 0; i <= 24; i++) {
        var ai = th - 1.1 + (i / 24) * 1.1;
        arc.push([cx + (R + 26) * Math.cos(ai), cy - (R + 26) * Math.sin(ai)]);
      }
      poly(ctx, arc, C.a, 2);
      txt(ctx, 'ω', cx + (R + 44) * Math.cos(th - 0.55), cy - (R + 44) * Math.sin(th - 0.55), C.a, 14, 'center');
      txt(ctx, 'v = ωr = ' + fmt(v / 60, 2) + '　a = ω²r = ' + fmt(p.w * p.w * R / 60, 2), 14, 22, C.text, 13);
      txt(ctx, 'T = 2π/ω = ' + fmt(2 * Math.PI / p.w, 2) + ' s', 14, 44, C.dim, 12);
      txt(ctx, '向心力永远垂直于速度', 14, h - 18, C.b, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-shm', subject: '物理', title: '简谐运动（弹簧振子）',
    desc: '位移、速度、加速度都是正弦规律；加速度总指向平衡位置，且与位移成正比反向。',
    params: [
      { key: 'A', label: '振幅 A', min: 20, max: 70, step: 2, value: 52 },
      { key: 'w', label: '角频率 ω', min: 0.4, max: 3, step: 0.1, value: 1.2 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var eq = w * 0.24, cy = h * 0.32;
      var x = p.A * Math.cos(p.w * t);
      var bx = eq + x;
      dash(ctx, eq, cy - 70, eq, cy + 70, C.axis, 1.2, [5, 5]);
      txt(ctx, '平衡位置', eq, cy + 82, C.dim, 11, 'center');
      line(ctx, eq - 150, cy, eq - 60, cy, C.axis, 1);
      var coil = [], i;
      for (i = 0; i <= 60; i++) {
        var u = i / 60;
        var sx = (eq - 150) + u * (bx - 30 - (eq - 150));
        coil.push([sx, cy + Math.sin(u * 22) * 9]);
      }
      poly(ctx, coil, C.d, 2);
      ctx.fillStyle = '#2b3a52';
      ctx.fillRect(bx - 28, cy - 26, 56, 52);
      ctx.strokeStyle = C.c; ctx.lineWidth = 2;
      ctx.strokeRect(bx - 28, cy - 26, 56, 52);
      txt(ctx, 'm', bx, cy, C.text, 15, 'center');
      var v = -p.A * p.w * Math.sin(p.w * t);
      var acc = -p.w * p.w * p.A * Math.cos(p.w * t);
      arrow(ctx, bx, cy - 46, bx + v * 0.5, cy - 46, C.a, 2);
      txt(ctx, 'v', bx + v * 0.5 + 10, cy - 46, C.a, 12);
      arrow(ctx, bx, cy + 46, bx + acc * 0.35, cy + 46, C.b, 2);
      txt(ctx, 'a', bx + acc * 0.35 + 10, cy + 46, C.b, 12);
      var gx = w * 0.52, gy = h * 0.74, gsx = (w - gx - 26) / 8, gsy = 62;
      line(ctx, gx, gy, w - 12, gy, C.axis, 1.4);
      line(ctx, gx, gy - 70, gx, gy + 70, C.axis, 1.4);
      var pts = [], trail = [];
      for (i = 0; i <= 240; i++) {
        var ti = (i / 240) * 8;
        pts.push([gx + ti * gsx, gy - p.A * Math.cos(p.w * ti) / 60 * gsy]);
      }
      poly(ctx, pts, C.dim, 1.4);
      var tNow = t % 8;
      for (i = 0; i <= 120; i++) {
        var tj = (i / 120) * tNow;
        trail.push([gx + tj * gsx, gy - p.A * Math.cos(p.w * tj) / 60 * gsy]);
      }
      poly(ctx, trail, C.c, 2.4);
      dot(ctx, gx + tNow * gsx, gy - p.A * Math.cos(p.w * tNow) / 60 * gsy, 5, C.c);
      txt(ctx, 'x = A·cos(ωt)', gx + 8, gy - 92, C.c, 13);
      txt(ctx, 'x = ' + fmt(x / 60, 2) + '　v = ' + fmt(v / 60, 2) + '　a = ' + fmt(acc / 60, 2), 14, h - 18, C.text, 12);
      txt(ctx, 'T = 2π/ω = ' + fmt(2 * Math.PI / p.w, 2) + ' s', 14, 22, C.a, 13);
    }
  });

  K.MODELS.push({
    id: 'phy-wave', subject: '物理', title: '横波的传播',
    desc: '波向前传播，介质中的每个质点只在原地上下振动，并不跟着波一起跑。',
    params: [
      { key: 'A', label: '振幅 A', min: 15, max: 60, step: 2, value: 38 },
      { key: 'lam', label: '波长 λ', min: 90, max: 260, step: 10, value: 170 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var mid = h * 0.46, k = 2 * Math.PI / p.lam, om = k * 90;
      line(ctx, 0, mid, w, mid, C.axis, 1.4);
      var pts = [], i;
      for (i = 0; i <= 320; i++) {
        var x = (i / 320) * w;
        pts.push([x, mid - p.A * Math.sin(k * x - om * t)]);
      }
      poly(ctx, pts, C.a, 2.6);
      var markX = w * 0.42;
      var my = mid - p.A * Math.sin(k * markX - om * t);
      dot(ctx, markX, my, 6.5, C.b);
      dash(ctx, markX, mid - p.A - 16, markX, mid + p.A + 20, C.b, 1.2, [4, 4]);
      arrow(ctx, markX, mid + p.A + 34, markX, mid - p.A - 30, C.b, 1.6);
      txt(ctx, '质点只上下振动', markX + 10, mid + p.A + 40, C.b, 12);
      var l0 = w * 0.5;
      line(ctx, l0, mid - p.A - 46, l0 + p.lam, mid - p.A - 46, C.c, 2);
      txt(ctx, 'λ', l0 + p.lam / 2, mid - p.A - 60, C.c, 14, 'center');
      arrow(ctx, w - 40, mid + 10, w - 130, mid + 10, C.d, 2.4);
      txt(ctx, '波速方向', w - 86, mid + 26, C.d, 12, 'center');
      txt(ctx, 'λ = ' + fmt(p.lam / 60, 2) + '　T = λ/v', 14, 22, C.text, 13);
      txt(ctx, 'y = A·sin(kx - ωt)', 14, 44, C.a, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-efield', subject: '物理', title: '等量异种电荷的电场线与等势面',
    desc: '电场线从正电荷出发终止于负电荷，密的地方电场强；虚线圈是等势面，处处与电场线垂直。',
    params: [
      { key: 'sep', label: '电荷间距', min: 120, max: 320, step: 10, value: 220 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var cy = h * 0.5, cx = w * 0.5, d = p.sep / 2;
      var P = { x: cx - d, y: cy }, N = { x: cx + d, y: cy };
      function field(x, y) {
        var ex = 0, ey = 0, i, ch = [
          { x: P.x, y: P.y, q: 1 }, { x: N.x, y: N.y, q: -1 }
        ];
        for (i = 0; i < ch.length; i++) {
          var dx = x - ch[i].x, dy = y - ch[i].y;
          var r2 = dx * dx + dy * dy + 4, r = Math.sqrt(r2);
          ex += ch[i].q * dx / (r2 * r); ey += ch[i].q * dy / (r2 * r);
        }
        var m = Math.hypot(ex, ey) || 1;
        return { x: ex / m, y: ey / m };
      }
      for (var a = 0; a < 12; a++) {
        var ang = (a / 12) * Math.PI * 2 + 0.26;
        var x = P.x + Math.cos(ang) * 9, y = P.y + Math.sin(ang) * 9;
        var path = [[x, y]];
        for (var s = 0; s < 420; s++) {
          var f = field(x, y);
          x += f.x * 3.2; y += f.y * 3.2;
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) { break; }
          path.push([x, y]);
          if (Math.hypot(x - N.x, y - N.y) < 10) { break; }
        }
        poly(ctx, path, 'rgba(78,161,255,0.55)', 1.3);
        if (a === 0 || a === 6) {
          var idx = Math.floor(((t * 40 + a * 90) % (path.length - 1)));
          if (path[idx]) { dot(ctx, path[idx][0], path[idx][1], 3.4, C.d); }
        }
      }
      [40, 76, 112, 148].forEach(function (r) {
        ctx.save(); ctx.setLineDash([5, 6]);
        circle(ctx, P.x, P.y, r, 'rgba(255,209,102,0.45)', 1.2);
        circle(ctx, N.x, N.y, r, 'rgba(255,209,102,0.45)', 1.2);
        ctx.restore();
      });
      dot(ctx, P.x, P.y, 15, C.b); txt(ctx, '+', P.x, P.y, '#fff', 20, 'center');
      dot(ctx, N.x, N.y, 15, C.a); txt(ctx, '−', N.x, N.y, '#fff', 20, 'center');
      txt(ctx, '电场线（蓝）从正到负　等势面（黄虚线圈）与电场线垂直', 14, 22, C.text, 13);
      txt(ctx, '沿电场线方向电势降低', 14, h - 18, C.d, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-lorentz', subject: '物理', title: '带电粒子在匀强磁场中的运动',
    desc: '速度垂直于磁场时，洛伦兹力始终垂直于速度，粒子做匀速圆周运动，半径 r = mv/(qB)。',
    params: [
      { key: 'r', label: '半径 r', min: 40, max: 130, step: 5, value: 90 },
      { key: 'w', label: '角速度', min: 0.4, max: 2.4, step: 0.1, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var i;
      for (i = 18; i < w; i += 44) {
        for (var j = 18; j < h; j += 44) {
          line(ctx, i - 4, j - 4, i + 4, j + 4, 'rgba(125,141,165,0.5)', 1.4);
          line(ctx, i - 4, j + 4, i + 4, j - 4, 'rgba(125,141,165,0.5)', 1.4);
        }
      }
      txt(ctx, '磁场 B 垂直纸面向里', 14, 22, C.dim, 12);
      var cx = w * 0.5, cy = h * 0.55, R = p.r;
      ctx.save(); ctx.setLineDash([5, 5]);
      circle(ctx, cx, cy, R, 'rgba(94,224,160,0.4)', 1.4); ctx.restore();
      var th = p.w * t;
      var px = cx + R * Math.cos(th), py = cy + R * Math.sin(th);
      var tx = -Math.sin(th), ty = Math.cos(th);
      arrow(ctx, px, py, px + tx * 54, py + ty * 54, C.d, 2.6);
      txt(ctx, 'v', px + tx * 66, py + ty * 66, C.b, 0, 'center');
      txt(ctx, 'v', px + tx * 66, py + ty * 66, C.d, 13, 'center');
      arrow(ctx, px, py, cx, cy, C.b, 2.4);
      txt(ctx, 'F', (px + cx) / 2 - 4, (py + cy) / 2 - 10, C.b, 13, 'center');
      dot(ctx, px, py, 6.5, C.c);
      dot(ctx, cx, cy, 3.5, C.text);
      txt(ctx, 'r = mv/(qB)', 14, h - 40, C.text, 13);
      txt(ctx, '洛伦兹力不做功，速率不变，只改变方向', 14, h - 18, C.d, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-induction', subject: '物理', title: '导体棒切割磁感线',
    desc: '导体棒在磁场中运动，磁通量变化产生感应电动势 E = BLv，右手定则判断电流方向。',
    params: [
      { key: 'v', label: '速度 v', min: 0.3, max: 2.4, step: 0.1, value: 1 },
      { key: 'len', label: '棒长 L', min: 60, max: 150, step: 10, value: 110 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var i, j;
      for (i = 20; i < w; i += 46) {
        for (j = 20; j < h; j += 46) {
          line(ctx, i - 4, j - 4, i + 4, j + 4, 'rgba(125,141,165,0.42)', 1.3);
          line(ctx, i - 4, j + 4, i + 4, j - 4, 'rgba(125,141,165,0.42)', 1.3);
        }
      }
      var top = h * 0.3, L = p.len;
      var left = w * 0.18, right = w * 0.88;
      line(ctx, left, top, right, top, C.text, 3);
      line(ctx, left, top + L, right, top + L, C.text, 3);
      var cyc = t * p.v;
      var rodX = left + ((cyc * 60) % (right - left - 40)) + 40;
      line(ctx, left, top, left, top + L, C.text, 3);
      ctx.fillStyle = '#f0b429';
      ctx.fillRect(rodX - 4, top, 8, L);
      arrow(ctx, rodX + 16, top + L / 2, rodX + 58, top + L / 2, C.d, 2.4);
      txt(ctx, 'v', rodX + 34, top + L / 2 - 14, C.d, 14);
      var dir = (cyc % ((right - left - 40) / 60)) < ((right - left - 40) / 120) ? 1 : -1;
      var arrows = 6, k;
      for (k = 0; k < arrows; k++) {
        var yy = top + (k + 0.5) * (L / arrows);
        arrow(ctx, rodX - 12 * dir, yy, rodX - 40 * dir, yy, C.b, 1.6);
      }
      txt(ctx, '感应电流方向', rodX - 60, top - 16, C.b, 12, 'center');
      txt(ctx, 'E = BLv = ' + fmt(p.len / 60 * p.v, 2) + ' V（示意值）', 14, 22, C.text, 13);
      txt(ctx, '磁通量变化 → 感应电动势 → 感应电流（楞次定律）', 14, h - 18, C.dim, 12);
    }
  });

  K.MODELS.push({
    id: 'phy-momentum', subject: '物理', title: '动量守恒——一维碰撞',
    desc: '碰撞前后总动量永远不变。恢复系数 e = 1 是弹性碰撞（动能也守恒），e = 0 是完全非弹性碰撞（粘在一起）。',
    params: [
      { key: 'e', label: '恢复系数 e', min: 0, max: 1, step: 0.05, value: 0.9 },
      { key: 'm2', label: 'm₂ (kg)', min: 0.5, max: 4, step: 0.1, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var m1 = 1, m2 = p.m2, v1 = 120, v2 = -60;
      var r1 = 14 * Math.pow(m1, 0.34), r2 = 14 * Math.pow(m2, 0.34);
      var x1 = w * 0.2, x2 = w * 0.8;
      var tc = (x2 - r2 - (x1 + r1)) / (v1 - v2);
      var u1 = ((m1 - p.e * m2) * v1 + (1 + p.e) * m2 * v2) / (m1 + m2);
      var u2 = ((m2 - p.e * m1) * v2 + (1 + p.e) * m1 * v1) / (m1 + m2);
      var period = (w * 1.15) / Math.max(Math.abs(u2), 1);
      var span = tc + period;
      var tt = (t * 60) % span;
      var PX1, PX2, CV1, CV2;
      if (tt < tc) { PX1 = x1 + v1 * tt; PX2 = x2 + v2 * tt; CV1 = v1; CV2 = v2; }
      else { PX1 = x1 + v1 * tc + u1 * (tt - tc); PX2 = x2 + v2 * tc + u2 * (tt - tc); CV1 = u1; CV2 = u2; }
      var track = h * 0.52;
      line(ctx, 0, track + 30, w, track + 30, C.axis, 2.4);
      dot(ctx, PX1, track, r1, C.a); txt(ctx, 'm₁', PX1, track, '#fff', 12, 'center');
      dot(ctx, PX2, track, r2, C.b); txt(ctx, 'm₂', PX2, track, '#fff', 12, 'center');
      arrow(ctx, PX1, track - r1 - 14, PX1 + CV1 * 0.35, track - r1 - 14, C.d, 2);
      arrow(ctx, PX2, track - r2 - 14, PX2 + CV2 * 0.35, track - r2 - 14, C.d, 2);
      var baseY = h - 34, barH = 18;
      txt(ctx, '碰撞前后总动量始终相等：', 14, baseY - 62, C.text, 12);
      var scaleB = 34 / 60;
      function bar(y, label, p11, p22, color1, color2) {
        var x0 = 150;
        txt(ctx, label, 14, y + barH / 2, C.dim, 12);
        var w1 = p11 * scaleB, w2 = p22 * scaleB;
        ctx.fillStyle = color1; ctx.fillRect(x0, y, w1, barH);
        ctx.fillStyle = color2; ctx.fillRect(x0 + w1, y, w2, barH);
        txt(ctx, '合计 ' + fmt(p11 + p22, 1), x0 + w1 + w2 + 10, y + barH / 2, C.text, 11);
      }
      var before1 = m1 * v1 / 60, before2 = m2 * v2 / 60;
      var after1 = m1 * (tt < tc ? v1 : u1) / 60, after2 = m2 * (tt < tc ? v2 : u2) / 60;
      bar(h - 84, '碰撞前', before1, before2, C.a, C.b);
      bar(h - 60, '碰撞后', after1, after2, C.a, C.b);
      txt(ctx, 'e = ' + fmt(p.e) + (p.e > 0.98 ? '　弹性碰撞，动能守恒' : (p.e < 0.02 ? '　完全非弹性碰撞，粘在一起' : '　非弹性碰撞，有动能损失')),
          14, 22, C.c, 13);
    }
  });
})();

(function () {
  'use strict';
  var K = window.MODEL_KIT, C = K.C, txt = K.txt, line = K.line, dash = K.dash;
  var dot = K.dot, arrow = K.arrow, poly = K.poly, circle = K.circle, grid = K.grid,
      clamp = K.clamp, fmt = K.fmt, clear = K.clear;

  K.MODELS.push({
    id: 'chem-shells', subject: '化学', title: '原子核外电子分层排布',
    desc: '电子由内到外分层排布，每层最多 2n² 个。最外层电子数决定元素的主要化学性质。',
    params: [
      { key: 'z', label: '元素', type: 'select', value: 6,
        options: [['H 氢', 1], ['C 碳', 6], ['O 氧', 8], ['Na 钠', 11], ['Cl 氯', 17], ['Ca 钙', 20]] }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var z = p.z | 0;
      var caps = [2, 8, 8, 2], left = z, shells = [], i;
      for (i = 0; i < caps.length && left > 0; i++) {
        var n = Math.min(caps[i], left); shells.push(n); left -= n;
      }
      var cx = w * 0.42, cy = h * 0.5;
      var protons = z, neutrons = Math.round(z === 1 ? 0 : z * 1.05);
      circle(ctx, cx, cy, 22, C.b, 2, 'rgba(255,107,107,0.18)');
      txt(ctx, '+' + protons, cx, cy - 7, C.b, 15, 'center');
      txt(ctx, 'n ' + neutrons, cx, cy + 10, C.dim, 11, 'center');
      var step = Math.min(48, (Math.min(w, h) * 0.42) / Math.max(shells.length, 1));
      var names = ['K', 'L', 'M', 'N'];
      for (i = 0; i < shells.length; i++) {
        var R = 40 + i * step;
        ctx.save(); ctx.setLineDash([4, 6]);
        circle(ctx, cx, cy, R, 'rgba(78,161,255,0.35)', 1.3);
        ctx.restore();
        txt(ctx, names[i], cx + R - 4, cy - 10, C.dim, 11, 'center');
        for (var e = 0; e < shells[i]; e++) {
          var ang = (e / shells[i]) * Math.PI * 2 + t * (0.5 + i * 0.18) * (i % 2 ? -1 : 1);
          dot(ctx, cx + R * Math.cos(ang), cy + R * Math.sin(ang), 5, C.d);
        }
      }
      var px = w * 0.74;
      txt(ctx, '电子排布', px, 40, C.text, 13);
      for (i = 0; i < shells.length; i++) {
        txt(ctx, names[i] + ' 层：' + shells[i] + ' 个电子', px, 68 + i * 24, C.a, 13);
      }
      txt(ctx, '最外层 ' + shells[shells.length - 1] + ' 个电子', px, 68 + shells.length * 24 + 10,
          shells[shells.length - 1] === 8 || shells.length === 1 ? C.d : C.c, 13);
      txt(ctx, '每层最多 2n² 个（K2 L8 M18 N32）', 14, h - 18, C.dim, 12);
    }
  });

  var VSEPR = {
    'CO₂ 二氧化碳（直线形）': { dirs: [[1, 0, 0], [-1, 0, 0]], angle: '180°', lone: 0, mode: 'planar' },
    'BF₃ 三氟化硼（平面三角）': { dirs: [[1, 0, 0], [-0.5, 0, 0.866], [-0.5, 0, -0.866]], angle: '120°', lone: 0, mode: 'planar' },
    'CH₄ 甲烷（正四面体）': { dirs: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], angle: '109.5°', lone: 0, mode: 'tetra' },
    'NH₃ 氨（三角锥形）': { dirs: [[1, -0.6, 1], [-1, -0.6, 1], [0, -0.6, -1.2]], angle: '107°', lone: 1, mode: 'tetra' },
    'H₂O 水（V 形）': { dirs: [[1, 0.7, 0.6], [-1, 0.7, 0.6]], angle: '104.5°', lone: 2, mode: 'tetra' }
  };

  K.MODELS.push({
    id: 'chem-vsepr', subject: '化学', title: '分子空间构型（VSEPR）',
    desc: '价层电子对互相排斥、尽量远离，决定了分子的立体形状。孤对电子会把键角压小。',
    params: [
      { key: 'which', label: '分子', type: 'select', value: 'CH₄ 甲烷（正四面体）',
        options: Object.keys(VSEPR).map(function (k) { return [k, k]; }) }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var spec = VSEPR[p.which] || VSEPR['CH₄ 甲烷（正四面体）'];
      var cx = w * 0.46, cy = h * 0.52;
      var ang = t * 0.55, ca = Math.cos(ang), sa = Math.sin(ang);
      function proj(v) {
        var x = v[0] * ca - v[2] * sa, z = v[0] * sa + v[2] * ca, y = v[1];
        var per = 1 / (1 + z * 0.28);
        return [cx + x * 120 * per, cy - y * 120 * per, z];
      }
      var centers = spec.dirs.map(proj);
      centers.sort(function (a, b) { return a[2] - b[2]; });
      for (var i = 0; i < centers.length; i++) {
        var c = centers[i];
        line(ctx, cx, cy, c[0], c[1], c[2] > 0 ? 'rgba(207,217,232,0.45)' : C.text, 3);
      }
      for (i = 0; i < centers.length; i++) {
        var q = centers[i];
        var isH = p.which.indexOf('H₂O') === 0 || p.which.indexOf('NH₃') === 0 || p.which.indexOf('CH₄') === 0;
        dot(ctx, q[0], q[1], 12, isH ? C.text : C.d);
        txt(ctx, isH ? 'H' : (p.which.indexOf('BF₃') === 0 ? 'F' : 'O'), q[0], q[1], C.bg, 12, 'center');
      }
      dot(ctx, cx, cy, 17, p.which.indexOf('CO₂') === 0 ? C.a : (p.which.indexOf('BF₃') === 0 ? C.e : C.e));
      var central = p.which.indexOf('CO₂') === 0 ? 'C' : (p.which.indexOf('BF₃') === 0 ? 'B' : (p.which.indexOf('CH₄') === 0 ? 'C' : (p.which.indexOf('NH₃') === 0 ? 'N' : 'O')));
      txt(ctx, central, cx, cy, '#101820', 14, 'center');
      for (i = 0; i < spec.lone; i++) {
        var la = ang + 1.2 + i * 2.1;
        var lx = cx + Math.cos(la) * 34, ly = cy - 58 - i * 12;
        dot(ctx, lx, ly, 5, C.c); dot(ctx, lx + 10, ly, 5, C.c);
      }
      if (spec.lone) { txt(ctx, '孤对电子 ×' + spec.lone, cx + 46, cy - 62, C.c, 12); }
      txt(ctx, '键角约 ' + spec.angle, 14, 24, C.text, 14);
      txt(ctx, p.which, 14, 48, C.e, 13);
      txt(ctx, '孤对电子对成键电子对的排斥更强，所以键角被压小', 14, h - 18, C.dim, 12);
    }
  });

  K.MODELS.push({
    id: 'chem-equilibrium', subject: '化学', title: '化学平衡的移动',
    desc: 'N₂O₄ ⇌ 2NO₂ 是吸热反应。升温平衡向正反应方向移动，NO₂ 变多，颜色变深。',
    params: [
      { key: 'temp', label: '温度', min: 0, max: 100, step: 1, value: 25 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var target = 0.2 + (p.temp / 100) * 0.68;
      var start = 0.2 + (25 / 100) * 0.68;
      var prog = 1 - Math.exp(-t * 0.9);
      var frac = start + (target - start) * prog;
      var cNo2 = frac, cN2o4 = 1 - frac * 0.72;
      var boxY = 62, boxH = 120, boxW = Math.min(190, w * 0.3);
      var r = Math.round(60 + frac * 190), g2 = Math.round(72 + (1 - frac) * 40), b = Math.round(150 - frac * 130);
      ctx.fillStyle = 'rgb(' + r + ',' + g2 + ',' + b + ')';
      ctx.fillRect(24, boxY, boxW, boxH);
      ctx.strokeStyle = C.axis; ctx.lineWidth = 1.5; ctx.strokeRect(24, boxY, boxW, boxH);
      var i, j;
      for (i = 0; i < 14; i++) {
        var bx = 40 + ((i * 37 + t * 26) % (boxW - 30));
        var by = boxY + 18 + ((i * 53 + Math.sin(t + i) * 12) % (boxH - 34));
        var isNo2 = (i / 14) < frac;
        dot(ctx, bx, by, isNo2 ? 6 : 9, isNo2 ? '#ff6b6b' : 'rgba(207,217,232,0.85)');
      }
      txt(ctx, '混合气体颜色', 24, boxY - 14, C.dim, 12);
      txt(ctx, 'NO₂ 越多颜色越深', 24, boxY + boxH + 16, C.dim, 11);
      var bx0 = 24 + boxW + 46, bw = Math.min(300, w - bx0 - 30);
      function concBar(y, label, val, color) {
        txt(ctx, label, bx0, y + 9, C.text, 12);
        ctx.fillStyle = C.grid; ctx.fillRect(bx0 + 66, y, bw, 18);
        ctx.fillStyle = color; ctx.fillRect(bx0 + 66, y, bw * clamp(val, 0, 1), 18);
      }
      concBar(boxY + 6, 'c(NO₂)', cNo2, C.b);
      concBar(boxY + 40, 'c(N₂O₄)', cN2o4, C.a);
      txt(ctx, 'N₂O₄ ⇌ 2NO₂　ΔH > 0（吸热）', bx0, boxY + 90, C.c, 14);
      var shift = target - start;
      txt(ctx, Math.abs(shift) < 0.02 ? '温度没变，平衡不动' :
          (shift > 0 ? '升温 → 平衡向正反应（吸热）方向移动' : '降温 → 平衡向逆反应（放热）方向移动'),
          bx0, boxY + 118, shift > 0 ? C.d : C.a, 13);
      txt(ctx, '温度 ' + p.temp + ' ℃', 14, 24, C.text, 14);
      txt(ctx, '勒夏特列原理：改变条件时，平衡向减弱这种改变的方向移动', 14, h - 18, C.dim, 12);
    }
  });

  K.MODELS.push({
    id: 'chem-titration', subject: '化学', title: '酸碱中和滴定曲线',
    desc: '0.1 mol/L 盐酸 20 mL 用 0.1 mol/L NaOH 滴定。临近滴定终点时 pH 发生突跃，酚酞刚好变色。',
    params: [
      { key: 'vol', label: '已加入 NaOH (mL)', min: 0, max: 40, step: 0.5, value: 0 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      function ph(V) {
        var acid = 0.1 * 20 - 0.1 * V, total = 20 + V;
        if (Math.abs(acid) < 1e-9) { return 7; }
        if (acid > 0) { return -Math.log10(acid / total); }
        var oh = -acid / total;
        return 14 + Math.log10(oh);
      }
      var gx = 66, gy = h - 52, gw = w - gx - 30, gh = h - 96;
      line(ctx, gx, gy, gx + gw, gy, C.axis, 1.4);
      line(ctx, gx, gy, gx, gy - gh, C.axis, 1.4);
      function X(v) { return gx + (v / 40) * gw; }
      function Y(v) { return gy - (v / 14) * gh; }
      for (var i = 0; i <= 14; i += 2) {
        dash(ctx, gx, Y(i), gx + gw, Y(i), 'rgba(65,83,107,0.55)', 1, [3, 5]);
        txt(ctx, String(i), gx - 8, Y(i), C.dim, 11, 'right');
      }
      [0, 10, 20, 30, 40].forEach(function (v) { txt(ctx, String(v), X(v), gy + 14, C.dim, 11, 'center'); });
      txt(ctx, 'V(NaOH)/mL', gx + gw / 2, gy + 32, C.dim, 12, 'center');
      txt(ctx, 'pH', gx - 8, gy - gh - 14, C.dim, 12, 'right');
      var pts = [];
      for (i = 0; i <= 400; i++) { var v = (i / 400) * 40; pts.push([X(v), Y(ph(v))]); }
      poly(ctx, pts, C.dim, 1.6);
      var curve = [];
      var nowV = p.vol;
      for (i = 0; i <= 200; i++) { var vv = (i / 200) * nowV; curve.push([X(vv), Y(ph(vv))]); }
      poly(ctx, curve, C.a, 2.8);
      dot(ctx, X(nowV), Y(ph(nowV)), 6, C.c);
      dash(ctx, X(20), gy, X(20), Y(7), C.c, 1.6, [5, 4]);
      txt(ctx, '滴定终点 V = 20 mL，pH = 7', X(20) + 8, Y(7) - 14, C.c, 12);
      var pink = nowV > 19.7;
      var bx = gx + gw * 0.16, by = 56;
      ctx.fillStyle = pink ? 'rgba(255,105,180,0.6)' : 'rgba(180,220,255,0.22)';
      ctx.fillRect(bx, by, 44, 56);
      ctx.strokeStyle = C.axis; ctx.strokeRect(bx, by, 44, 56);
      txt(ctx, pink ? '酚酞变红' : '无色', bx + 22, by + 68, pink ? '#ff69b4' : C.dim, 12, 'center');
      txt(ctx, '当前 pH = ' + fmt(ph(nowV), 2), 14, 24, C.text, 14);
      txt(ctx, '突跃范围大约 pH 4 → 10，所以强酸强碱互相滴定都能用酚酞', 14, h - 18, C.dim, 12);
    }
  });

  K.MODELS.push({
    id: 'chem-cell', subject: '化学', title: '原电池（Zn-Cu 双液电池）',
    desc: '锌比铜活泼，锌失电子做负极，电子经导线流向铜（正极），盐桥维持溶液电中性。',
    params: [
      { key: 'speed', label: '电子流速', min: 0.3, max: 2.5, step: 0.1, value: 1.2 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var top = h * 0.26, bot = h * 0.76;
      var lx = w * 0.28, rx = w * 0.72;
      ctx.fillStyle = 'rgba(120,170,220,0.14)';
      ctx.fillRect(lx - 34, top + 30, 68, bot - top - 30);
      ctx.fillRect(rx - 34, top + 30, 68, bot - top - 30);
      ctx.strokeStyle = 'rgba(120,170,220,0.5)'; ctx.lineWidth = 1.6;
      ctx.strokeRect(lx - 34, top + 30, 68, bot - top - 30);
      ctx.strokeRect(rx - 34, top + 30, 68, bot - top - 30);
      ctx.fillStyle = 'rgba(94,224,160,0.35)';
      ctx.fillRect(lx, top + 40, rx - lx, 12);
      txt(ctx, '盐桥', (lx + rx) / 2, top + 46, C.d, 11, 'center');
      line(ctx, lx, bot, lx, top, C.text, 5);
      line(ctx, rx, bot, rx, top, C.text, 5);
      line(ctx, lx, top, rx - 0, top, C.text, 3);
      line(ctx, rx, top, w * 0.86, top, C.text, 3);
      line(ctx, w * 0.86, top, w * 0.86, top + 52, C.axis, 3);
      ctx.strokeStyle = C.c; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(w * 0.86, top + 64, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.c; ctx.fillRect(w * 0.86 - 9, top + 60, 18, 8);
      txt(ctx, '电流表', w * 0.86 + 22, top + 64, C.c, 11);
      txt(ctx, 'Zn 负极（氧化）', lx, bot + 30, C.a, 13, 'center');
      txt(ctx, 'Zn − 2e⁻ → Zn²⁺', lx, bot + 50, C.dim, 11, 'center');
      txt(ctx, 'Cu 正极（还原）', rx, bot + 30, C.b, 13, 'center');
      txt(ctx, '2H⁺ + 2e⁻ → H₂↑', rx, bot + 50, C.dim, 11, 'center');
      var i;
      for (i = 0; i < 9; i++) {
        var u = ((t * p.speed * 0.35 + i / 9) % 1);
        var ex = lx + u * (w * 0.86 - lx), ey = top - 9;
        dot(ctx, ex, ey, 4, C.d);
        if (i < 6) {
          var m = ((t * p.speed * 0.36 + i / 6) % 1);
          var mx = lx + m * (rx - lx), my = top + 46;
          dot(ctx, mx, my, 3.4, C.b);
          dot(ctx, mx + 9, my + 5, 3, C.a);
        }
      }
      txt(ctx, 'e⁻', (lx + w * 0.86) / 2, top - 24, C.d, 13, 'center');
      txt(ctx, '电子不能进入溶液，只能走导线；溶液中靠离子定向移动导电', 14, h - 18, C.dim, 12);
      txt(ctx, '反应：Zn + 2H⁺ → Zn²⁺ + H₂↑（把化学能变成电能）', 14, 22, C.text, 13);
    }
  });
})();

/* ---------------- 第二批内置模型（数学 / 物理 / 化学） ---------------- */
(function () {
  'use strict';
  var K = window.MODEL_KIT, C = K.C, txt = K.txt, line = K.line, dash = K.dash;
  var dot = K.dot, arrow = K.arrow, poly = K.poly, circle = K.circle, grid = K.grid,
      axes = K.axes, clamp = K.clamp, fmt = K.fmt, clear = K.clear, M = K.MODELS;

  function rnd(i) {
    var x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  M.push({
    id: 'math-probability', subject: '数学', title: '频率稳定于概率（抛硬币）',
    desc: '抛的次数越多，正面出现的频率就越贴近理论概率。这就是“用频率估计概率”的道理。',
    params: [{ key: 'p', label: '理论概率 p', min: 0.1, max: 0.9, step: 0.05, value: 0.5 }],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 40, 40);
      var ox = 60, oy = h - 44, ax = w - 30, ay = 30;
      axes(ctx, ox, oy, w - 22, h, '试验次数 n', '频率');
      var yP = oy - (oy - ay) * p;
      dash(ctx, ox, yP, ax, yP, C.c, 1.6, [6, 5]);
      txt(ctx, '理论概率 p = ' + fmt(p, 2), ax, yP - 12, C.c, 12, 'right');
      var N = 2400, step = 40;
      var tt = t % 9;
      var n = clamp(Math.floor(tt * 400 / step) * step, 0, N);
      var pts = [[ox, oy]], succ = 0, i;
      for (i = 0; i < n; i++) {
        if (rnd(i) < p) { succ++; }
        if ((i + 1) % step === 0) {
          pts.push([ox + (ax - ox) * ((i + 1) / N), oy - (oy - ay) * (succ / (i + 1))]);
        }
      }
      poly(ctx, pts, C.a, 2.2);
      var fr = n ? succ / n : 0;
      var lx = ox + (ax - ox) * (n / N), ly = oy - (oy - ay) * fr;
      dot(ctx, lx, ly, 5, C.b);
      txt(ctx, 'n = ' + n + '　正面频率 = ' + fmt(fr, 3), 14, 22, C.text, 13);
      txt(ctx, '|频率 - 概率| = ' + fmt(Math.abs(fr - p), 3) + '（越大越接近 0）', 14, 44, C.d, 12);
    }
  });

  M.push({
    id: 'math-solid', subject: '数学', title: '正方体的旋转与体对角线',
    desc: '转动正方体看空间关系：棱长 a 时，体积 a³、表面积 6a²、体对角线 √3·a，它与底面所成角约 35.3°。',
    params: [{ key: 'a', label: '棱长 a', min: 1, max: 4, step: 0.1, value: 2 }],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 36, 36);
      var cx = w * 0.46, cy = h * 0.54, s = Math.min(w, h) * 0.16 * (p.a / 2);
      var ry = t * 0.5, rx = 0.45 + Math.sin(t * 0.3) * 0.14;
      function pr(x, y, z) {
        var c1 = Math.cos(ry), s1 = Math.sin(ry);
        var X = x * c1 - z * s1, Z = x * s1 + z * c1;
        var c2 = Math.cos(rx), s2 = Math.sin(rx);
        var Y = y * c2 - Z * s2, Z2 = y * s2 + Z * c2;
        var f = 3.8 / (3.8 + Z2 * 0.55);
        return [cx + X * s * f, cy - Y * s * f];
      }
      var V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
               [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
      var P = V.map(function (v) { return pr(v[0], v[1], v[2]); });
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
       [0, 4], [1, 5], [2, 6], [3, 7]].forEach(function (e) {
        line(ctx, P[e[0]][0], P[e[0]][1], P[e[1]][0], P[e[1]][1], C.axis, 1.6);
      });
      dash(ctx, P[0][0], P[0][1], P[6][0], P[6][1], C.b, 2.2, [7, 6]);
      P.forEach(function (q) { dot(ctx, q[0], q[1], 2.8, C.a); });
      txt(ctx, 'A', P[0][0] - 14, P[0][1] + 6, C.dim, 11);
      txt(ctx, 'C₁', P[6][0] + 8, P[6][1] - 8, C.c, 12);
      txt(ctx, '棱长 a = ' + fmt(p.a) + '　体积 a³ = ' + fmt(p.a * p.a * p.a) + '　表面积 6a² = ' + fmt(6 * p.a * p.a), 14, 22, C.text, 13);
      txt(ctx, '体对角线 AC₁ = √3·a = ' + fmt(Math.sqrt(3) * p.a) + '　与底面夹角 ≈ 35.3°', 14, 44, C.c, 13);
    }
  });

  M.push({
    id: 'math-sequence', subject: '数学', title: '等差数列与求和',
    desc: '每一项都加上公差 d 得到等差数列；把前 n 项累加，就是求和公式 Sₙ = n·a₁ + n(n-1)/2·d。',
    params: [
      { key: 'a1', label: '首项 a₁', min: -4, max: 6, step: 0.5, value: 1 },
      { key: 'd', label: '公差 d', min: -2, max: 3, step: 0.1, value: 0.6 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 36, 36);
      var ox = 54, oy = h * 0.56, ax = w - 28, ay = 26;
      axes(ctx, ox, oy, w - 20, h, 'n', 'aₙ / Sₙ');
      var N = 14;
      var maxv = Math.max(1, Math.abs(p.a1) + Math.abs(p.d) * N);
      var sy = (h * 0.42) / maxv;
      var sx = (ax - ox) / N;
      var terms = [], sums = [], run = 0, i;
      for (i = 1; i <= N; i++) {
        var an = p.a1 + (i - 1) * p.d;
        run += an;
        terms.push([ox + i * sx, oy - an * sy * 0.95]);
        sums.push([ox + i * sx, oy - run * sy * 0.5]);
      }
      var upto = clamp(Math.floor((t % 7) * 2) + 1, 1, N);
      poly(ctx, terms.slice(0, upto), C.a, 2);
      poly(ctx, sums.slice(0, upto), C.d, 2);
      terms.slice(0, upto).forEach(function (q) { dot(ctx, q[0], q[1], 3.6, C.a); });
      sums.slice(0, upto).forEach(function (q) { dot(ctx, q[0], q[1], 3.6, C.d); });
      var an = p.a1 + (upto - 1) * p.d;
      var sn = upto * p.a1 + upto * (upto - 1) / 2 * p.d;
      txt(ctx, 'a' + upto + ' = ' + fmt(an), terms[upto - 1][0] - 10, terms[upto - 1][1] - 14, C.a, 12);
      txt(ctx, 'S' + upto + ' = ' + fmt(sn), sums[upto - 1][0] + 8, sums[upto - 1][1] + 16, C.d, 12);
      txt(ctx, '蓝点：aₙ = a₁ + (n-1)d　绿点：Sₙ（前 n 项和）', 14, 22, C.text, 13);
      txt(ctx, 'S' + upto + ' = ' + upto + '×' + fmt(p.a1) + ' + ' + upto + '×' + (upto - 1) + '/2×' + fmt(p.d), 14, 44, C.dim, 12);
    }
  });

  M.push({
    id: 'phy-energy', subject: '物理', title: '动能定理：合力的功 = 动能变化',
    desc: '拉力做正功、摩擦力做负功，合力的功正好等于动能的增加量 W合 = ½mv² - ½mv₀²。',
    params: [
      { key: 'm', label: '质量 m (kg)', min: 1, max: 5, step: 0.5, value: 2 },
      { key: 'F', label: '水平拉力 F (N)', min: 5, max: 40, step: 1, value: 14 },
      { key: 'mu', label: '动摩擦因数 μ', min: 0, max: 0.4, step: 0.02, value: 0.1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var G = 9.8, a = (p.F - p.mu * p.m * G) / p.m;
      var ground = h * 0.72, x0 = w * 0.1, sc = 42;
      line(ctx, 0, ground, w, ground, C.axis, 2.4);
      txt(ctx, '水平面', w - 10, ground + 18, C.dim, 12, 'right');
      if (a <= 0.05) {
        txt(ctx, '拉力太小（合力 ≤ 0），物体推不动。把 F 调大试试。', 14, 26, C.b, 14);
        return;
      }
      var T = 2.6, tau = t % T;
      var v = a * tau, s = 0.5 * a * tau * tau;
      var bw = w * 0.15, bh = h * 0.15;
      var bx = x0 + s * sc;
      if (bx > w * 0.92) { bx = w * 0.92; }
      ctx.fillStyle = C.a; ctx.fillRect(bx, ground - bh, bw, bh);
      txt(ctx, 'm = ' + fmt(p.m, 1) + ' kg', bx + bw / 2, ground - bh / 2, '#08111c', 12, 'center');
      arrow(ctx, bx + bw, ground - bh * 0.5, Math.min(bx + bw + 44, w - 8), ground - bh * 0.5, C.d, 2.4);
      txt(ctx, 'F = ' + fmt(p.F, 0) + ' N', bx + bw + 6, ground - bh * 0.5 - 16, C.d, 12);
      arrow(ctx, bx - 2, ground - 3, Math.max(bx - 40, 6), ground - 3, C.b, 2.2);
      txt(ctx, 'f = ' + fmt(p.mu * p.m * G, 1) + ' N', bx - 8, ground + 16, C.b, 12, 'right');
      var W = p.F * s, Wf = p.mu * p.m * G * s, Ek = 0.5 * p.m * v * v;
      txt(ctx, 'v = ' + fmt(v) + ' m/s　位移 s = ' + fmt(s) + ' m', 14, 22, C.text, 13);
      txt(ctx, 'W拉 = ' + fmt(W) + ' J　W摩 = -' + fmt(Wf) + ' J　W合 = ' + fmt(W - Wf) + ' J', 14, 44, C.d, 13);
      txt(ctx, '动能 ½mv² = ' + fmt(Ek) + ' J　→　W合 = ½mv² ✔', 14, 66, C.c, 13);
    }
  });

  M.push({
    id: 'phy-doppler', subject: '物理', title: '多普勒效应（声源移动）',
    desc: '声源向右移动时，前方波面被压密（波长变短、听感更尖），后方波面被拉疏（波长变长、听感更沉）。',
    params: [
      { key: 'vs', label: '声源速度 vs（相对声速）', min: 0, max: 0.9, step: 0.05, value: 0.5 },
      { key: 'f', label: '发声频率 f', min: 0.5, max: 2.5, step: 0.1, value: 1.2 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var cy = h * 0.55, v = 1, T = 4.2, tau = t % T;
      var sc = w * 0.4, x0 = w * 0.5 - p.vs * sc * T * 0.5;
      var sx = x0 + p.vs * sc * tau;
      var period = 1 / p.f;
      for (var k = Math.floor(tau / period); k >= 0; k--) {
        var age = tau - k * period;
        var r = age * v * sc;
        if (r > w * 1.15) { continue; }
        var alpha = Math.max(0.1, 0.6 - age / T);
        circle(ctx, x0 + p.vs * sc * (k * period), cy, r, 'rgba(78,161,255,' + fmt(alpha, 2) + ')', 1.5);
      }
      dot(ctx, sx, cy, 7, C.b);
      arrow(ctx, sx, cy - 30, sx + p.vs * sc * 0.6, cy - 30, C.b, 2);
      txt(ctx, '声源 vs = ' + fmt(p.vs) + 'c', sx + 8, cy - 48, C.b, 12);
      txt(ctx, '前方：λ = (c-vs)/f = ' + fmt((v - p.vs) / p.f) + '　频率变高', 14, 22, C.c, 13);
      txt(ctx, '后方：λ = (c+vs)/f = ' + fmt((v + p.vs) / p.f) + '　频率变低', 14, 44, C.d, 13);
      txt(ctx, '救护车驶近时声音更尖、驶远时更沉，就是这个原因。', 14, h - 18, C.dim, 12);
    }
  });

  M.push({
    id: 'phy-refraction', subject: '物理', title: '光的折射与全反射',
    desc: '光从光密介质射向空气会远离法线偏折；入射角超过临界角就发生全反射，光被全部反射回介质。',
    params: [
      { key: 'th', label: '入射角 θ₁ (°)', min: 0, max: 89, step: 1, value: 40 },
      { key: 'n', label: '介质折射率 n', min: 1.0, max: 2.4, step: 0.05, value: 1.5 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h);
      var cy = h * 0.46, ox = w * 0.5, L = Math.min(w, h) * 0.4;
      ctx.fillStyle = 'rgba(78,161,255,0.12)';
      ctx.fillRect(0, cy, w, h - cy);
      line(ctx, 0, cy, w, cy, C.axis, 2);
      dash(ctx, ox, 0, ox, h, C.dim, 1.2, [5, 5]);
      txt(ctx, '空气 n = 1.00', 12, cy - 12, C.dim, 12);
      txt(ctx, '介质 n = ' + fmt(p.n, 2), 12, cy + 22, C.dim, 12);
      var th = p.th * Math.PI / 180;
      var ix = ox - Math.sin(th) * L, iy = cy + Math.cos(th) * L;
      arrow(ctx, ix, iy, ox, cy, C.c, 2.6);
      txt(ctx, '入射光 θ₁ = ' + fmt(p.th, 0) + '°', ix - 6, iy + 8, C.c, 12, 'right');
      var Cc = Math.asin(Math.min(1, 1 / p.n));
      dash(ctx, ox, cy, ox - Math.sin(Cc) * L, cy + Math.cos(Cc) * L, C.d, 1.3, [4, 5]);
      txt(ctx, '临界角 C = ' + fmt(Cc * 180 / Math.PI, 1) + '°', ox - Math.sin(Cc) * L - 6, cy + Math.cos(Cc) * L + 6, C.d, 11, 'right');
      if (p.n * Math.sin(th) <= 1) {
        var th2 = Math.asin(p.n * Math.sin(th));
        var rx = ox + Math.sin(th2) * L, ry = cy - Math.cos(th2) * L;
        arrow(ctx, ox, cy, rx, ry, C.a, 2.6);
        txt(ctx, '折射光 θ₂ = ' + fmt(th2 * 180 / Math.PI, 1) + '°', rx + 8, ry - 8, C.a, 12);
        txt(ctx, 'sinθ₁/sinθ₂ = 1/n = ' + fmt(1 / p.n, 2), 14, 22, C.text, 13);
        txt(ctx, 'θ₁ < C：光一部分折射出去、一部分反射回来。', 14, 44, C.dim, 12);
      } else {
        arrow(ctx, ox, cy, ix, iy, C.b, 2.6);
        txt(ctx, '全反射：光全部反射回介质', 14, 22, C.b, 14);
        txt(ctx, 'θ₁ = ' + fmt(p.th, 0) + '° > C = ' + fmt(Cc * 180 / Math.PI, 1) + '°，没有折射光。', 14, 46, C.c, 13);
        txt(ctx, '光纤通信、水中看到的水面“镜子”，都是全反射。', 14, h - 18, C.dim, 12);
      }
    }
  });

  M.push({
    id: 'phy-lens', subject: '物理', title: '凸透镜成像与成像公式',
    desc: '平行主轴的光线过焦点、过光心的光线方向不变；1/f = 1/u + 1/v，u>f 成倒立实像，u<f 成正立放大虚像。',
    params: [
      { key: 'u', label: '物距 u（×f）', min: 0.3, max: 4, step: 0.1, value: 2 },
      { key: 'f', label: '焦距 f', min: 0.6, max: 1.6, step: 0.05, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 36, 36);
      var cy = h * 0.5, ox = w * 0.5;
      var f = p.f, u = p.u * f;
      var scale = Math.max(26, Math.min(95, (h * 0.7) / Math.max(u, 2.4 * f)));
      if (u * scale > w * 0.44) { scale = Math.max(14, (w * 0.44) / u); }
      line(ctx, 0, cy, w, cy, C.axis, 1.4);
      ctx.save();
      ctx.strokeStyle = C.a; ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(ox, cy, Math.min(w * 0.045, h * 0.08), h * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke(); ctx.restore();
      dot(ctx, ox + f * scale, cy, 3, C.c);
      dot(ctx, ox - f * scale, cy, 3, C.c);
      txt(ctx, "F′", ox + f * scale, cy + 16, C.c, 11, 'center');
      txt(ctx, 'F', ox - f * scale, cy + 16, C.c, 11, 'center');
      var hObj = h * 0.18;
      var topX = ox - u * scale, topY = cy - hObj;
      arrow(ctx, topX, cy, topX, topY, C.d, 2.4);
      txt(ctx, '物', topX, topY - 10, C.d, 12, 'center');
      if (Math.abs(u - f) < 0.06) {
        line(ctx, topX, topY, ox, topY, C.c, 1.4);
        line(ctx, ox, topY, w - 20, topY, C.c, 1.4);
        txt(ctx, '物体正好在焦点上，射出平行光，不成像。', 14, 26, C.b, 14);
        return;
      }
      var v = (u * f) / (u - f);
      var m = -v / u;
      var imgX = ox + v * scale, imgY = cy - m * hObj;
      var real = v > 0;
      line(ctx, topX, topY, ox, topY, C.c, 1.4);
      line(ctx, ox, topY, imgX, imgY, C.c, 1.4);
      dash(ctx, topX, topY, imgX, imgY, C.e, 1.2, [4, 4]);
      arrow(ctx, imgX, cy, imgX, imgY, real ? C.b : C.e, 2.4);
      txt(ctx, real ? '实像（倒立）' : '虚像（正立、放大）', imgX, imgY + (m > 0 ? -12 : 18), real ? C.b : C.e, 12, 'center');
      txt(ctx, 'u = ' + fmt(u) + '　v = ' + fmt(v) + '　放大率 |m| = ' + fmt(Math.abs(m), 2), 14, 22, C.text, 13);
      txt(ctx, '1/f = 1/u + 1/v → ' + fmt(1 / f, 2) + ' = ' + fmt(1 / u, 2) + ' + ' + fmt(1 / v, 2), 14, 44, C.d, 13);
    }
  });

  M.push({
    id: 'phy-gas', subject: '物理', title: '气体状态方程 pV = nRT',
    desc: '封闭气体的压强由温度、体积和物质的量共同决定：pV = nRT。升温或压缩，压强都会上升。',
    params: [
      { key: 'T', label: '温度 T (K)', min: 180, max: 700, step: 10, value: 300 },
      { key: 'n', label: '物质的量 n (mol)', min: 0.5, max: 3, step: 0.1, value: 1 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var R = 8.31, p0 = 101325;
      var top = h * 0.2, bot = h * 0.8, left = w * 0.1, right = w * 0.88;
      line(ctx, left, top, left, bot, C.axis, 2.4);
      line(ctx, left, bot, right, bot, C.axis, 2.4);
      line(ctx, right, top, right, bot, C.axis, 2.4);
      var V = p.n * R * p.T / p0;
      var frac = clamp(V / 0.62, 0.08, 0.94);
      var px = right - (right - left) * frac;
      ctx.fillStyle = 'rgba(255,209,102,0.07)';
      ctx.fillRect(left, top, px - left, bot - top);
      line(ctx, px, top, px, bot, C.a, 3.4);
      txt(ctx, '活塞', px, top - 12, C.a, 12, 'center');
      var speed = Math.sqrt(p.T / 300), i;
      for (i = 0; i < 14; i++) {
        var ux = left + 12 + (px - left - 24) * (0.5 + 0.5 * Math.sin(t * 1.3 * speed + i * 2.1));
        var uy = top + 12 + (bot - top - 24) * (0.5 + 0.5 * Math.sin(t * 1.9 * speed + i * 1.3));
        dot(ctx, ux, uy, 3.2, C.c);
      }
      txt(ctx, 'T = ' + fmt(p.T, 0) + ' K　n = ' + fmt(p.n, 1) + ' mol　V = ' + fmt(V * 1000, 1) + ' L', 14, 22, C.text, 13);
      txt(ctx, 'p = ' + fmt(p0 / 1000, 1) + ' kPa（1 atm）', 14, 44, C.d, 13);
      txt(ctx, 'pV/T = ' + fmt(p0 * V / p.T, 2) + '　=　nR = ' + fmt(p.n * R, 2) + ' ✔', 14, 66, C.c, 13);
    }
  });

  M.push({
    id: 'phy-levels', subject: '物理', title: '氢原子能级与光谱（跃迁）',
    desc: '电子从高能级跃迁到低能级时放出一个光子，光子能量正好等于两个能级之差 hν = Eₘ − Eₙ。',
    params: [{ key: 'k', label: '跃迁类型 1~5', min: 1, max: 5, step: 1, value: 2 }],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 36, 36);
      var ox = w * 0.2, right = w * 0.6;
      var E = [0, -13.6, -3.4, -1.51, -0.85];
      var names = ['', 'n=1', 'n=2', 'n=3', 'n=4'];
      var top = h * 0.24, bot = h * 0.84, i;
      function Y(n) { return bot - (bot - top) * (1 - 1 / (n * n)) / (1 - 1 / 16); }
      for (i = 1; i <= 4; i++) {
        line(ctx, ox, Y(i), right, Y(i), C.axis, 1.6);
        txt(ctx, names[i] + '　' + fmt(E[i], 2) + ' eV', ox - 8, Y(i), C.dim, 12, 'right');
      }
      var tr = { 1: [2, 1], 2: [3, 1], 3: [3, 2], 4: [4, 2], 5: [4, 1] };
      var pair = tr[Math.round(p.k)] || [2, 1];
      var hi = pair[0], lo = pair[1], dE = E[hi] - E[lo];
      var tau = (t % 3) / 3;
      dash(ctx, ox, Y(hi), ox, Y(lo), C.e, 1, [4, 4]);
      var y = Y(hi) + (Y(lo) - Y(hi)) * Math.min(1, tau * 1.6);
      dot(ctx, ox, y, 6, C.b);
      txt(ctx, 'e⁻', ox - 16, y, C.b, 12, 'center');
      if (tau > 0.6) {
        var lam = 1240 / dE;
        var col = lam < 450 ? '#7c5cff' : (lam < 495 ? '#4ea1ff' : (lam < 570 ? '#5ee0a0' : (lam < 590 ? '#ffd166' : (lam < 620 ? '#ff9f43' : '#ff6b6b'))));
        var yy = (Y(hi) + Y(lo)) / 2;
        arrow(ctx, right + 10, yy, w - 24, yy, col, 2.6);
        txt(ctx, '光子 hν = ' + fmt(dE, 2) + ' eV　λ ≈ ' + fmt(lam, 0) + ' nm', right + 18, yy - 16, col, 12);
      }
      txt(ctx, 'Eₙ = -13.6/n² eV　跃迁：' + names[hi] + ' → ' + names[lo] + '　放出 ' + fmt(dE, 2) + ' eV', 14, 22, C.text, 13);
      txt(ctx, '不同跃迁放出不同波长的光，合起来就是氢原子光谱。', 14, h - 18, C.dim, 12);
    }
  });

  M.push({
    id: 'chem-rate', subject: '化学', title: '温度、浓度对反应速率的影响',
    desc: '温度越高、反应物浓度越大，分子碰撞越频繁、有效碰撞越多，反应速率越快。',
    params: [
      { key: 'T', label: '温度（相对）', min: 0.6, max: 2.4, step: 0.1, value: 1.2 },
      { key: 'c', label: '反应物浓度', min: 0.2, max: 1, step: 0.05, value: 0.7 }
    ],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var left = w * 0.1, right = w * 0.9, top = h * 0.26, bot = h * 0.82;
      line(ctx, left, top, right, top, C.axis, 2);
      line(ctx, left, bot, right, bot, C.axis, 2);
      line(ctx, left, top, left, bot, C.axis, 2);
      line(ctx, right, top, right, bot, C.axis, 2);
      var N = Math.round(10 + 26 * p.c), i;
      for (i = 0; i < N; i++) {
        var xx = left + 14 + (right - left - 28) * (0.5 + 0.5 * Math.sin(t * p.T * 1.5 + i * 1.7));
        var yy = top + 14 + (bot - top - 28) * (0.5 + 0.5 * Math.sin(t * p.T * 1.9 + i * 2.3));
        dot(ctx, xx, yy, 4, i % 3 ? C.a : C.b);
      }
      var rate = p.c * p.c * p.T;
      txt(ctx, '浓度越大 → 单位体积里分子越多（现在 ' + N + ' 个粒子）', 14, 22, C.text, 13);
      txt(ctx, '温度越高 → 分子运动越快，有效碰撞越多', 14, 44, C.d, 13);
      txt(ctx, '相对反应速率 ≈ k·c²·T ≈ ' + fmt(rate, 2) + '（越大越快）', 14, 66, C.c, 13);
    }
  });

  M.push({
    id: 'chem-methane', subject: '化学', title: '甲烷的正四面体结构',
    desc: '甲烷 CH₄ 是正四面体：碳在中心，4 个氢在顶点，任意两个 C—H 键的夹角都是 109°28′。',
    params: [{ key: 'sp', label: '转动速度', min: 0, max: 3, step: 0.1, value: 1 }],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 36, 36);
      var cx = w * 0.5, cy = h * 0.56, s = Math.min(w, h) * 0.24;
      var ry = t * 0.5 * p.sp, rx = 0.5 + Math.sin(t * 0.28) * 0.18;
      function pr(x, y, z) {
        var c1 = Math.cos(ry), s1 = Math.sin(ry);
        var X = x * c1 - z * s1, Z = x * s1 + z * c1;
        var c2 = Math.cos(rx), s2 = Math.sin(rx);
        var Y = y * c2 - Z * s2, Z2 = y * s2 + Z * c2;
        var f = 3.6 / (3.6 + Z2 * 0.7);
        return [cx + X * s * f, cy - Y * s * f];
      }
      [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].forEach(function (v) {
        var q = pr(v[0], v[1], v[2]);
        line(ctx, cx, cy, q[0], q[1], C.axis, 2);
        circle(ctx, q[0], q[1], 13, C.text, 1.6, '#e8eef7');
        txt(ctx, 'H', q[0], q[1], '#0e1521', 12, 'center');
      });
      circle(ctx, cx, cy, 19, C.a, 2, '#16202f');
      txt(ctx, 'C', cx, cy, C.a, 14, 'center');
      txt(ctx, '甲烷 CH₄：正四面体，键角 109°28′', 14, 22, C.text, 13);
      txt(ctx, '空间构型由价层电子对互斥理论（VSEPR）决定。', 14, 44, C.dim, 12);
    }
  });

  M.push({
    id: 'chem-bond', subject: '化学', title: '离子键的形成（Na 与 Cl）',
    desc: '钠原子把最外层 1 个电子交给氯原子，生成 Na⁺ 和 Cl⁻，两个离子靠静电引力结合成离子键。',
    params: [{ key: 'd', label: '原子间距', min: 0.5, max: 1.6, step: 0.05, value: 1.2 }],
    draw: function (ctx, w, h, t, p) {
      clear(ctx, w, h); grid(ctx, w, h, 32, 32);
      var cy = h * 0.52, cx = w * 0.5;
      var gap = w * 0.12 * p.d + w * 0.12;
      var lx = cx - gap, rx = cx + gap;
      circle(ctx, lx, cy, 34, C.c, 2.2, 'rgba(255,209,102,0.12)');
      circle(ctx, rx, cy, 46, C.d, 2.2, 'rgba(94,224,160,0.12)');
      txt(ctx, '11 个质子', lx, cy + 54, C.dim, 11, 'center');
      txt(ctx, '17 个质子', rx, cy + 66, C.dim, 11, 'center');
      var tau = (t % 4) / 4;
      if (tau < 0.55) {
        txt(ctx, 'Na', lx, cy, C.c, 16, 'center');
        txt(ctx, 'Cl', rx, cy, C.d, 18, 'center');
        var ang = t * 4;
        var ex = lx + Math.cos(ang) * 44, ey = cy + Math.sin(ang) * 44;
        dot(ctx, ex, ey, 6, C.a);
        txt(ctx, 'e⁻', ex, ey - 16, C.a, 12, 'center');
        if (tau > 0.3) {
          var kk = (tau - 0.3) / 0.25;
          var mx = ex + (rx - ex) * kk, my = ey + (cy - ey) * kk;
          dot(ctx, mx, my, 6, C.b);
          txt(ctx, '失去电子 / 得到电子', mx, my - 18, C.b, 12, 'center');
        }
      } else {
        txt(ctx, 'Na⁺', lx, cy, C.c, 18, 'center');
        txt(ctx, 'Cl⁻', rx, cy, C.d, 20, 'center');
        line(ctx, lx + 34, cy, rx - 46, cy, C.b, 2.4);
        txt(ctx, '离子键（静电引力）', cx, cy - 20, C.b, 13, 'center');
      }
      txt(ctx, 'Na → Na⁺ + e⁻　　Cl + e⁻ → Cl⁻', 14, 22, C.text, 13);
      txt(ctx, '活泼金属 + 活泼非金属 → 离子化合物（如 NaCl）', 14, h - 18, C.dim, 12);
    }
  });
})();