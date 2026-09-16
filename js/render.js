/* PIV Simulator — 캔버스 그리기.
 * 좌표는 전부 영상 픽셀 기준이고, 변환은 부르는 쪽에서 건다.
 *
 * 입자 영상은 반전해서(흰 바닥·검은 입자) 그린다. 실제 PIV 원본은 검은
 * 바탕이지만, 논문 그림과 인쇄가 전부 흰 바닥이라 학술 그림에서는 반전해
 * 싣는 것이 관행이고, 흰 바닥 위에서는 navy 화살표가 그대로 읽힌다.
 * 상관 계산은 언제나 반전 전의 원본 값으로 한다.
 */
(function (root) {
  'use strict';

  var Color = root.PIVSim.Color;

  function offscreen(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* 표시용 밝기 범위 — 계산에는 쓰지 않는다.
   *
   * 바탕값과 입자값을 영상 히스토그램에서 직접 찾아 0~1 로 편다. 고정된
   * 범위를 쓰면 시트 두께·노이즈·씨딩을 바꿀 때마다 바탕이 회색으로 뜨거나
   * 입자가 사라진다. 올린 영상이 이미 흰 바탕이면(입자가 어두우면) 그쪽
   * 극성을 알아서 잡는다. 상관은 어느 극성이든 같은 답을 준다 — 평균을 뺀
   * 상관에서 부호를 뒤집어도 conj(-A)(-B) = conj(A)B 이기 때문이다.
   *
   * 돌려주는 값은 "입자다움" 0~1 이고, 그리는 쪽에서 흰 바닥에 그만큼 잉크를
   * 얹는다.
   */
  function displayLUT(img) {
    var hist = new Uint32Array(256), i, n = img.length;
    for (i = 0; i < n; i++) hist[img[i] | 0]++;
    function pct(p) {
      var target = n * p, acc = 0;
      for (var k = 0; k < 256; k++) { acc += hist[k]; if (acc >= target) return k; }
      return 255;
    }
    var bg, sig;
    if (pct(0.2) > 140) { bg = pct(0.8); sig = pct(0.005); }   /* 이미 흰 바탕 */
    else { bg = pct(0.2); sig = pct(0.995); }                  /* 보통의 PIV 원본 */
    var span = sig - bg;
    if (Math.abs(span) < 8) span = span < 0 ? -8 : 8;
    var lut = new Float32Array(256);
    for (i = 0; i < 256; i++) {
      var tt = (i - bg) / span;
      lut[i] = Math.pow(tt < 0 ? 0 : (tt > 1 ? 1 : tt), 0.72);
    }
    return lut;
  }

  /* ---- 입자 영상 -------------------------------------------------------- */

  function particleImage(ctx, img, W, H) {
    var out = ctx.createImageData(W, H), d = out.data, L = displayLUT(img);
    for (var i = 0, j = 0; i < img.length; i++, j += 4) {
      var v = L[img[i] | 0];              /* 0..1, 밝을수록 입자 */
      d[j] = 255 - 246 * v;               /* 반전: 입자는 짙은 남색 기미 */
      d[j + 1] = 255 - 249 * v;
      d[j + 2] = 255 - 236 * v;
      d[j + 3] = 255;
    }
    return out;
  }

  /* 두 프레임을 한 장에: A 는 navy, B 는 ochre 로 감산 혼합.
   * 짝지어진 입자는 남색 점 옆에 황토색 점으로 보인다. */
  function pairImage(ctx, a, b, W, H) {
    var out = ctx.createImageData(W, H), d = out.data, L = displayLUT(a);
    /* 흰 바닥에서 뺄 양 = 255 - 색 */
    var ar = 255 - 15, ag = 255 - 76, ab = 255 - 129;     /* --c1 #0f4c81 */
    var br = 255 - 168, bg = 255 - 118, bb = 255 - 31;    /* --c2 #a8761f */
    for (var i = 0, j = 0; i < a.length; i++, j += 4) {
      var va = L[a[i] | 0], vb = L[b[i] | 0];
      d[j] = Math.max(0, 255 - (va * ar + vb * br));
      d[j + 1] = Math.max(0, 255 - (va * ag + vb * bg));
      d[j + 2] = Math.max(0, 255 - (va * ab + vb * bb));
      d[j + 3] = 255;
    }
    return out;
  }

  /* ---- 스칼라장 래스터 --------------------------------------------------- */

  function fieldImage(ctx, res, scalar, range, ramp, W, H, maskFn) {
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
        /* 물체 안은 값이 없다 — 벡터 칸이 아니라 실제 형상으로 도려낸다 */
        if (maskFn ? maskFn(px + 0.5, py + 0.5) : near.m) { d[k + 3] = 0; continue; }
        var v00 = q00.m ? near.v : q00.v, v10 = q10.m ? near.v : q10.v;
        var v01 = q01.m ? near.v : q01.v, v11 = q11.m ? near.v : q11.v;
        var v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        Color.sample(ramp, (v - lo) / span, rgb);
        d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
      }
    }
    return out;
  }

  /* ---- 벡터 ------------------------------------------------------------- */

  /* opts: scale, lineWidth, color, halo, limit, showRejected, rejectedColor */
  function vectors(ctx, res, opts) {
    var n = res.nx * res.ny, limit = opts.limit === undefined ? n : opts.limit;
    var s = opts.scale, lw = opts.lineWidth || 1.1;
    var main = new Path2D(), rejected = new Path2D(), hasRejected = false;

    for (var k = 0; k < limit && k < n; k++) {
      if (res.status[k] === 2) continue;
      var i0 = k % res.nx, j0 = (k - i0) / res.nx;
      var x = res.xs[i0], y = res.ys[j0];
      var u = res.u[k] * s, v = res.v[k] * s;
      var len = Math.hypot(u, v);
      var p = main;
      if (res.status[k] !== 0 && opts.showRejected) { p = rejected; hasRejected = true; }

      if (len < 0.35) {           /* 거의 정지 — 토막보다 점이 낫다 */
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
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (opts.halo) {
      ctx.strokeStyle = opts.halo;
      ctx.lineWidth = lw + 1.5;
      ctx.stroke(main);
      if (hasRejected) ctx.stroke(rejected);
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = opts.color;
    ctx.stroke(main);
    if (hasRejected) {
      ctx.strokeStyle = opts.rejectedColor || '#a83f2b';
      ctx.stroke(rejected);
    }
    ctx.restore();
  }

  /* 참값 — 측정 화살표 밑에 깔리는 넓은 띠. 둘이 맞으면 띠가 화살표를
   * 감싸고, 틀리면 띠가 옆으로 삐져나온다. */
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

  function errorVectors(ctx, res, truth, opts) {
    var p = new Path2D();
    for (var k = 0; k < res.nx * res.ny; k++) {
      if (res.status[k] === 2) continue;
      var i0 = k % res.nx, j0 = (k - i0) / res.nx;
      var x = res.xs[i0], y = res.ys[j0];
      p.moveTo(x, y);
      p.lineTo(x + (res.u[k] - truth.tu[k]) * opts.scale,
               y + (res.v[k] - truth.tv[k]) * opts.scale);
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

  function windowMarker(ctx, cx, cy, win, color, lw, halo) {
    var x = Math.round(cx - win / 2), y = Math.round(cy - win / 2);
    ctx.save();
    if (halo) {
      ctx.strokeStyle = halo;
      ctx.lineWidth = (lw || 1.6) + 1.6;
      ctx.strokeRect(x, y, win, win);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 1.6;
    ctx.strokeRect(x, y, win, win);
    ctx.restore();
  }

  /* ---- 상관 현미경 ------------------------------------------------------ */

  /* 조사창 확대 — 센서 픽셀 한 칸이 한 블록. 영상과 같이 반전한다. */
  function zoom(canvas, arr, win) {
    var ctx = canvas.getContext('2d');
    var src = offscreen(win, win), sctx = src.getContext('2d');
    var data = sctx.createImageData(win, win), d = data.data, i, j;
    var L = displayLUT(arr);
    for (i = 0, j = 0; i < arr.length; i++, j += 4) {
      var v = L[arr[i] | 0];
      d[j] = 255 - 246 * v;
      d[j + 1] = 255 - 249 * v;
      d[j + 2] = 255 - 236 * v;
      d[j + 3] = 255;
    }
    sctx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }

  /* 상관면 — 평면 */
  function corrMap(canvas, insp, half) {
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
        Color.sample('field', v, rgb);
        var k = (j * n + i) * 4;
        d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
      }
    }
    sctx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var box = Math.min(canvas.width, canvas.height);
    var ox = (canvas.width - box) / 2, oy = (canvas.height - box) / 2;
    ctx.drawImage(src, ox, oy, box, box);

    var s = box / n;
    var px = ox + (insp.peak.dx + half + 0.5) * s;
    var py = oy + (insp.peak.dy + half + 0.5) * s;
    ctx.save();
    /* 십자선은 흰 테를 깔고 잉크로 — viridis 양 끝에서 모두 읽힌다 */
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? '#15181c' : 'rgba(255,255,255,.85)';
      ctx.lineWidth = pass ? 1.4 : 3.4;
      ctx.beginPath();
      ctx.moveTo(px - 10, py); ctx.lineTo(px - 3, py);
      ctx.moveTo(px + 3, py); ctx.lineTo(px + 10, py);
      ctx.moveTo(px, py - 10); ctx.lineTo(px, py - 3);
      ctx.moveTo(px, py + 3); ctx.lineTo(px, py + 10);
      ctx.stroke();
    }
    /* 변위 0 자리 */
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ox + (half + 0.5) * s, oy + (half + 0.5) * s, Math.max(3, s * 0.45), 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  /* 상관면 — 입체. PIV 에서 가장 많이 보는 그림이다. */
  function corrSurface(canvas, insp, half, markColor) {
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
    var cx = W / 2, cy = H * 0.76;
    function proj(i, j, h) {
      return [cx + (i - (m - 1) / 2) * ax - (j - (m - 1) / 2) * ax,
              cy + ((i - (m - 1) / 2) + (j - (m - 1) / 2)) * ay - h * az];
    }
    var rgb = [0, 0, 0], cells = [];
    for (j = 0; j < m - 1; j++) for (i = 0; i < m - 1; i++) cells.push([i, j]);
    cells.sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); });
    ctx.lineWidth = 0.5;
    for (var q = 0; q < cells.length; q++) {
      var ii = cells[q][0], jj = cells[q][1];
      var h00 = (z[jj * m + ii] - lo) / span, h10 = (z[jj * m + ii + 1] - lo) / span;
      var h01 = (z[(jj + 1) * m + ii] - lo) / span, h11 = (z[(jj + 1) * m + ii + 1] - lo) / span;
      var p00 = proj(ii, jj, h00), p10 = proj(ii + 1, jj, h10);
      var p11 = proj(ii + 1, jj + 1, h11), p01 = proj(ii, jj + 1, h01);
      Color.sample('field', (h00 + h10 + h01 + h11) / 4, rgb);
      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]); ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]); ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();
      ctx.fillStyle = 'rgb(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.stroke();
    }
    var pi = (insp.peak.ix - (c0 - half)) / stride, pj = (insp.peak.iy - (c0 - half)) / stride;
    var top = proj(pi, pj, 1.0);
    var base = proj(pi, pj, (insp.peak.peak - lo) / span);
    ctx.save();
    ctx.strokeStyle = markColor || '#15181c';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(base[0], base[1] - 4); ctx.lineTo(top[0], top[1] - 12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(base[0], base[1], 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = markColor || '#15181c'; ctx.fill();
    ctx.restore();
  }

  root.PIVSim.Render = {
    offscreen: offscreen, particleImage: particleImage, pairImage: pairImage,
    fieldImage: fieldImage, vectors: vectors, truthVectors: truthVectors,
    errorVectors: errorVectors, grid: grid, body: body, windowMarker: windowMarker,
    zoom: zoom, corrMap: corrMap, corrSurface: corrSurface
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
