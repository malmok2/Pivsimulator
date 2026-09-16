/* PIV Simulator — colour ramps.
 *
 * Three jobs, three kinds of ramp:
 *   speed / error  -> sequential, one hue family, monotone in lightness
 *   vorticity      -> diverging, two hues with a neutral midpoint at zero
 *   correlation    -> sequential dark-to-bright instrument readout
 * Each ramp has a light-theme and a dark-theme instance; the dark one is
 * chosen against the dark surface, not flipped automatically.
 */
(function (root) {
  'use strict';

  var RAMPS = {
    speed: {
      light: ['#F1F6F3', '#C3E1D5', '#84C6B0', '#41A085', '#177661', '#0A4239'],
      dark: ['#07231F', '#0D4B3F', '#177E67', '#37AF8C', '#7ED6B6', '#DCF4E8']
    },
    error: {
      light: ['#FBF4EF', '#F3D8C2', '#E8A578', '#D06E38', '#A3400F', '#5E1D02'],
      dark: ['#1F1208', '#4A2409', '#7C3D0C', '#B4631F', '#E39A55', '#F8D9B3']
    },
    vorticity: {
      light: ['#1A5480', '#4C8CB8', '#9FC2D9', '#EAEAE6', '#E2B49E', '#C36B4B', '#8C2C17'],
      dark: ['#9BD6F6', '#5CA5D6', '#31658B', '#2A3336', '#8D4527', '#CA7340', '#F3B385']
    },
    correlation: {
      light: ['#0B0A1A', '#2E1A50', '#6C2069', '#A62C60', '#D65340', '#F09B3C', '#F9E18B', '#FFFCEC'],
      dark: ['#0B0A1A', '#2E1A50', '#6C2069', '#A62C60', '#D65340', '#F09B3C', '#F9E18B', '#FFFCEC']
    }
  };

  function hex(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  var cache = Object.create(null);
  function stops(name, theme) {
    var key = name + '|' + theme;
    if (!cache[key]) {
      var r = RAMPS[name] || RAMPS.speed;
      cache[key] = (r[theme] || r.light).map(hex);
    }
    return cache[key];
  }

  /* t in [0,1] -> [r,g,b] */
  function sample(name, t, theme, out) {
    var s = stops(name, theme);
    t = t !== t ? 0 : (t < 0 ? 0 : (t > 1 ? 1 : t));
    var f = t * (s.length - 1), i = Math.floor(f), w = f - i;
    var a = s[i], b = s[Math.min(s.length - 1, i + 1)];
    out = out || [0, 0, 0];
    out[0] = a[0] + (b[0] - a[0]) * w;
    out[1] = a[1] + (b[1] - a[1]) * w;
    out[2] = a[2] + (b[2] - a[2]) * w;
    return out;
  }

  function css(name, t, theme) {
    var c = sample(name, t, theme);
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  /* CSS gradient string for a colour bar. lo/hi restrict it to part of the
   * ramp, so a bar can show exactly the slice the marks were drawn from. */
  function gradient(name, theme, deg, lo, hi) {
    var parts = [], n = 12, c;
    lo = lo || 0; hi = hi === undefined ? 1 : hi;
    for (var i = 0; i <= n; i++) {
      c = sample(name, lo + (hi - lo) * (i / n), theme);
      parts.push('rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) +
        ') ' + Math.round(100 * i / n) + '%');
    }
    return 'linear-gradient(' + (deg === undefined ? 90 : deg) + 'deg,' + parts.join(',') + ')';
  }

  /* A readable range: [0,max] for sequential, symmetric for diverging. */
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
