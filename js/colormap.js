/* PIV Simulator — 색 램프.
 *
 * 디자인 지침대로 스칼라장은 viridis 하나로 통일한다(명도가 단조로워
 * 흑백 인쇄와 색맹에서도 순서가 유지된다). 무지개(jet)는 쓰지 않는다.
 * 부호가 있는 장(와도·발산)만 발산형으로, 두 끝을 차트 계열색 --c1(navy)과
 * --c6(brick)에 맞추고 가운데는 바탕에 가까운 중성색을 둔다.
 * 단일 라이트 테마이므로 테마별 변종이 없다.
 */
(function (root) {
  'use strict';

  var RAMPS = {
    /* viridis */
    field: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c',
            '#28ae80', '#5ec962', '#addc30', '#fde725'],
    /* navy ← 중성 → brick */
    diverging: ['#0f4c81', '#3f74a2', '#82a3c2', '#c3d0dc', '#eceef0',
                '#e3c6b8', '#cf9179', '#bd6249', '#a83f2b']
  };

  function hex(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  var cache = Object.create(null);
  function stops(name) {
    if (!cache[name]) cache[name] = (RAMPS[name] || RAMPS.field).map(hex);
    return cache[name];
  }

  /* t in [0,1] -> [r,g,b] */
  function sample(name, t, out) {
    var s = stops(name);
    t = t !== t ? 0 : (t < 0 ? 0 : (t > 1 ? 1 : t));
    var f = t * (s.length - 1), i = Math.floor(f), w = f - i;
    var a = s[i], b = s[Math.min(s.length - 1, i + 1)];
    out = out || [0, 0, 0];
    out[0] = a[0] + (b[0] - a[0]) * w;
    out[1] = a[1] + (b[1] - a[1]) * w;
    out[2] = a[2] + (b[2] - a[2]) * w;
    return out;
  }

  function css(name, t) {
    var c = sample(name, t);
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  /* 색 띠용 CSS gradient. lo/hi 로 램프의 일부만 쓸 수 있다. */
  function gradient(name, deg, lo, hi) {
    var parts = [], n = 12, c;
    lo = lo || 0; hi = hi === undefined ? 1 : hi;
    for (var i = 0; i <= n; i++) {
      c = sample(name, lo + (hi - lo) * (i / n));
      parts.push('rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) +
        ') ' + Math.round(100 * i / n) + '%');
    }
    return 'linear-gradient(' + (deg === undefined ? 90 : deg) + 'deg,' + parts.join(',') + ')';
  }

  /* 읽기 좋은 범위: 순차는 [0,max], 발산은 0 을 가운데 둔 대칭 */
  function niceRange(arr, status, symmetric, pct) {
    var vals = [], i;
    for (i = 0; i < arr.length; i++) {
      if (status && status[i] === 2) continue;
      var v = arr[i];
      if (v === v && isFinite(v)) vals.push(symmetric ? Math.abs(v) : v);
    }
    if (!vals.length) return symmetric ? [-1, 1] : [0, 1];
    vals.sort(function (a, b) { return a - b; });
    var hiIdx = Math.min(vals.length - 1, Math.floor(vals.length * (pct === undefined ? 0.98 : pct)));
    var hi = vals[hiIdx];
    var step = Math.pow(10, Math.floor(Math.log(Math.max(1e-9, hi)) / Math.LN10));
    var m = hi / step;
    var mult = m <= 1.2 ? 1.2 : (m <= 2 ? 2 : (m <= 3 ? 3 : (m <= 5 ? 5 : 10)));
    hi = mult * step;
    if (symmetric) return [-hi, hi];
    var lo = vals[0];
    return [lo > 0 ? 0 : Math.floor(lo / step) * step, hi];
  }

  root.PIVSim = root.PIVSim || {};
  root.PIVSim.Color = {
    ramps: RAMPS, sample: sample, css: css, gradient: gradient, niceRange: niceRange
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
