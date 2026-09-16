/* PIV Simulator — FFT (radix-2, in-place) and FFT-based cross-correlation.
 * No dependencies. Works as a classic browser script and under node (vm).
 */
(function (root) {
  'use strict';

  var plans = Object.create(null);

  function plan(n) {
    if (plans[n]) return plans[n];
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two: ' + n);
    var levels = Math.round(Math.log(n) / Math.LN2);
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i, r = 0;
      for (var j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    var half = n >> 1;
    var cos = new Float64Array(half), sin = new Float64Array(half);
    for (var k = 0; k < half; k++) {
      cos[k] = Math.cos(2 * Math.PI * k / n);
      sin[k] = Math.sin(2 * Math.PI * k / n);
    }
    return (plans[n] = { n: n, levels: levels, rev: rev, cos: cos, sin: sin });
  }

  /* In-place 1-D complex FFT on a strided slice of re/im. */
  function fft1d(re, im, off, stride, p, inverse) {
    var n = p.n, rev = p.rev, cos = p.cos, sin = p.sin, i, j, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) {
        var a = off + i * stride, b = off + j * stride;
        t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var h = size >> 1, tw = n / size;
      for (var start = 0; start < n; start += size) {
        for (var q = 0, k = 0; q < h; q++, k += tw) {
          var c = cos[k], s = inverse ? sin[k] : -sin[k];
          var iu = off + (start + q) * stride;
          var il = off + (start + q + h) * stride;
          var lr = re[il], li = im[il];
          var tr = lr * c - li * s;
          var ti = lr * s + li * c;
          re[il] = re[iu] - tr; im[il] = im[iu] - ti;
          re[iu] += tr; im[iu] += ti;
        }
      }
    }
    if (inverse) {
      for (i = 0; i < n; i++) {
        var idx = off + i * stride;
        re[idx] /= n; im[idx] /= n;
      }
    }
  }

  /* In-place 2-D FFT of an n x n row-major complex image. */
  function fft2(re, im, n, inverse) {
    var p = plan(n), i;
    for (i = 0; i < n; i++) fft1d(re, im, i * n, 1, p, inverse);   /* rows */
    for (i = 0; i < n; i++) fft1d(re, im, i, n, p, inverse);       /* columns */
  }

  /* Scratch buffers, reused across calls for a given window size. */
  var scratch = Object.create(null);
  function buffers(n) {
    var s = scratch[n];
    if (!s) {
      var m = n * n;
      s = scratch[n] = {
        ar: new Float64Array(m), ai: new Float64Array(m),
        br: new Float64Array(m), bi: new Float64Array(m)
      };
    }
    return s;
  }

  /* Normalised circular cross-correlation of two n x n windows.
   * a, b are raw intensities; both are mean-subtracted here.
   * out[iy*n+ix] holds the correlation for displacement (ix-n/2, iy-n/2),
   * i.e. the map is already fftshift-ed with zero shift at the centre.
   * Values are correlation coefficients in [-1, 1].
   * Returns the peak correlation value found anywhere in the map.
   */
  function correlate(a, b, n, out) {
    var m = n * n, s = buffers(n), ar = s.ar, ai = s.ai, br = s.br, bi = s.bi;
    var i, ma = 0, mb = 0;
    for (i = 0; i < m; i++) { ma += a[i]; mb += b[i]; }
    ma /= m; mb /= m;
    var va = 0, vb = 0;
    for (i = 0; i < m; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      ar[i] = da; ai[i] = 0;
      br[i] = db; bi[i] = 0;
      va += da * da; vb += db * db;
    }
    fft2(ar, ai, n, false);
    fft2(br, bi, n, false);
    /* conj(A) * B */
    for (i = 0; i < m; i++) {
      var xr = ar[i], xi = ai[i], yr = br[i], yi = bi[i];
      ar[i] = xr * yr + xi * yi;
      ai[i] = xr * yi - xi * yr;
    }
    fft2(ar, ai, n, true);
    var norm = Math.sqrt(va * vb);
    if (!(norm > 0)) { for (i = 0; i < m; i++) out[i] = 0; return 0; }
    var half = n >> 1, peak = -Infinity;
    for (var iy = 0; iy < n; iy++) {
      var sy = (iy + half) & (n - 1);
      for (var ix = 0; ix < n; ix++) {
        var sx = (ix + half) & (n - 1);
        var v = ar[sy * n + sx] / norm;
        out[iy * n + ix] = v;
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  root.PIVSim = root.PIVSim || {};
  root.PIVSim.FFT = { plan: plan, fft1d: fft1d, fft2: fft2, correlate: correlate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
