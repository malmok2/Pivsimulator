/* PIV Simulator — the cross-correlation engine.
 *
 * Multi-pass FFT cross-correlation with symmetric window shifting,
 * three-point sub-pixel peak fitting, primary-peak-ratio SNR, and the
 * universal median test for outlier detection (Westerweel & Scarano, 2005).
 */
(function (root) {
  'use strict';

  var FFT = root.PIVSim.FFT;

  /* ---- window extraction (edge pixels replicated) ---------------------- */
  function extract(img, W, H, cx, cy, win, offx, offy, dst) {
    var x0 = Math.round(cx - win / 2) + offx;
    var y0 = Math.round(cy - win / 2) + offy;
    for (var j = 0; j < win; j++) {
      var sy = y0 + j;
      sy = sy < 0 ? 0 : (sy > H - 1 ? H - 1 : sy);
      var srow = sy * W, drow = j * win;
      for (var i = 0; i < win; i++) {
        var sx = x0 + i;
        sx = sx < 0 ? 0 : (sx > W - 1 ? W - 1 : sx);
        dst[drow + i] = img[srow + sx];
      }
    }
  }

  /* ---- sub-pixel peak fitting ------------------------------------------ */
  function subpixel(cm, c0, cp, mode) {
    var den;
    if (mode === 'centroid') {
      var s = cm + c0 + cp;
      return s > 0 ? (cp - cm) / s : 0;
    }
    if (mode !== 'parabolic' && cm > 0 && c0 > 0 && cp > 0) {
      var lm = Math.log(cm), l0 = Math.log(c0), lp = Math.log(cp);
      den = 2 * lm - 4 * l0 + 2 * lp;
      if (Math.abs(den) > 1e-12) {
        var d = (lm - lp) / den;
        if (d > -1 && d < 1) return d;
      }
    }
    den = 2 * cm - 4 * c0 + 2 * cp;
    if (Math.abs(den) > 1e-12) {
      var p = (cm - cp) / den;
      if (p > -1 && p < 1) return p;
    }
    return 0;
  }

  /* Locate the peak of a correlation map and fit it to sub-pixel accuracy.
   * Returns { dx, dy, peak, snr, ix, iy } with dx,dy in pixels. */
  function peakFit(map, win, limit, mode) {
    var half = win >> 1, best = -Infinity, bx = half, by = half, ix, iy;
    var lo = Math.max(1, half - limit), hi = Math.min(win - 2, half + limit);
    for (iy = lo; iy <= hi; iy++) {
      for (ix = lo; ix <= hi; ix++) {
        var v = map[iy * win + ix];
        if (v > best) { best = v; bx = ix; by = iy; }
      }
    }
    /* second highest peak outside a 5x5 block around the primary one */
    var second = -Infinity;
    for (iy = lo; iy <= hi; iy++) {
      for (ix = lo; ix <= hi; ix++) {
        if (Math.abs(ix - bx) <= 2 && Math.abs(iy - by) <= 2) continue;
        var w = map[iy * win + ix];
        if (w > second) second = w;
      }
    }
    var dxs = subpixel(map[by * win + bx - 1], best, map[by * win + bx + 1], mode);
    var dys = subpixel(map[(by - 1) * win + bx], best, map[(by + 1) * win + bx], mode);
    return {
      dx: (bx - half) + dxs, dy: (by - half) + dys,
      sx: dxs, sy: dys,                 /* what the sub-pixel fit contributed */
      peak: best, snr: second > 1e-6 ? best / second : 99,
      ix: bx, iy: by
    };
  }

  /* ---- grid ------------------------------------------------------------- */
  function makeGrid(W, H, win, overlap) {
    var step = Math.max(1, Math.round(win * (1 - overlap)));
    var nx = Math.max(1, Math.floor((W - win) / step) + 1);
    var ny = Math.max(1, Math.floor((H - win) / step) + 1);
    var x0 = (W - ((nx - 1) * step + win)) / 2 + win / 2;
    var y0 = (H - ((ny - 1) * step + win)) / 2 + win / 2;
    var xs = new Float32Array(nx), ys = new Float32Array(ny), i;
    for (i = 0; i < nx; i++) xs[i] = x0 + i * step;
    for (i = 0; i < ny; i++) ys[i] = y0 + i * step;
    return { win: win, step: step, nx: nx, ny: ny, xs: xs, ys: ys, n: nx * ny };
  }

  /* bilinear sample of a previous pass onto an arbitrary point */
  function sampleField(g, arr, x, y) {
    var fx = (x - g.xs[0]) / g.step, fy = (y - g.ys[0]) / g.step;
    var i0 = Math.floor(fx), j0 = Math.floor(fy);
    i0 = i0 < 0 ? 0 : (i0 > g.nx - 1 ? g.nx - 1 : i0);
    j0 = j0 < 0 ? 0 : (j0 > g.ny - 1 ? g.ny - 1 : j0);
    var i1 = Math.min(g.nx - 1, i0 + 1), j1 = Math.min(g.ny - 1, j0 + 1);
    var tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
    var a = arr[j0 * g.nx + i0], b = arr[j0 * g.nx + i1];
    var c = arr[j1 * g.nx + i0], d = arr[j1 * g.nx + i1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /* ---- universal median test ------------------------------------------- */
  function median(list, n) {
    if (n === 0) return 0;
    var s = list.slice(0, n).sort(function (a, b) { return a - b; });
    var h = n >> 1;
    return n % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]);
  }

  /* Universal median test. The full 3x3 stencil gets the nominal threshold;
   * a border vector, whose neighbours all sit on one side, sees a relaxed one -
   * otherwise a plain velocity gradient reads as an outlier along every edge.
   *
   * status: 0 valid, 1 median-test outlier, 2 masked, 3 weak correlation.
   * Vectors flagged 1 or 3 are replaced by the median of their valid neighbours.
   */
  function validate(g, u, v, status, threshold) {
    var nx = g.nx, ny = g.ny, n = nx * ny;
    var un = new Float64Array(8), vn = new Float64Array(8), res = new Float64Array(8);
    var outliers = 0, weak = 0, i, j, k, di, dj, ii, jj, kk, q;

    for (i = 0; i < n; i++) if (status[i] === 3) weak++;

    /* gather only trusted neighbours (valid so far) */
    function gather(i, j) {
      var m = 0;
      for (dj = -1; dj <= 1; dj++) {
        for (di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          ii = i + di; jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          kk = jj * nx + ii;
          if (status[kk] !== 0) continue;
          un[m] = u[kk]; vn[m] = v[kk]; m++;
        }
      }
      return m;
    }

    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        k = j * nx + i;
        if (status[k] !== 0) continue;
        var m = gather(i, j);
        if (m < 4) continue;
        var thr = (m === 8) ? threshold : threshold * 2.5;
        var um = median(un, m), vm = median(vn, m);
        for (q = 0; q < m; q++) res[q] = Math.abs(un[q] - um);
        var ru = Math.abs(u[k] - um) / (median(res, m) + 0.1);
        for (q = 0; q < m; q++) res[q] = Math.abs(vn[q] - vm);
        var rv = Math.abs(v[k] - vm) / (median(res, m) + 0.1);
        if (Math.max(ru, rv) > thr) { status[k] = 1; outliers++; }
      }
    }

    /* fill every rejected vector from its valid neighbours */
    for (var pass = 0; pass < 3; pass++) {
      var uu = Float32Array.from(u), vv = Float32Array.from(v), changed = 0;
      for (j = 0; j < ny; j++) {
        for (i = 0; i < nx; i++) {
          k = j * nx + i;
          if (status[k] !== 1 && status[k] !== 3) continue;
          var su = 0, sv = 0, c = 0;
          for (dj = -1; dj <= 1; dj++) {
            for (di = -1; di <= 1; di++) {
              if (!di && !dj) continue;
              ii = i + di; jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
              kk = jj * nx + ii;
              if (status[kk] === 2) continue;
              if (pass === 0 && status[kk] !== 0) continue;
              su += u[kk]; sv += v[kk]; c++;
            }
          }
          if (c) { uu[k] = su / c; vv[k] = sv / c; changed++; }
        }
      }
      u.set(uu); v.set(vv);
      if (!changed) break;
    }
    return { outliers: outliers, weak: weak };
  }

  /* Predictor field for the next pass: masked holes filled from their
   * neighbours, then one light 3x3 smoothing so a single bad spot cannot
   * drag the finer pass off the peak. */
  function predictor(g, src, status) {
    var nx = g.nx, ny = g.ny, n = nx * ny;
    var f = Float32Array.from(src), i, j, k;
    for (var it = 0; it < 2; it++) {
      for (j = 0; j < ny; j++) {
        for (i = 0; i < nx; i++) {
          k = j * nx + i;
          if (status[k] !== 2) continue;
          var s = 0, m = 0;
          for (var dj = -1; dj <= 1; dj++) {
            for (var di = -1; di <= 1; di++) {
              var ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
              var kk = jj * nx + ii;
              if (status[kk] === 2) continue;
              s += f[kk]; m++;
            }
          }
          if (m) f[k] = s / m;
        }
      }
    }
    var out = new Float32Array(n);
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var t = 0, c = 0;
        for (var b = -1; b <= 1; b++) {
          for (var a = -1; a <= 1; a++) {
            var x = i + a, y = j + b;
            if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
            t += f[y * nx + x]; c++;
          }
        }
        out[j * nx + i] = t / c;
      }
    }
    return out;
  }

  /* ---- main ------------------------------------------------------------- */
  /* cfg: imgA, imgB, width, height, win, overlap, passes, subpixel,
   *      threshold, replace, masked(x,y), snrMin */
  function run(cfg) {
    var t0 = (root.performance || Date).now();
    var W = cfg.width, H = cfg.height;
    var nPasses = Math.max(1, cfg.passes || 1);
    var mode = cfg.subpixel || 'gauss';
    var prev = null, prevU = null, prevV = null, grid = null;
    var u = null, v = null;
    var passInfo = [];

    /* The first pass must still resolve the flow: a window wider than a quarter
     * of the image gives too few vectors for the median test to police. */
    var capWin = Math.pow(2, Math.floor(Math.log(Math.min(W, H) / 4) / Math.LN2));
    var maxWin = Math.max(cfg.win, Math.min(capWin, cfg.win * Math.pow(2, nPasses - 1)));
    var sched = [];
    for (var q = 0; q < nPasses; q++) {
      var wq = Math.min(cfg.win * Math.pow(2, nPasses - 1 - q), maxWin);
      if (sched[sched.length - 1] !== wq) sched.push(wq);   /* capping can repeat */
    }
    nPasses = sched.length;

    for (var p = 0; p < nPasses; p++) {
      var win = sched[p];
      /* coarse passes overlap more so the outlier test has real neighbours */
      var overlap = (p === nPasses - 1) ? cfg.overlap : Math.max(cfg.overlap, 0.5);
      grid = makeGrid(W, H, win, overlap);
      var m = grid.n;
      u = new Float32Array(m); v = new Float32Array(m);
      var uRaw = new Float32Array(m), vRaw = new Float32Array(m);
      var snr = new Float32Array(m), corr = new Float32Array(m);
      var status = new Uint8Array(m);
      var shx = new Int16Array(m), shy = new Int16Array(m);

      var wa = new Float64Array(win * win), wb = new Float64Array(win * win);
      var map = new Float64Array(win * win);
      /* the quarter rule: a displacement beyond win/4 cannot be trusted, and
       * allowing the search that far out only invites wrap-around peaks */
      var limit = (p === 0) ? Math.max(3, Math.round(win / 3)) : Math.max(3, win >> 2);

      for (var j = 0; j < grid.ny; j++) {
        for (var i = 0; i < grid.nx; i++) {
          var k = j * grid.nx + i;
          var cx = grid.xs[i], cy = grid.ys[j];

          if (cfg.masked && cfg.masked(cx, cy)) { status[k] = 2; continue; }

          var px = 0, py = 0;
          if (prev) {
            px = sampleField(prev, prevU, cx, cy);
            py = sampleField(prev, prevV, cx, cy);
          }
          var sx = Math.round(px), sy = Math.round(py);
          var offBx = Math.round(sx / 2), offAx = offBx - sx;
          var offBy = Math.round(sy / 2), offAy = offBy - sy;
          shx[k] = sx; shy[k] = sy;

          extract(cfg.imgA, W, H, cx, cy, win, offAx, offAy, wa);
          extract(cfg.imgB, W, H, cx, cy, win, offBx, offBy, wb);
          FFT.correlate(wa, wb, win, map);
          var pk = peakFit(map, win, limit, mode);

          u[k] = uRaw[k] = sx + pk.dx;
          v[k] = vRaw[k] = sy + pk.dy;
          snr[k] = pk.snr; corr[k] = pk.peak;
          if (pk.snr < (cfg.snrMin || 1.2) || pk.peak < (cfg.corrMin || 0.05)) status[k] = 3;
        }
        if (cfg.onProgress) cfg.onProgress((p + (j + 1) / grid.ny) / nPasses);
      }

      var vinfo = validate(grid, u, v, status, cfg.threshold || 2);
      passInfo.push({
        win: win, step: grid.step, vectors: m,
        outliers: vinfo.outliers, weak: vinfo.weak
      });

      prev = grid;
      prevU = predictor(grid, u, status);
      prevV = predictor(grid, v, status);
      if (p === nPasses - 1) {
        return {
          grid: grid, win: win, step: grid.step, nx: grid.nx, ny: grid.ny,
          xs: grid.xs, ys: grid.ys,
          u: u, v: v, uRaw: uRaw, vRaw: vRaw, snr: snr, corr: corr,
          status: status, shiftX: shx, shiftY: shy,
          passes: passInfo, subpixel: mode,
          ms: (root.performance || Date).now() - t0
        };
      }
    }
  }

  /* Recompute one interrogation spot for the inspector panel. */
  function inspect(cfg, res, index) {
    var i = index % res.nx, j = Math.floor(index / res.nx);
    var win = res.win, cx = res.xs[i], cy = res.ys[j];
    var sx = res.shiftX[index], sy = res.shiftY[index];
    var offBx = Math.round(sx / 2), offAx = offBx - sx;
    var offBy = Math.round(sy / 2), offAy = offBy - sy;
    var wa = new Float64Array(win * win), wb = new Float64Array(win * win);
    var map = new Float64Array(win * win);
    extract(cfg.imgA, cfg.width, cfg.height, cx, cy, win, offAx, offAy, wa);
    extract(cfg.imgB, cfg.width, cfg.height, cx, cy, win, offBx, offBy, wb);
    FFT.correlate(wa, wb, win, map);
    var limit = res.passes.length > 1 ? Math.max(3, win >> 2) : Math.max(3, Math.round(win / 3));
    var pk = peakFit(map, win, limit, res.subpixel);
    return {
      i: i, j: j, cx: cx, cy: cy, win: win, a: wa, b: wb, map: map,
      shiftX: sx, shiftY: sy, peak: pk, limit: limit,
      u: sx + pk.dx, v: sy + pk.dy
    };
  }

  /* Derived scalar fields: speed, vorticity and divergence (per frame). */
  function derive(res) {
    var nx = res.nx, ny = res.ny, h = res.step, n = nx * ny;
    var mag = new Float32Array(n), vort = new Float32Array(n), div = new Float32Array(n);
    /* Central difference inside, one-sided at an image border or next to a
     * masked cell: a clamped central difference would halve every gradient
     * along the edge, and differencing across a body wall would invent
     * vorticity that is not in the flow. */
    var st = res.status;
    function ok(i, j) {
      return i >= 0 && j >= 0 && i < nx && j < ny && st[j * nx + i] !== 2;
    }
    function ddx(arr, i, j) {
      var k = j * nx, l = ok(i - 1, j), r = ok(i + 1, j);
      if (l && r) return (arr[k + i + 1] - arr[k + i - 1]) / (2 * h);
      if (r) return (arr[k + i + 1] - arr[k + i]) / h;
      if (l) return (arr[k + i] - arr[k + i - 1]) / h;
      return 0;
    }
    function ddy(arr, i, j) {
      var d = ok(i, j - 1), u = ok(i, j + 1);
      if (d && u) return (arr[(j + 1) * nx + i] - arr[(j - 1) * nx + i]) / (2 * h);
      if (u) return (arr[(j + 1) * nx + i] - arr[j * nx + i]) / h;
      if (d) return (arr[j * nx + i] - arr[(j - 1) * nx + i]) / h;
      return 0;
    }
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var k = j * nx + i;
        mag[k] = Math.hypot(res.u[k], res.v[k]);
        var dvdx = ddx(res.v, i, j);
        var dudy = ddy(res.u, i, j);
        var dudx = ddx(res.u, i, j);
        var dvdy = ddy(res.v, i, j);
        /* image y points down, so in-plane vorticity flips sign */
        vort[k] = -(dvdx - dudy);
        div[k] = dudx + dvdy;
      }
    }
    return { mag: mag, vort: vort, div: div };
  }

  /* Exact displacement at every vector location, plus error statistics. */
  function truth(res, flow) {
    var n = res.nx * res.ny;
    var tu = new Float32Array(n), tv = new Float32Array(n);
    var err = new Float32Array(n), d = [0, 0];
    var sum2 = 0, sumx = 0, sumy = 0, cnt = 0, max = 0;
    for (var j = 0; j < res.ny; j++) {
      for (var i = 0; i < res.nx; i++) {
        var k = j * res.nx + i;
        flow.displacement(res.xs[i], res.ys[j], d, 4);
        tu[k] = d[0]; tv[k] = d[1];
        if (res.status[k] === 2) { err[k] = NaN; continue; }
        var ex = res.u[k] - d[0], ey = res.v[k] - d[1];
        err[k] = Math.hypot(ex, ey);
        sum2 += ex * ex + ey * ey; sumx += ex; sumy += ey; cnt++;
        if (err[k] > max) max = err[k];
      }
    }
    return {
      tu: tu, tv: tv, err: err, count: cnt,
      rms: cnt ? Math.sqrt(sum2 / cnt) : 0,
      biasX: cnt ? sumx / cnt : 0, biasY: cnt ? sumy / cnt : 0,
      max: max
    };
  }

  root.PIVSim.PIV = {
    run: run, inspect: inspect, derive: derive, truth: truth,
    extract: extract, peakFit: peakFit, makeGrid: makeGrid, subpixel: subpixel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
