/* PIV Simulator — canvas drawing.
 * Everything here takes image-pixel coordinates; the caller sets the transform.
 */
(function (root) {
  'use strict';

  var Color = root.PIVSim.Color;

  function offscreen(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* ---- particle images -------------------------------------------------- */

  /* Grayscale with a faint 532 nm cast, the way a Nd:YAG-lit frame reads. */
  function particleImage(ctx, img, W, H) {
    var out = ctx.createImageData(W, H), d = out.data;
    /* display gamma only — the correlation still runs on the raw counts */
    var lut = new Float32Array(256), t;
    for (t = 0; t < 256; t++) lut[t] = 255 * Math.pow(t / 255, 0.78);
    for (var i = 0, j = 0; i < img.length; i++, j += 4) {
      var v = lut[img[i] | 0];
      d[j] = v * 0.80;
      d[j + 1] = v;
      d[j + 2] = v * 0.86;
      d[j + 3] = 255;
    }
    return out;
  }

  /* Frame A in laser green, frame B in magenta: every paired particle shows as
   * a green dot with its magenta partner a few pixels away. */
  function pairImage(ctx, a, b, W, H) {
    var out = ctx.createImageData(W, H), d = out.data;
    var lut = new Float32Array(256), t;
    for (t = 0; t < 256; t++) lut[t] = 255 * Math.pow(t / 255, 0.78);
    for (var i = 0, j = 0; i < a.length; i++, j += 4) {
      var va = lut[a[i] | 0], vb = lut[b[i] | 0];
      d[j] = vb * 0.95;
      d[j + 1] = va;
      d[j + 2] = vb * 0.95;
      d[j + 3] = 255;
    }
    return out;
  }

  /* ---- scalar field raster ---------------------------------------------- */

  function fieldImage(ctx, res, scalar, range, ramp, theme, W, H, maskFn) {
    var out = ctx.createImageData(W, H), d = out.data;
    var nx = res.nx, ny = res.ny, step = res.step;
    var x0 = res.xs[0], y0 = res.ys[0];
    var lo = range[0], span = (range[1] - range[0]) || 1;
    var rgb = [0, 0, 0], st = res.status;

    function val(i, j) {
      i = i < 0 ? 0 : (i > nx - 1 ? nx - 1 : i);
      j = j < 0 ? 0 : (j > ny - 1 ? ny - 1 : j);
      return { v: scalar[j * nx + i], m: st[j * nx + i] === 2 };
    }

    for (var py = 0; py < H; py++) {
      var fy = (py + 0.5 - y0) / step;
      var j0 = Math.floor(fy), ty = fy - j0;
      for (var px = 0; px < W; px++) {
        var fx = (px + 0.5 - x0) / step;
        var i0 = Math.floor(fx), tx = fx - i0;
        var q00 = val(i0, j0), q10 = val(i0 + 1, j0), q01 = val(i0, j0 + 1), q11 = val(i0 + 1, j0 + 1);
        var k = (py * W + px) * 4;
        var near = (tx < 0.5 ? (ty < 0.5 ? q00 : q01) : (ty < 0.5 ? q10 : q11));
        /* inside the body there is no data — cut the hole on the real geometry,
         * not on the blocky set of masked vector cells */
        if (maskFn ? maskFn(px + 0.5, py + 0.5) : near.m) { d[k + 3] = 0; continue; }
        var v00 = q00.m ? near.v : q00.v, v10 = q10.m ? near.v : q10.v;
        var v01 = q01.m ? near.v : q01.v, v11 = q11.m ? near.v : q11.v;
        var v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        Color.sample(ramp, (v - lo) / span, theme, rgb);
        d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
      }
    }
    return out;
  }

  /* ---- vectors ---------------------------------------------------------- */

  /* opts: scale, lineWidth, color | ramp+range+theme, limit (progressive draw),
   *       showRejected, rejectedColor */
  function vectors(ctx, res, opts) {
    var n = res.nx * res.ny, limit = opts.limit === undefined ? n : opts.limit;
    var s = opts.scale, lw = opts.lineWidth || 1.1;
    var buckets = 14, paths = [], i;
    var colored = !!opts.ramp;
    for (i = 0; i < (colored ? buckets : 1); i++) paths.push(new Path2D());
    var rejected = new Path2D(), hasRejected = false;
    var lo = opts.range ? opts.range[0] : 0;
    var span = opts.range ? (opts.range[1] - opts.range[0]) || 1 : 1;

    for (var k = 0; k < limit && k < n; k++) {
      if (res.status[k] === 2) continue;
      var i0 = k % res.nx, j0 = (k - i0) / res.nx;
      var x = res.xs[i0], y = res.ys[j0];
      var u = res.u[k] * s, v = res.v[k] * s;
      var len = Math.hypot(u, v);
      var p;
      if (res.status[k] !== 0 && opts.showRejected) { p = rejected; hasRejected = true; }
      else if (colored) {
        var t = (Math.hypot(res.u[k], res.v[k]) - lo) / span;
        var b = Math.floor(t * buckets);
        p = paths[b < 0 ? 0 : (b > buckets - 1 ? buckets - 1 : b)];
      } else p = paths[0];

      if (len < 0.35) {           /* effectively still: a dot reads better than a stub */
        p.moveTo(x - 0.35, y);
        p.lineTo(x + 0.35, y);
        continue;
      }
      p.moveTo(x, y);
      p.lineTo(x + u, y + v);
      var hl = Math.min(len * 0.42, Math.max(2.2, s * 0.9));
      var ux = u / len, uy = v / len, a = 0.42;
      p.moveTo(x + u, y + v);
      p.lineTo(x + u - hl * (ux * Math.cos(a) - uy * Math.sin(a)),
               y + v - hl * (ux * Math.sin(a) + uy * Math.cos(a)));
      p.moveTo(x + u, y + v);
      p.lineTo(x + u - hl * (ux * Math.cos(-a) - uy * Math.sin(-a)),
               y + v - hl * (ux * Math.sin(-a) + uy * Math.cos(-a)));
    }

    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (opts.halo) {             /* dark outline keeps arrows legible on any ground */
      ctx.strokeStyle = opts.halo;
      ctx.lineWidth = lw + 1.4;
      for (i = 0; i < paths.length; i++) ctx.stroke(paths[i]);
      if (hasRejected) ctx.stroke(rejected);
      ctx.lineWidth = lw;
    }
    var rlo = opts.rampLo || 0;
    for (i = 0; i < paths.length; i++) {
      ctx.strokeStyle = colored
        ? Color.css(opts.ramp, rlo + (1 - rlo) * ((i + 0.5) / buckets), opts.theme)
        : opts.color;
      ctx.stroke(paths[i]);
    }
    if (hasRejected) {
      ctx.strokeStyle = opts.rejectedColor || '#E0574B';
      ctx.stroke(rejected);
    }
    ctx.restore();
  }

  /* Reference arrows from the analytic solution, drawn under the measured ones. */
  function truthVectors(ctx, res, truth, opts) {
    var p = new Path2D();
    for (var k = 0; k < res.nx * res.ny; k++) {
      if (res.status[k] === 2) continue;
      var i0 = k % res.nx, j0 = (k - i0) / res.nx;
      var x = res.xs[i0], y = res.ys[j0];
      var u = truth.tu[k] * opts.scale, v = truth.tv[k] * opts.scale;
      if (Math.hypot(u, v) < 0.3) continue;
      p.moveTo(x, y);
      p.lineTo(x + u, y + v);
    }
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.lineWidth || 2.4;
    ctx.lineCap = 'round';
    ctx.globalAlpha = opts.alpha === undefined ? 0.9 : opts.alpha;
    ctx.stroke(p);
    ctx.restore();
  }

  /* Error vectors, magnified: measured minus exact. */
  function errorVectors(ctx, res, truth, opts) {
    var p = new Path2D();
    for (var k = 0; k < res.nx * res.ny; k++) {
      if (res.status[k] === 2) continue;
      var i0 = k % res.nx, j0 = (k - i0) / res.nx;
      var x = res.xs[i0], y = res.ys[j0];
      var u = (res.u[k] - truth.tu[k]) * opts.scale, v = (res.v[k] - truth.tv[k]) * opts.scale;
      p.moveTo(x, y);
      p.lineTo(x + u, y + v);
    }
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.lineWidth || 1;
    ctx.lineCap = 'round';
    ctx.stroke(p);
    ctx.restore();
  }

  function grid(ctx, res, color, lw) {
    var p = new Path2D(), half = res.step / 2;
    var x0 = res.xs[0] - half, x1 = res.xs[res.nx - 1] + half;
    var y0 = res.ys[0] - half, y1 = res.ys[res.ny - 1] + half;
    for (var i = 0; i < res.nx; i++) {
      var x = res.xs[i] + half;
      p.moveTo(x, y0); p.lineTo(x, y1);
    }
    for (var j = 0; j < res.ny; j++) {
      var y = res.ys[j] + half;
      p.moveTo(x0, y); p.lineTo(x1, y);
    }
    p.moveTo(x0, y0); p.lineTo(x1, y0); p.lineTo(x1, y1); p.lineTo(x0, y1); p.closePath();
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 0.6;
    ctx.stroke(p);
    ctx.restore();
  }

  function body(ctx, flow, fill, stroke) {
    if (!flow || !flow.bodyPx) return;
    var b = flow.bodyPx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, 2 * Math.PI);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }

  function windowMarker(ctx, cx, cy, win, color, lw) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 1.6;
    ctx.setLineDash([]);
    ctx.strokeRect(Math.round(cx - win / 2), Math.round(cy - win / 2), win, win);
    ctx.restore();
  }

  /* ---- inspector panels ------------------------------------------------- */

  /* Interrogation window blown up, one sensor pixel per block. */
  function zoom(canvas, arr, win, tint) {
    var ctx = canvas.getContext('2d');
    var src = offscreen(win, win), sctx = src.getContext('2d');
    var data = sctx.createImageData(win, win), d = data.data, i, j;
    var max = 1;
    for (i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    for (i = 0, j = 0; i < arr.length; i++, j += 4) {
      var v = 255 * Math.pow(Math.max(0, arr[i]) / max, 0.85);
      d[j] = v * (tint ? 0.80 : 0.95);
      d[j + 1] = v;
      d[j + 2] = v * (tint ? 0.86 : 0.95);
      d[j + 3] = 255;
    }
    sctx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }

  /* Correlation plane as a heat map, with the peak called out. */
  function corrMap(canvas, insp, half, theme, ink) {
    var win = insp.win, map = insp.map, ctx = canvas.getContext('2d');
    var n = 2 * half + 1, c0 = win >> 1;
    var lo = Infinity, hi = -Infinity, i, j, v;
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        v = map[(c0 - half + j) * win + (c0 - half + i)];
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    var span = (hi - lo) || 1;
    var src = offscreen(n, n), sctx = src.getContext('2d');
    var data = sctx.createImageData(n, n), d = data.data, rgb = [0, 0, 0];
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        v = (map[(c0 - half + j) * win + (c0 - half + i)] - lo) / span;
        Color.sample('correlation', v, theme, rgb);
        var k = (j * n + i) * 4;
        d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
      }
    }
    sctx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    /* the plane is square; centre it in whatever box the panel gives us */
    var box = Math.min(canvas.width, canvas.height);
    var ox = (canvas.width - box) / 2, oy = (canvas.height - box) / 2;
    ctx.drawImage(src, ox, oy, box, box);

    /* peak crosshair, in sub-pixel position */
    var s = box / n;
    var px = ox + (insp.peak.dx + half + 0.5) * s;
    var py = oy + (insp.peak.dy + half + 0.5) * s;
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(px - 9, py); ctx.lineTo(px - 2.5, py);
    ctx.moveTo(px + 2.5, py); ctx.lineTo(px + 9, py);
    ctx.moveTo(px, py - 9); ctx.lineTo(px, py - 2.5);
    ctx.moveTo(px, py + 2.5); ctx.lineTo(px, py + 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, 2 * Math.PI);
    ctx.fillStyle = ink; ctx.fill();
    /* zero-displacement reference */
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(ox + (half + 0.5) * s, oy + (half + 0.5) * s, Math.max(3, s * 0.45), 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  /* The correlation plane as a surface — the iconic PIV picture. */
  function corrSurface(canvas, insp, half, theme, ink, accent) {
    var win = insp.win, map = insp.map, ctx = canvas.getContext('2d');
    var n = 2 * half + 1, c0 = win >> 1, i, j, v;
    var stride = Math.max(1, Math.round(n / 26));
    var m = Math.floor((n - 1) / stride) + 1;
    var z = new Float64Array(m * m), lo = Infinity, hi = -Infinity;
    for (j = 0; j < m; j++) {
      for (i = 0; i < m; i++) {
        v = map[(c0 - half + j * stride) * win + (c0 - half + i * stride)];
        z[j * m + i] = v;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    var span = (hi - lo) || 1;
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var ax = W * 0.40 / (m - 1), ay = H * 0.17 / (m - 1), az = H * 0.56;
    var cx = W / 2, cy = H * 0.74;
    function proj(i, j, h) {
      return [cx + (i - (m - 1) / 2) * ax - (j - (m - 1) / 2) * ax,
              cy + ((i - (m - 1) / 2) + (j - (m - 1) / 2)) * ay - h * az];
    }
    var rgb = [0, 0, 0];
    /* painter's order: far cells (small i+j) first */
    var cells = [];
    for (j = 0; j < m - 1; j++) for (i = 0; i < m - 1; i++) cells.push([i, j]);
    cells.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); });
    ctx.lineWidth = 0.5;
    for (var q = 0; q < cells.length; q++) {
      var ii = cells[q][0], jj = cells[q][1];
      var h00 = (z[jj * m + ii] - lo) / span, h10 = (z[jj * m + ii + 1] - lo) / span;
      var h01 = (z[(jj + 1) * m + ii] - lo) / span, h11 = (z[(jj + 1) * m + ii + 1] - lo) / span;
      var p00 = proj(ii, jj, h00), p10 = proj(ii + 1, jj, h10);
      var p11 = proj(ii + 1, jj + 1, h11), p01 = proj(ii, jj + 1, h01);
      var hm = (h00 + h10 + h01 + h11) / 4;
      Color.sample('correlation', hm, theme, rgb);
      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]); ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]); ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();
      ctx.fillStyle = 'rgb(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.stroke();
    }
    /* marker on the fitted peak */
    var pi = (insp.peak.ix - (c0 - half)) / stride, pj = (insp.peak.iy - (c0 - half)) / stride;
    var top = proj(pi, pj, 1.0);
    var base = proj(pi, pj, (insp.peak.peak - lo) / span);
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(base[0], base[1] - 4); ctx.lineTo(top[0], top[1] - 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(base[0], base[1], 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = accent; ctx.fill();
    ctx.restore();
  }

  root.PIVSim.Render = {
    offscreen: offscreen, particleImage: particleImage, pairImage: pairImage,
    fieldImage: fieldImage, vectors: vectors, truthVectors: truthVectors,
    errorVectors: errorVectors, grid: grid, body: body, windowMarker: windowMarker,
    zoom: zoom, corrMap: corrMap, corrSurface: corrSurface
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
