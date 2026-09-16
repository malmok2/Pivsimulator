/* PIV Simulator — synthetic particle image pairs.
 *
 * Builds the double-frame recording a PIV camera would deliver: tracer particles
 * with Gaussian intensity profiles, a Gaussian laser light-sheet, 8-bit
 * quantisation, read noise, and loss of particle pairs (out-of-plane motion).
 * Because the displacement field is analytic, the exact answer is known.
 */
(function (root) {
  'use strict';

  /* mulberry32 — small seeded PRNG so every run is reproducible */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    var u = 1 - rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* Add one Gaussian particle image: I = I0 * exp(-8 r^2 / dp^2) */
  function splat(img, W, H, x, y, I0, dp) {
    var inv = 8 / (dp * dp);
    var rad = Math.ceil(dp * 1.3) + 1;
    var x0 = Math.max(0, Math.floor(x - rad)), x1 = Math.min(W - 1, Math.ceil(x + rad));
    var y0 = Math.max(0, Math.floor(y - rad)), y1 = Math.min(H - 1, Math.ceil(y + rad));
    for (var iy = y0; iy <= y1; iy++) {
      var dy = iy + 0.5 - y, row = iy * W;
      for (var ix = x0; ix <= x1; ix++) {
        var dx = ix + 0.5 - x;
        var e = inv * (dx * dx + dy * dy);
        if (e < 12) img[row + ix] += I0 * Math.exp(-e);
      }
    }
  }

  /* opts: width, height, flow (bound flow), nPerWindow (per 32x32 window),
   *       dp (particle image diameter, px), noise (% of full scale),
   *       background (counts), loss (fraction of pairs lost per frame), seed
   * returns { a, b, width, height, count, particles }
   */
  function generate(opts) {
    var W = opts.width, H = opts.height, flow = opts.flow;
    var dp = opts.dp, noise = opts.noise, bg = opts.background || 6;
    var loss = opts.loss || 0;
    var rand = rng(opts.seed || 1);

    var ppp = (opts.nPerWindow || 12) / (32 * 32);
    var margin = Math.ceil(3 * dp + Math.abs(opts.maxDisp || 8) + 4);
    var domW = W + 2 * margin, domH = H + 2 * margin;
    var N = Math.max(1, Math.round(ppp * domW * domH));

    var a = new Float32Array(W * H), b = new Float32Array(W * H);
    var pxa = new Float32Array(N), pya = new Float32Array(N);
    var pxb = new Float32Array(N), pyb = new Float32Array(N);
    var pint = new Float32Array(N);
    var d = [0, 0], i;

    var peak = 205;   /* mean peak intensity in counts, leaves headroom */

    for (i = 0; i < N; i++) {
      var x = -margin + rand() * domW;
      var y = -margin + rand() * domH;
      /* position across the light sheet, in units of the sheet half-thickness */
      var z = (rand() * 2 - 1) * 1.25;
      var I0 = peak * Math.exp(-2 * z * z) * (0.65 + 0.55 * rand());

      var lost = rand() < loss;
      var xb, yb;
      if (lost) {
        /* left the light sheet: an unrelated particle appears somewhere else */
        xb = -margin + rand() * domW;
        yb = -margin + rand() * domH;
      } else {
        flow.displacement(x, y, d, 4);
        xb = x + d[0]; yb = y + d[1];
      }

      pxa[i] = x; pya[i] = y; pxb[i] = xb; pyb[i] = yb; pint[i] = I0;

      var inA = !(flow.masked && flow.masked(x, y));
      var inB = !(flow.masked && flow.masked(xb, yb));
      if (inA) splat(a, W, H, x, y, I0, dp);
      if (inB) splat(b, W, H, xb, yb, I0, dp);
    }

    /* sensor: background + read noise + 8-bit quantisation (the source of peak locking) */
    var sigma = noise * 2.55;
    for (i = 0; i < a.length; i++) {
      var va = a[i] + bg + (sigma > 0 ? gauss(rand) * sigma : 0);
      var vb = b[i] + bg + (sigma > 0 ? gauss(rand) * sigma : 0);
      a[i] = Math.max(0, Math.min(255, Math.round(va)));
      b[i] = Math.max(0, Math.min(255, Math.round(vb)));
    }

    return {
      a: a, b: b, width: W, height: H, count: N,
      nPerWindow: opts.nPerWindow,
      particles: { xa: pxa, ya: pya, xb: pxb, yb: pyb, I: pint }
    };
  }

  /* Convert an uploaded image (ImageData) to a luminance Float32Array. */
  function fromImageData(data) {
    var n = data.width * data.height, out = new Float32Array(n), d = data.data;
    for (var i = 0; i < n; i++) {
      out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    return out;
  }

  root.PIVSim = root.PIVSim || {};
  root.PIVSim.Synth = { generate: generate, fromImageData: fromImageData, rng: rng };
})(typeof globalThis !== 'undefined' ? globalThis : this);
