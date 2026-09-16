/* PIV Simulator — UI controller.
 * Owns the state, drives synthesis -> correlation -> drawing, and keeps the
 * inspector, the metrics and the diagnostics in step with each other.
 */
(function (root) {
  'use strict';

  var Flow = root.PIVSim.Flow, Synth = root.PIVSim.Synth, PIV = root.PIVSim.PIV;
  var R = root.PIVSim.Render, Color = root.PIVSim.Color, I18N = root.PIVSim.I18N;

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    themeMode: 'auto', theme: 'light',
    size: 384, field: 'cylinder', disp: 6,
    seed: 14, dp: 2.6, noise: 1.5, loss: 5,
    win: 32, overlap: 0.5, passes: 3, subpix: 'gauss', thresh: 2,
    bg: 'a', arrow: 1, step: 0,
    ov: { vectors: true, truth: false, error: false, grid: false },
    corrMode: '3d',
    rngSeed: 7,
    flow: null, img: null, res: null, truth: null, der: null,
    uploaded: null, pendingA: null, pendingB: null,
    picked: -1, insp: null,
    busy: false
  };

  var stage = $('stage'), ctx = stage.getContext('2d');
  var bgCanvas = R.offscreen(8, 8), fgCanvas = R.offscreen(8, 8);
  var bgKey = '', reveal = { n: 0, target: 0, raf: 0, t0: 0 };
  var blink = { raf: 0, on: false, phase: 0 };

  /* ---------- storage (per-viewer convenience only) --------------------- */
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem('piv.' + k); localStorage.setItem('piv.' + k, v); }
    catch (e) { return null; }
  }

  /* ---------- theme ------------------------------------------------------ */
  function resolveTheme() {
    if (S.themeMode === 'auto') {
      var m = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      S.theme = m && m.matches ? 'dark' : 'light';
      document.documentElement.removeAttribute('data-theme');
    } else {
      S.theme = S.themeMode;
      document.documentElement.setAttribute('data-theme', S.theme);
    }
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------- controls --------------------------------------------------- */
  function buildFlowSelect() {
    var sel = $('flowKind'), groups = {}, order = [];
    sel.innerHTML = '';
    Flow.fields.forEach(function (f) {
      if (!groups[f.group]) { groups[f.group] = []; order.push(f.group); }
      groups[f.group].push(f);
    });
    order.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = I18N.t('grp.' + g);
      groups[g].forEach(function (f) {
        var o = document.createElement('option');
        o.value = f.id;
        o.textContent = I18N.t('f.' + f.id);
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = S.field;
  }

  function fmt(v, n) { return v.toFixed(n === undefined ? 2 : n); }

  function syncLabels() {
    $('dispVal').textContent = fmt(S.disp, 1) + ' px';
    $('seedVal').textContent = S.seed + (I18N.lang === 'ko' ? ' 개' : '');
    $('dpVal').textContent = fmt(S.dp, 1) + ' px';
    $('noiseVal').textContent = fmt(S.noise, 1) + ' %';
    $('lossVal').textContent = S.loss + ' %';
    $('scaleVal').textContent = '× ' + fmt(S.arrow, 1);
  }

  function readControls() {
    S.field = $('flowKind').value || S.field;
    S.disp = +$('dispRange').value;
    S.seed = +$('seedRange').value;
    S.dp = +$('dpRange').value;
    S.noise = +$('noiseRange').value;
    S.loss = +$('lossRange').value;
    S.size = +$('sizeSelect').value;
    S.win = +$('winSelect').value;
    S.overlap = +$('overlapSelect').value;
    S.passes = +$('passesSelect').value;
    S.subpix = $('subpixSelect').value;
    S.thresh = +$('threshSelect').value;
    S.bg = $('bgSelect').value;
    S.arrow = +$('scaleRange').value;
    S.ov.vectors = $('ovVectors').checked;
    S.ov.truth = $('ovTruth').checked;
    S.ov.error = $('ovError').checked;
    S.ov.grid = $('ovGrid').checked;
    syncLabels();
  }

  /* ---------- pipeline --------------------------------------------------- */

  function shoot() {
    if (S.uploaded) {
      S.flow = null;
      S.img = { a: S.uploaded.a, b: S.uploaded.b, width: S.uploaded.w, height: S.uploaded.h };
      return;
    }
    S.flow = Flow.bind(S.field, S.size, S.size, S.disp);
    S.img = Synth.generate({
      width: S.size, height: S.size, flow: S.flow, maxDisp: S.disp,
      nPerWindow: S.seed, dp: S.dp, noise: S.noise, loss: S.loss / 100,
      seed: S.rngSeed
    });
  }

  /* A window that straddles a body wall only holds particles on one side, so
   * its correlation is meaningless. Real PIV masks those out too: reject a
   * window when a fifth of it falls inside the body. */
  function maskedWindow(win) {
    if (!S.flow || !S.flow.def.mask) return null;
    var m = S.flow.masked, n = 5, h = win / 2;
    return function (cx, cy) {
      if (m(cx, cy)) return true;
      var hit = 0;
      for (var j = 0; j < n; j++) {
        for (var i = 0; i < n; i++) {
          if (m(cx - h + (i + 0.5) * win / n, cy - h + (j + 0.5) * win / n)) hit++;
        }
      }
      return hit >= n * n * 0.2;
    };
  }

  function compute(animate) {
    var cfg = {
      imgA: S.img.a, imgB: S.img.b, width: S.img.width, height: S.img.height,
      win: S.win, overlap: S.overlap, passes: S.passes, subpix: S.subpix,
      subpixel: S.subpix, threshold: S.thresh, snrMin: 1.2,
      masked: maskedWindow(S.win)
    };
    S.cfg = cfg;
    S.res = PIV.run(cfg);
    S.der = PIV.derive(S.res);
    S.truth = S.flow ? PIV.truth(S.res, S.flow) : null;
    bgKey = '';
    if (S.picked >= S.res.nx * S.res.ny) S.picked = -1;
    updateMetrics();
    if (animate) startReveal(); else { reveal.n = S.res.nx * S.res.ny; draw(); }
    if (S.picked < 0) autoPick();
    else inspect(S.picked);
  }

  function run(animate) {
    if (S.busy) return;
    S.busy = true;
    var btn = $('runBtn');
    btn.disabled = true;
    btn.textContent = I18N.t('run.busy');
    veil(I18N.t('run.busy'));
    /* let the veil paint before the synchronous correlation pass */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          readControls();
          shoot();
          compute(animate !== false);
        } finally {
          S.busy = false;
          btn.disabled = false;
          btn.textContent = I18N.t('run.again');
          veil(null);
        }
      });
    });
  }

  function veil(text) {
    var v = $('veil');
    if (text) { v.firstElementChild ? (v.firstElementChild.textContent = text) : (v.textContent = text); v.hidden = false; }
    else v.hidden = true;
  }

  /* ---------- reveal animation ------------------------------------------ */
  function startReveal() {
    var n = S.res.nx * S.res.ny;
    reveal.target = n; reveal.n = 0; reveal.t0 = 0;
    cancelAnimationFrame(reveal.raf);
    var reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { reveal.n = n; draw(); $('progress').style.width = '0'; return; }
    var dur = 850;
    function frame(t) {
      if (!reveal.t0) reveal.t0 = t;
      var p = Math.min(1, (t - reveal.t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      reveal.n = Math.round(e * n);
      $('progress').style.width = (p < 1 ? (100 * p).toFixed(1) : 0) + '%';
      draw();
      if (p < 1) reveal.raf = requestAnimationFrame(frame);
    }
    reveal.raf = requestAnimationFrame(frame);
  }

  /* ---------- drawing ---------------------------------------------------- */

  function fitCanvas() {
    if (!S.img) return;
    var W = S.img.width, H = S.img.height;
    var cssW = $('sensor').clientWidth || 600;
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    var bw = Math.max(320, Math.round(cssW * dpr));
    if (stage.width !== bw || stage.height !== Math.round(bw * H / W)) {
      stage.width = bw;
      stage.height = Math.round(bw * H / W);
    }
  }

  function bgSpec() {
    var m = S.bg;
    if (m === 'speed') return { arr: S.der.mag, ramp: 'speed', sym: false, label: 'legend.speed' };
    if (m === 'vort') return { arr: S.der.vort, ramp: 'vorticity', sym: true, label: 'legend.vort' };
    if (m === 'div') return { arr: S.der.div, ramp: 'vorticity', sym: true, label: 'legend.div' };
    if (m === 'err' && S.truth) return { arr: S.truth.err, ramp: 'error', sym: false, label: 'legend.err' };
    return null;
  }

  function buildBackground() {
    var W = S.img.width, H = S.img.height;
    var spec = bgSpec();
    var key = [S.bg, S.theme, W, H, S.res ? S.res.ms : 0, blink.phase].join('|');
    if (key === bgKey) return;
    bgKey = key;
    if (bgCanvas.width !== W || bgCanvas.height !== H) {
      bgCanvas.width = W; bgCanvas.height = H;
    }
    var bctx = bgCanvas.getContext('2d');
    bctx.clearRect(0, 0, W, H);
    if (spec) {
      var range = Color.niceRange(spec.arr, S.res.status, spec.sym);
      S.range = range;
      var mask = (S.flow && S.flow.def.mask) ? S.flow.masked : null;
      bctx.putImageData(
        R.fieldImage(bctx, S.res, spec.arr, range, spec.ramp, S.theme, W, H, mask), 0, 0);
    } else if (S.bg === 'pair') {
      bctx.putImageData(R.pairImage(bctx, S.img.a, S.img.b, W, H), 0, 0);
    } else {
      var src = (S.bg === 'blink' && blink.phase) ? S.img.b : S.img.a;
      bctx.putImageData(R.particleImage(bctx, src, W, H), 0, 0);
    }
    updateRamp(spec);
  }

  var ARROW_RAMP_LO = 0.34;   /* the darkest end of the ramp vanishes on the image */

  function updateRamp(spec) {
    var bar = $('rampBar'), ramp, range, label, lo = 0;
    if (spec) {
      ramp = spec.ramp; range = S.range; label = I18N.t(spec.label);
      if (spec.sym && S.bg === 'vort') {
        label += '  ' + I18N.t('legend.cw') + ' → ' + I18N.t('legend.ccw');
      }
    } else if (S.ov.vectors && S.res) {
      /* arrows over the raw frames are coloured by speed — show that scale */
      ramp = 'speed'; range = speedRange(); label = I18N.t('legend.speed');
      lo = ARROW_RAMP_LO;
    } else { bar.hidden = true; return; }
    bar.hidden = false;
    bar.className = spec ? 'bar' : 'bar on-sensor';
    $('ramp').style.background = Color.gradient(ramp, spec ? S.theme : 'dark', 90, lo, 1);
    var dec = Math.abs(range[1]) < 0.1 ? 3 : (Math.abs(range[1]) < 2 ? 2 : 1);
    $('rampLo').textContent = fmt(range[0], dec);
    $('rampHi').textContent = fmt(range[1], dec);
    $('rampLabel').textContent = label;
  }

  function draw() {
    if (!S.img) return;
    fitCanvas();
    var W = S.img.width, H = S.img.height, k = stage.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, stage.width, stage.height);
    buildBackground();
    var onField = !!bgSpec();
    if (onField) {
      /* masked cells carry no data; let them read as empty panel, not as a hole */
      ctx.fillStyle = cssVar('--sunken');
      ctx.fillRect(0, 0, stage.width, stage.height);
    }
    ctx.imageSmoothingEnabled = onField;
    ctx.drawImage(bgCanvas, 0, 0, stage.width, stage.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    /* The particle frames stay dark whatever the page theme is, so marks drawn
     * on them take dark-theme colours; marks on a scalar field follow the page. */
    var markTheme = onField ? S.theme : 'dark';
    var inkOnImage = '#5BE9AC';
    var truthColor = onField ? cssVar('--signal') : '#FFA362';
    var rejectColor = onField ? cssVar('--bad') : '#FF7D66';
    var showTruth = S.ov.truth && S.truth;

    if (S.flow) {
      R.body(ctx, S.flow,
        onField ? cssVar('--sunken') : 'rgba(110,135,130,.30)',
        onField ? cssVar('--line-2') : 'rgba(190,225,215,.70)');
    }
    if (S.ov.grid && S.res) {
      R.grid(ctx, S.res, onField ? 'rgba(20,30,30,.22)' : 'rgba(150,200,190,.28)', 0.8 / k * 1.2);
    }
    if (!S.res) return;

    var s = arrowScale();
    if (showTruth) {
      /* a wide band under the measured arrow: where the two agree the band sits
       * symmetrically around it, where they differ it sticks out */
      R.truthVectors(ctx, S.res, S.truth, {
        scale: s, color: truthColor, lineWidth: 3.6 / k, alpha: .95
      });
    }
    if (S.ov.vectors) {
      R.vectors(ctx, S.res, {
        scale: s, limit: reveal.n, lineWidth: 1.15 / k,
        ramp: onField ? null : 'speed', range: speedRange(), theme: markTheme,
        rampLo: ARROW_RAMP_LO,
        color: onField ? cssVar('--ink') : inkOnImage,
        halo: showTruth ? null : (onField ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.6)'),
        showRejected: true, rejectedColor: rejectColor
      });
    }
    if (S.ov.error && S.truth) {
      R.errorVectors(ctx, S.res, S.truth, { scale: s * 10, color: truthColor, lineWidth: 1.3 / k });
    }

    /* the window being correlated right now, and the one under inspection */
    if (reveal.n < reveal.target && reveal.n > 0) {
      var kk = Math.min(reveal.n, reveal.target - 1);
      var i = kk % S.res.nx, j = (kk - i) / S.res.nx;
      R.windowMarker(ctx, S.res.xs[i], S.res.ys[j], S.res.win, inkOnImage, 1.6 / k);
    }
    if (S.picked >= 0) {
      var pi = S.picked % S.res.nx, pj = (S.picked - pi) / S.res.nx;
      R.windowMarker(ctx, S.res.xs[pi], S.res.ys[pj], S.res.win,
        onField ? cssVar('--ink') : '#FFFFFF', 1.8 / k);
    }
  }

  function speedRange() {
    if (!S.der) return [0, 1];
    if (!S.speedRange || S.speedKey !== S.res.ms) {
      S.speedRange = Color.niceRange(S.der.mag, S.res.status, false);
      S.speedKey = S.res.ms;
    }
    return S.speedRange;
  }

  /* Arrow length: 1.0 means the largest vector spans one window spacing. */
  function arrowScale() {
    var r = speedRange();
    var ref = Math.max(0.3, r[1]);
    return S.arrow * (S.res.step * 0.95) / ref;
  }

  /* ---------- inspector -------------------------------------------------- */

  /* Open the inspector on a window worth looking at: away from the border,
   * moving well, and with the strongest correlation among those. Picking the
   * single fastest vector tends to land on the oddest one in the field. */
  function autoPick() {
    if (!S.res) return;
    var res = S.res, n = res.nx * res.ny, k, speeds = [];
    for (k = 0; k < n; k++) {
      if (res.status[k] === 0) speeds.push(Math.hypot(res.u[k], res.v[k]));
    }
    if (!speeds.length) return;
    speeds.sort(function (a, b) { return a - b; });
    var floor = speeds[Math.floor(speeds.length * 0.6)];
    var best = -1, bc = -1, fallback = -1, fc = -1;
    for (k = 0; k < n; k++) {
      if (res.status[k] !== 0) continue;
      var i = k % res.nx, j = (k - i) / res.nx;
      if (res.corr[k] > fc) { fc = res.corr[k]; fallback = k; }
      if (i === 0 || j === 0 || i === res.nx - 1 || j === res.ny - 1) continue;
      if (Math.hypot(res.u[k], res.v[k]) < floor) continue;
      if (res.corr[k] > bc) { bc = res.corr[k]; best = k; }
    }
    if (best < 0) best = fallback;
    if (best >= 0) inspect(best);
  }

  function inspect(index) {
    if (!S.res || index < 0 || index >= S.res.nx * S.res.ny) return;
    S.picked = index;
    S.insp = PIV.inspect(S.cfg, S.res, index);
    $('inspPick').hidden = true;
    $('inspContent').hidden = false;
    drawInspector();
    draw();
  }

  function drawInspector() {
    var ins = S.insp;
    if (!ins) return;
    R.zoom($('winA'), ins.a, ins.win, true);
    R.zoom($('winB'), ins.b, ins.win, true);
    var half = Math.min(ins.limit, S.corrMode === '3d' ? 12 : 10);
    var ink = cssVar('--laser'), sig = cssVar('--signal');
    if (S.corrMode === '3d') R.corrSurface($('corr'), ins, half, S.theme, ink, sig);
    else R.corrMap($('corr'), ins, half, S.theme, '#FFFFFF');

    var k = S.picked;
    $('rPos').textContent = Math.round(ins.cx) + ', ' + Math.round(ins.cy) + ' px';
    $('rMeas').textContent = fmt(ins.u, 3) + ', ' + fmt(ins.v, 3) + ' px';
    if (S.truth) {
      $('rTruth').textContent = fmt(S.truth.tu[k], 3) + ', ' + fmt(S.truth.tv[k], 3) + ' px';
      var ex = ins.u - S.truth.tu[k], ey = ins.v - S.truth.tv[k];
      $('rErr').textContent = fmt(Math.hypot(ex, ey), 3) + ' px';
    } else {
      $('rTruth').textContent = '—';
      $('rErr').textContent = '—';
    }
    $('rSub').textContent = fmt(ins.peak.sx, 3) + ', ' + fmt(ins.peak.sy, 3) + ' px';
    $('rShift').textContent = ins.shiftX + ', ' + ins.shiftY + ' px';
    $('rPeak').textContent = fmt(ins.peak.peak, 3);
    $('rSnr').textContent = fmt(ins.peak.snr, 2);
    var st = S.res.status[k];
    var v = $('rStatus');
    v.setAttribute('data-st', st);
    v.textContent = I18N.t(st === 0 ? 'st.ok' : st === 1 ? 'st.outlier' : st === 2 ? 'st.masked' : 'st.weak');
  }

  function pickAt(clientX, clientY) {
    if (!S.res) return;
    var rect = stage.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width * S.img.width;
    var y = (clientY - rect.top) / rect.height * S.img.height;
    var i = Math.round((x - S.res.xs[0]) / S.res.step);
    var j = Math.round((y - S.res.ys[0]) / S.res.step);
    i = Math.max(0, Math.min(S.res.nx - 1, i));
    j = Math.max(0, Math.min(S.res.ny - 1, j));
    inspect(j * S.res.nx + i);
  }

  /* ---------- metrics & diagnostics -------------------------------------- */

  function updateMetrics() {
    var res = S.res, n = res.nx * res.ny;
    var valid = 0, masked = 0, rejected = 0, weak = 0, peakSum = 0, snrSum = 0, cnt = 0;
    for (var k = 0; k < n; k++) {
      var st = res.status[k];
      if (st === 2) { masked++; continue; }
      cnt++;
      peakSum += res.corr[k];
      snrSum += Math.min(20, res.snr[k]);
      if (st === 0) valid++; else if (st === 1) rejected++; else weak++;
    }
    var meanPeak = cnt ? peakSum / cnt : 0, meanSnr = cnt ? snrSum / cnt : 0;
    var validPct = cnt ? 100 * valid / cnt : 0;

    var hero = $('rmsVal'), frac = $('rmsFraction');
    var heroCap = document.querySelector('.hero .cap');
    if (S.truth) {
      heroCap.textContent = I18N.t('m.rms');
      hero.innerHTML = fmt(S.truth.rms, 3) + '<small> ' + I18N.t('m.rms.px') + '</small>';
      var inv = S.truth.rms > 0 ? Math.round(1 / S.truth.rms) : 0;
      frac.innerHTML = I18N.t('m.subpx') + ' — ' + I18N.t('m.subpx.sub') + ' <b>1/' + inv + '</b>';
      document.querySelector('.hero .sub').textContent = I18N.t('m.rms.sub');
    } else {
      heroCap.textContent = I18N.t('m.peak');
      hero.innerHTML = fmt(meanPeak, 3);
      frac.textContent = '';
      document.querySelector('.hero .sub').textContent = I18N.t('upload.hint');
    }

    $('stVectors').textContent = res.nx + ' × ' + res.ny + ' = ' + (n - masked);
    $('stValid').textContent = fmt(validPct, 1) + ' %';
    $('stPeak').textContent = fmt(meanPeak, 3);
    $('stBias').textContent = S.truth
      ? fmt(S.truth.biasX, 3) + ', ' + fmt(S.truth.biasY, 3) + ' px' : '—';
    $('stMax').textContent = S.truth ? fmt(S.truth.max, 2) + ' px' : '—';
    $('stPasses').textContent = res.passes.map(function (p) { return p.win; }).join(' → ') + ' px';
    $('stTime').textContent = Math.round(res.ms) + ' ms';

    syncKeys();

    /* --- health checks --- */
    var rows = [];
    var nI = S.uploaded ? null : S.seed * Math.pow(S.win / 32, 2);
    if (nI !== null) {
      rows.push(chk('diag.seed', nI >= 8 ? 'ok' : nI >= 4 ? 'warn' : 'bad',
        fmt(nI, 1) + (I18N.lang === 'ko' ? ' 개' : ''),
        nI >= 8 ? 'diag.seed.ok' : 'diag.seed.warn'));
    }
    var p98 = percentileSpeed(0.98);
    var q = p98 / (S.win / 4);
    rows.push(chk('diag.quarter', q <= 1 ? 'ok' : q <= 1.4 ? 'warn' : 'bad',
      fmt(p98, 1) + ' / ' + fmt(S.win / 4, 1) + ' px',
      q <= 1 ? 'diag.quarter.ok' : 'diag.quarter.warn'));
    if (!S.uploaded) {
      rows.push(chk('diag.dp', (S.dp >= 1.8 && S.dp <= 3.6) ? 'ok' : (S.dp >= 1.4 ? 'warn' : 'bad'),
        fmt(S.dp, 1) + ' px', (S.dp >= 1.8 && S.dp <= 3.6) ? 'diag.dp.ok' : 'diag.dp.warn'));
    }
    rows.push(chk('diag.snr', meanSnr >= 1.5 ? 'ok' : meanSnr >= 1.2 ? 'warn' : 'bad',
      fmt(meanSnr, 2), meanSnr >= 1.5 ? 'diag.snr.ok' : 'diag.snr.warn'));
    rows.push(chk('diag.valid', validPct >= 95 ? 'ok' : validPct >= 85 ? 'warn' : 'bad',
      fmt(validPct, 1) + ' %', validPct >= 95 ? 'diag.valid.ok' : 'diag.valid.warn'));
    $('diags').innerHTML = rows.join('');
  }

  /* the legend names only what is on screen, in the colour it was drawn in */
  function syncKeys() {
    var onField = !!(S.res && bgSpec());
    var rampColoured = S.ov.vectors && !onField;
    $('keyMeas').hidden = !S.ov.vectors || rampColoured;
    $('keyMeas').style.color = onField ? 'var(--ink)' : '#5BE9AC';
    $('keyTruth').hidden = !(S.ov.truth && S.truth);
    $('keyTruth').style.color = onField ? 'var(--signal)' : '#FFA362';
    $('keyRej').style.color = onField ? 'var(--bad)' : '#FF7D66';
  }

  function chk(labelKey, level, value, noteKey) {
    var mark = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✕';
    return '<div class="diag" data-level="' + level + '">' +
      '<span class="mark">' + mark + '</span>' +
      '<span class="what">' + I18N.t(labelKey) + '<em>' + I18N.t(noteKey) + '</em></span>' +
      '<span class="num">' + value + '</span></div>';
  }

  function percentileSpeed(p) {
    var v = [], k;
    if (S.truth) {
      for (k = 0; k < S.truth.tu.length; k++) {
        if (S.res.status[k] === 2) continue;
        v.push(Math.hypot(S.truth.tu[k], S.truth.tv[k]));
      }
    } else {
      for (k = 0; k < S.der.mag.length; k++) {
        if (S.res.status[k] === 2) continue;
        v.push(S.der.mag[k]);
      }
    }
    if (!v.length) return 0;
    v.sort(function (a, b) { return a - b; });
    return v[Math.min(v.length - 1, Math.floor(v.length * p))];
  }

  /* ---------- story steps ------------------------------------------------ */

  function setStep(n) {
    S.step = n;
    var btns = document.querySelectorAll('.step');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-current', String(+btns[i].getAttribute('data-step') === n));
    }
    if (n === 1) {
      $('bgSelect').value = 'a';
      $('ovVectors').checked = false; $('ovGrid').checked = false;
      $('ovTruth').checked = false; $('ovError').checked = false;
    } else if (n === 2) {
      $('bgSelect').value = 'blink';
      $('ovVectors').checked = false; $('ovGrid').checked = false;
    } else if (n === 3) {
      $('bgSelect').value = 'a';
      $('ovVectors').checked = false; $('ovGrid').checked = true;
    } else if (n === 4) {
      $('bgSelect').value = 'speed';
      $('ovVectors').checked = true; $('ovGrid').checked = false;
    }
    readControls();
    updateBlink();
    if (n === 3 && S.res) {
      var mid = Math.floor(S.res.ny / 2) * S.res.nx + Math.floor(S.res.nx / 2);
      inspect(S.picked >= 0 ? S.picked : mid);
      var el = document.querySelector('.inspector');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (n === 4 && S.res) startReveal();
    draw();
    $('stageHint').textContent = I18N.t(n === 2 ? 'stage.blink' : 'stage.hint');
  }

  /* ---------- blink ------------------------------------------------------ */
  function updateBlink() {
    var want = S.bg === 'blink';
    if (want === blink.on) return;
    blink.on = want;
    cancelAnimationFrame(blink.raf);
    if (!want) { blink.phase = 0; bgKey = ''; draw(); return; }
    var last = 0;
    function frame(t) {
      if (!last) last = t;
      if (t - last > 420) { last = t; blink.phase ^= 1; draw(); }
      if (blink.on) blink.raf = requestAnimationFrame(frame);
    }
    blink.raf = requestAnimationFrame(frame);
  }

  /* ---------- upload ----------------------------------------------------- */

  function loadFile(file, which) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var cap = 640;
      var sc = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(64, Math.round(img.naturalWidth * sc));
      var h = Math.max(64, Math.round(img.naturalHeight * sc));
      var c = R.offscreen(w, h), cc = c.getContext('2d');
      cc.drawImage(img, 0, 0, w, h);
      var d = cc.getImageData(0, 0, w, h);
      var rec = { g: Synth.fromImageData(d), w: w, h: h };
      if (which === 'a') S.pendingA = rec; else S.pendingB = rec;
      URL.revokeObjectURL(url);
      tryUploaded();
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('copy.fail'); };
    img.src = url;
  }

  function tryUploaded() {
    if (!S.pendingA || !S.pendingB) return;
    var A = S.pendingA, B = S.pendingB, note = '';
    var w = A.w, h = A.h, b = B.g;
    if (B.w !== w || B.h !== h) {
      var out = new Float32Array(w * h);
      for (var j = 0; j < h; j++) {
        for (var i = 0; i < w; i++) {
          out[j * w + i] = (i < B.w && j < B.h) ? B.g[j * B.w + i] : 0;
        }
      }
      b = out;
      note = 'upload.size';
    }
    S.uploaded = { a: A.g, b: b, w: w, h: h };
    S.picked = -1;
    if (note) toast(note);
    run(true);
  }

  function toast(key, raw) {
    var t = $('toast');
    t.textContent = raw || I18N.t(key);
    if (toast.timer) clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.textContent = ''; }, 4000);
  }

  function csv() {
    var res = S.res, lines = ['x_px,y_px,dx_px,dy_px,peak_R,snr,status'];
    for (var j = 0; j < res.ny; j++) {
      for (var i = 0; i < res.nx; i++) {
        var k = j * res.nx + i;
        lines.push([
          res.xs[i].toFixed(1), res.ys[j].toFixed(1),
          res.u[k].toFixed(4), res.v[k].toFixed(4),
          res.corr[k].toFixed(4), Math.min(99, res.snr[k]).toFixed(2),
          res.status[k]
        ].join(','));
      }
    }
    return lines.join('\n');
  }

  /* ---------- wiring ----------------------------------------------------- */

  function applyLang(next) {
    I18N.apply(next);
    buildFlowSelect();
    syncLabels();
    $('langBtn').textContent = I18N.t('app.langLabel');
    $('runBtn').textContent = I18N.t(S.res ? 'run.again' : 'run');
    $('stageHint').textContent = I18N.t(S.step === 2 ? 'stage.blink' : 'stage.hint');
    if (S.res) { updateMetrics(); drawInspector(); bgKey = ''; draw(); }
    store('lang', I18N.lang);
  }

  function bind() {
    var reshootIds = ['flowKind', 'dispRange', 'seedRange', 'dpRange', 'noiseRange', 'lossRange', 'sizeSelect'];
    var recomputeIds = ['winSelect', 'overlapSelect', 'passesSelect', 'subpixSelect', 'threshSelect'];
    var redrawIds = ['bgSelect', 'scaleRange', 'ovVectors', 'ovTruth', 'ovError', 'ovGrid'];

    reshootIds.forEach(function (id) {
      $(id).addEventListener('input', function () {
        readControls();
        if (S.uploaded && id !== 'flowKind') return;
        S.uploaded = null; S.pendingA = S.pendingB = null;
        run(false);
      });
    });
    recomputeIds.forEach(function (id) {
      $(id).addEventListener('input', function () { readControls(); run(false); });
    });
    redrawIds.forEach(function (id) {
      $(id).addEventListener('input', function () {
        readControls();
        updateBlink();
        bgKey = '';
        syncKeys();
        draw();
      });
    });

    $('runBtn').addEventListener('click', function () { run(true); });
    $('reshootBtn').addEventListener('click', function () {
      S.rngSeed = (Math.random() * 1e9) | 0;
      S.uploaded = null; S.pendingA = S.pendingB = null;
      $('fileA').value = ''; $('fileB').value = '';
      run(true);
    });

    var steps = document.querySelectorAll('.step');
    for (var i = 0; i < steps.length; i++) {
      steps[i].addEventListener('click', function () {
        setStep(+this.getAttribute('data-step'));
      });
    }

    $('sensor').addEventListener('click', function (e) { pickAt(e.clientX, e.clientY); });
    $('sensor').setAttribute('tabindex', '0');
    $('sensor').addEventListener('keydown', function (e) {
      if (!S.res) return;
      var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      var k = S.picked < 0 ? 0 : S.picked;
      var i2 = k % S.res.nx, j2 = (k - i2) / S.res.nx;
      i2 = Math.max(0, Math.min(S.res.nx - 1, i2 + d[0]));
      j2 = Math.max(0, Math.min(S.res.ny - 1, j2 + d[1]));
      inspect(j2 * S.res.nx + i2);
    });

    var modes = document.querySelectorAll('input[name="corrMode"]');
    for (i = 0; i < modes.length; i++) {
      modes[i].addEventListener('change', function () {
        S.corrMode = this.value;
        drawInspector();
      });
    }

    $('langBtn').addEventListener('click', function () {
      applyLang(I18N.lang === 'ko' ? 'en' : 'ko');
    });
    $('themeBtn').addEventListener('click', function () {
      S.themeMode = S.themeMode === 'auto'
        ? (S.theme === 'dark' ? 'light' : 'dark')
        : (S.themeMode === 'dark' ? 'light' : 'dark');
      resolveTheme();
      store('theme', S.themeMode);
      bgKey = '';
      draw(); drawInspector();
    });

    $('fileA').addEventListener('change', function () {
      if (this.files && this.files[0]) loadFile(this.files[0], 'a');
    });
    $('fileB').addEventListener('change', function () {
      if (this.files && this.files[0]) loadFile(this.files[0], 'b');
    });
    $('clearUpload').addEventListener('click', function () {
      S.uploaded = null; S.pendingA = S.pendingB = null;
      $('fileA').value = ''; $('fileB').value = '';
      $('dump').hidden = true;
      run(true);
    });
    $('copyCsv').addEventListener('click', function () {
      if (!S.res) return;
      var text = csv();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('copy.done'); },
          function () { showDump(text); });
      } else showDump(text);
    });

    var mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function () {
        if (S.themeMode === 'auto') { resolveTheme(); bgKey = ''; draw(); drawInspector(); }
      });
    }

    var rt;
    root.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { bgKey = ''; draw(); }, 120);
    });
  }

  function showDump(text) {
    var d = $('dump');
    d.value = text;
    d.hidden = false;
    d.select();
    toast('copy.fail');
  }

  /* ---------- boot ------------------------------------------------------- */

  function init() {
    var savedTheme = store('theme');
    if (savedTheme === 'light' || savedTheme === 'dark') S.themeMode = savedTheme;
    resolveTheme();
    var savedLang = store('lang');
    applyLang(savedLang === 'en' ? 'en' : 'ko');
    bind();
    readControls();
    shoot();
    compute(true);
    veil(null);
    setStep(0);
    $('runBtn').textContent = I18N.t('run.again');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
