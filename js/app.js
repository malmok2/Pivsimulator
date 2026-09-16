/* PIV Simulator — 상태와 배선.
 * 합성 → 상관 → 그리기를 잇고, 상관 현미경·측정 요약·경고를 한 상태에서 맞춘다.
 * 디자인 지침: 파라미터는 슬라이더+숫자칸+유도값 힌트 세 짝, 접힌 그룹은 자기
 * 상태를 말하고, 경고는 값 옆에서 즉시 뜨되 한 번에 하나만 띄운다.
 */
(function (root) {
  'use strict';

  var Flow = root.PIVSim.Flow, Synth = root.PIVSim.Synth, PIV = root.PIVSim.PIV;
  var R = root.PIVSim.Render, Color = root.PIVSim.Color, I18N = root.PIVSim.I18N;
  var t = function (k) { return I18N.t(k); };
  var tf = function () { return I18N.tf.apply(I18N, arguments); };
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    size: 384, field: 'cylinder', disp: 6,
    seed: 14, dp: 2.6, noise: 1.5, loss: 5,
    win: 32, overlap: 0.5, passes: 3, subpix: 'gauss', thresh: 2,
    bg: 'a', scale: 1, step: 0,
    ov: { vectors: true, truth: false, error: false, grid: false },
    corrMode: '3d', rngSeed: 7,
    flow: null, img: null, res: null, truth: null, der: null, cfg: null,
    uploaded: null, pendingA: null, pendingB: null,
    picked: -1, insp: null, busy: false, range: [0, 1]
  };

  /* 숫자칸과 슬라이더가 한 벌로 움직이는 파라미터 */
  var NUMS = [
    { key: 'disp', range: 'dispRange', num: 'dispNum', dec: 1, act: 'shoot' },
    { key: 'seed', range: 'seedRange', num: 'seedNum', dec: 0, act: 'shoot' },
    { key: 'dp', range: 'dpRange', num: 'dpNum', dec: 1, act: 'shoot' },
    { key: 'loss', range: 'lossRange', num: 'lossNum', dec: 0, act: 'shoot' },
    { key: 'noise', range: 'noiseRange', num: 'noiseNum', dec: 1, act: 'shoot' },
    { key: 'scale', range: 'scaleRange', num: 'scaleNum', dec: 1, act: 'draw' }
  ];
  var PICKS = [
    { key: 'field', id: 'flowKind', act: 'shoot', str: true },
    { key: 'size', id: 'sizeSelect', act: 'shoot' },
    { key: 'win', id: 'winSelect', act: 'run' },
    { key: 'overlap', id: 'overlapSelect', act: 'run' },
    { key: 'passes', id: 'passesSelect', act: 'run' },
    { key: 'subpix', id: 'subpixSelect', act: 'run', str: true },
    { key: 'thresh', id: 'threshSelect', act: 'run' },
    { key: 'bg', id: 'bgSelect', act: 'draw', str: true }
  ];

  var stage = $('stage'), ctx = stage.getContext('2d');
  var bgCanvas = R.offscreen(8, 8), bgKey = '';
  var reveal = { n: 0, target: 0, raf: 0, t0: 0 };
  var blink = { raf: 0, on: false, phase: 0 };
  var pending = 0;

  function fmt(v, n) { return Number(v).toFixed(n === undefined ? 2 : n); }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------- 격자 산수 (계산 전에도 힌트를 띄우려면 필요하다) ---------- */

  function gridCount() {
    var W = S.uploaded ? S.uploaded.w : S.size;
    var H = S.uploaded ? S.uploaded.h : S.size;
    var step = Math.max(1, Math.round(S.win * (1 - S.overlap)));
    return {
      step: step,
      nx: Math.max(1, Math.floor((W - S.win) / step) + 1),
      ny: Math.max(1, Math.floor((H - S.win) / step) + 1),
      W: W, H: H
    };
  }
  function seedInWindow() { return S.seed * Math.pow(S.win / 32, 2); }
  function nextWin() { return S.win < 64 ? S.win * 2 : 64; }

  /* ---------- 컨트롤 ---------- */

  function buildFlowSelect() {
    var sel = $('flowKind'), groups = {}, order = [];
    sel.innerHTML = '';
    Flow.fields.forEach(function (f) {
      if (!groups[f.group]) { groups[f.group] = []; order.push(f.group); }
      groups[f.group].push(f);
    });
    order.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = t('grp.' + g);
      groups[g].forEach(function (f) {
        var o = document.createElement('option');
        o.value = f.id;
        o.textContent = t('f.' + f.id);
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = S.field;
  }

  function pushControls() {
    NUMS.forEach(function (p) {
      $(p.range).value = S[p.key];
      $(p.num).value = fmt(S[p.key], p.dec);
    });
    PICKS.forEach(function (p) { $(p.id).value = S[p.key]; });
    $('ovVectors').checked = S.ov.vectors;
    $('ovTruth').checked = S.ov.truth;
    $('ovError').checked = S.ov.error;
    $('ovGrid').checked = S.ov.grid;
  }

  function setHint(id, text, level) {
    var el = $(id);
    el.textContent = text;
    el.className = 'hint' + (level ? ' ' + level : '');
  }

  /* 유도값 힌트 — 이 값을 바꾸면 무엇이 따라 변하는지 즉시 보여 준다 */
  function updateHints() {
    var g = gridCount(), quarter = S.win / 4;

    setHint('flowHint', t('fh.' + S.field));

    if (S.disp <= quarter) {
      setHint('dispHint', tf('h.disp', S.win, fmt(quarter, 1), fmt(quarter - S.disp, 1)));
    } else {
      setHint('dispHint', tf('h.disp.over', S.win, fmt(quarter, 1), fmt(S.disp - quarter, 1)),
        S.disp > quarter * 1.4 ? 'bad' : 'warn');
    }

    var nI = seedInWindow();
    setHint('seedHint', tf('h.seed', S.win, fmt(nI, 1)), nI < 4 ? 'bad' : (nI < 8 ? 'warn' : ''));
    setHint('dpHint', S.dp >= 1.5 ? tf('h.dp', fmt(S.dp, 1)) : tf('h.dp.small', fmt(S.dp, 1)),
      S.dp < 1.5 ? 'warn' : '');
    setHint('noiseHint', tf('h.noise', fmt(S.noise * 2.55, 1)));
    setHint('lossHint', tf('h.loss', fmt(S.loss, 0), fmt(1 - S.loss / 100, 2)));
    setHint('sizeHint', tf('h.size', S.size, g.nx, g.ny));
    setHint('winHint', tf('h.win', g.step, fmt(quarter, 1)));
    setHint('overlapHint', tf('h.overlap', g.step, g.nx, g.ny));
    setHint('passesHint', tf('h.passes',
      PIV.schedule(g.W, g.H, S.win, S.passes).join(' → ')));
    setHint('subpixHint', t('h.subpix.' + S.subpix));
    setHint('threshHint', S.thresh > 100 ? t('h.thresh.off') : tf('h.thresh', fmt(S.thresh, 1)),
      S.thresh > 100 ? 'warn' : '');
    setHint('scaleHint', tf('h.scale', fmt(S.scale, 1)));
  }

  /* 접힌 그룹이 말하는 자기 상태 */
  function updateStates() {
    $('gsFlow').textContent = tf('gs.flow', t('f.' + S.field), fmt(S.disp, 1));
    $('gsRec').textContent = tf('gs.rec', S.seed, fmt(S.dp, 1), S.loss);
    $('gsProc').textContent = tf('gs.proc', S.win, Math.round(S.overlap * 100), S.passes);
    $('gsView').textContent = tf('gs.view', t('bg.' + S.bg));
    $('gsUpload').textContent = S.uploaded
      ? tf('gs.upload.user', S.uploaded.w, S.uploaded.h)
      : t('gs.upload.synth');
  }

  /* ---------- 경고 사슬 — 심각한 것 하나만 ---------- */

  function updateWarn() {
    var g = gridCount(), quarter = S.win / 4, cand = [];
    var p98 = S.truth ? percentileSpeed(0.98) : (S.res ? percentileSpeed(0.98) : S.disp);

    if (p98 > quarter) {
      cand.push({
        level: p98 > quarter * 1.4 ? 'bad' : 'caution',
        t: t('w.quarter.t'),
        b: tf('w.quarter.b', fmt(p98, 1), S.win, fmt(quarter, 1)),
        f: tf('w.quarter.f', fmt(quarter, 1), nextWin())
      });
    }
    var nI = seedInWindow();
    if (!S.uploaded && nI < 8) {
      cand.push({
        level: nI < 4 ? 'bad' : 'caution',
        t: t('w.seed.t'),
        b: tf('w.seed.b', S.win, fmt(nI, 1)),
        f: tf('w.seed.f', nextWin())
      });
    }
    if (S.res) {
      var m = summary();
      if (m.validPct < 95) {
        cand.push({
          level: m.validPct < 85 ? 'bad' : 'caution',
          t: t('w.valid.t'),
          b: tf('w.valid.b', fmt(m.validPct, 1)),
          f: tf('w.valid.f', S.loss, nextWin())
        });
      }
      if (m.meanSnr < 1.5) {
        cand.push({
          level: m.meanSnr < 1.2 ? 'bad' : 'caution',
          t: t('w.snr.t'),
          b: tf('w.snr.b', fmt(m.meanSnr, 2)),
          f: t('w.snr.f')
        });
      }
    }
    if (!S.uploaded && (S.dp < 1.5 || S.dp > 4)) {
      cand.push({
        level: 'caution', t: t('w.dp.t'),
        b: tf('w.dp.b', fmt(S.dp, 1)), f: t('w.dp.f')
      });
    }

    var box = $('pWarn');
    if (!cand.length) { box.hidden = true; return; }
    var pick = cand.filter(function (c) { return c.level === 'bad'; })[0] || cand[0];
    box.hidden = false;
    box.setAttribute('data-level', pick.level);
    $('warnTitle').textContent = pick.t;
    $('warnBody').textContent = pick.b;
    $('warnFix').textContent = pick.f;
  }

  /* ---------- 파이프라인 ---------- */

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
      return hit >= n * n * 0.2;    /* 창이 물체에 1/5 이상 걸치면 못 쓴다 */
    };
  }

  function shoot() {
    if (S.uploaded) {
      S.flow = null;
      S.img = { a: S.uploaded.a, b: S.uploaded.b, width: S.uploaded.w, height: S.uploaded.h };
      return;
    }
    S.flow = Flow.bind(S.field, S.size, S.size, S.disp);
    S.img = Synth.generate({
      width: S.size, height: S.size, flow: S.flow, maxDisp: S.disp,
      nPerWindow: S.seed, dp: S.dp, noise: S.noise, loss: S.loss / 100, seed: S.rngSeed
    });
  }

  function compute(animate) {
    S.cfg = {
      imgA: S.img.a, imgB: S.img.b, width: S.img.width, height: S.img.height,
      win: S.win, overlap: S.overlap, passes: S.passes,
      subpixel: S.subpix, threshold: S.thresh, snrMin: 1.2,
      masked: maskedWindow(S.win)
    };
    S.res = PIV.run(S.cfg);
    S.der = PIV.derive(S.res);
    S.truth = S.flow ? PIV.truth(S.res, S.flow) : null;
    S.speedRange = null;
    bgKey = '';
    if (S.picked >= S.res.nx * S.res.ny) S.picked = -1;
    updateStats();
    updateWarn();
    if (animate) startReveal(); else { reveal.n = S.res.nx * S.res.ny; draw(); }
    if (S.picked < 0) autoPick(); else inspect(S.picked);
  }

  function run(animate) {
    if (S.busy) return;
    S.busy = true;
    var btn = $('runBtn');
    btn.disabled = true;
    btn.textContent = t('run.busy');
    veil(t('run.busy'));
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          shoot();
          compute(animate !== false);
        } finally {
          S.busy = false;
          btn.disabled = false;
          btn.textContent = t('run.again');
          veil(null);
        }
      });
    });
  }

  /* 슬라이더를 끄는 동안 계산이 따라오지 않게 잠깐 모은다.
   * 힌트와 상태는 즉시 갱신하므로 반응은 느려지지 않는다. */
  function schedule(act) {
    clearTimeout(pending);
    pending = setTimeout(function () {
      if (act === 'shoot') run(false);
      else if (act === 'run') { compute(false); }
      else { bgKey = ''; draw(); }
    }, act === 'draw' ? 0 : 130);
  }

  function veil(text) {
    var v = $('veil');
    if (text) {
      if (v.firstElementChild) v.firstElementChild.textContent = text;
      v.hidden = false;
    } else v.hidden = true;
  }

  function startReveal() {
    var n = S.res.nx * S.res.ny;
    reveal.target = n; reveal.n = 0; reveal.t0 = 0;
    cancelAnimationFrame(reveal.raf);
    var reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { reveal.n = n; draw(); $('progress').style.width = '0'; return; }
    function frame(ts) {
      if (!reveal.t0) reveal.t0 = ts;
      var p = Math.min(1, (ts - reveal.t0) / 850);
      reveal.n = Math.round((1 - Math.pow(1 - p, 3)) * n);
      $('progress').style.width = (p < 1 ? (100 * p).toFixed(1) : 0) + '%';
      draw();
      if (p < 1) reveal.raf = requestAnimationFrame(frame);
    }
    reveal.raf = requestAnimationFrame(frame);
  }

  /* ---------- 그리기 ---------- */

  function fitCanvas() {
    if (!S.img) return 1;
    var wrap = $('stageWrap');
    var availW = Math.max(120, wrap.clientWidth - 28);
    var availH = Math.max(120, wrap.clientHeight - 28);
    var ar = S.img.width / S.img.height;
    var w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    stage.style.width = Math.round(w) + 'px';
    stage.style.height = Math.round(h) + 'px';
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (stage.width !== bw || stage.height !== bh) { stage.width = bw; stage.height = bh; }
    return w;
  }

  function bgSpec() {
    var m = S.bg;
    if (!S.der) return null;
    if (m === 'speed') return { arr: S.der.mag, ramp: 'field', sym: false };
    if (m === 'vort') return { arr: S.der.vort, ramp: 'diverging', sym: true };
    if (m === 'div') return { arr: S.der.div, ramp: 'diverging', sym: true };
    if (m === 'err' && S.truth) return { arr: S.truth.err, ramp: 'field', sym: false };
    return null;
  }

  function buildBackground() {
    var W = S.img.width, H = S.img.height;
    var spec = bgSpec();
    var key = [S.bg, W, H, S.res ? S.res.ms : 0, blink.phase].join('|');
    if (key === bgKey) return;
    bgKey = key;
    if (bgCanvas.width !== W || bgCanvas.height !== H) { bgCanvas.width = W; bgCanvas.height = H; }
    var bctx = bgCanvas.getContext('2d');
    bctx.clearRect(0, 0, W, H);
    if (spec) {
      S.range = Color.niceRange(spec.arr, S.res.status, spec.sym);
      S.floored = 0;
      if (spec.sym) {
        /* 와도·발산은 벡터장을 미분한 값이라 잡음이 그대로 증폭된다. 범위를
         * 자동으로만 잡으면 참값이 0 인 장(퍼텐셜 유동)이 요란하게 보인다.
         * 측정 잡음이 채울 수 있는 만큼을 하한으로 둔다. */
        var floorV = noiseFloor();
        if (S.range[1] < floorV) { S.range = [-floorV, floorV]; S.floored = floorV; }
      }
      var mask = (S.flow && S.flow.def.mask) ? S.flow.masked : null;
      bctx.putImageData(
        R.fieldImage(bctx, S.res, spec.arr, S.range, spec.ramp, W, H, mask), 0, 0);
    } else if (S.bg === 'pair') {
      bctx.putImageData(R.pairImage(bctx, S.img.a, S.img.b, W, H), 0, 0);
    } else {
      var src = (S.bg === 'blink' && blink.phase) ? S.img.b : S.img.a;
      bctx.putImageData(R.particleImage(bctx, src, W, H), 0, 0);
    }
    updateLegend(spec);
  }

  /* 벡터장을 중앙차분하면 변위 오차 σ 가 √2·σ/간격 만큼 기울기 잡음이 된다.
   * 그 여덟 배를 색 범위의 하한으로 쓴다 — 잡음만 있는 장은 옅게 남는다. */
  function noiseFloor() {
    var sigma = S.truth ? Math.max(0.05, S.truth.rms) : 0.1;
    var f = 8 * sigma * Math.SQRT2 / S.res.step;
    var dec = Math.pow(10, Math.floor(Math.log(f) / Math.LN10));
    var m = f / dec;
    return (m <= 1.2 ? 1.2 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 5 ? 5 : 10) * dec;
  }

  function draw() {
    if (!S.img) return;
    var cssW = fitCanvas();
    var W = S.img.width, k = stage.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar('--bg') || '#fff';
    ctx.fillRect(0, 0, stage.width, stage.height);
    buildBackground();
    var spec = bgSpec(), onField = !!spec;
    ctx.imageSmoothingEnabled = onField;
    ctx.drawImage(bgCanvas, 0, 0, stage.width, stage.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);

    /* 바탕이 어두우냐 밝으냐로 마크 색을 고른다. viridis 는 대부분 어두우니
     * 흰 화살표에 잉크 테를, 발산형과 반전한 입자영상은 밝으니 navy 화살표에
     * 흰 테를 두른다. 강조색은 어느 쪽이든 하나다. */
    var darkField = onField && spec.ramp === 'field';
    var arrow = darkField ? '#ffffff' : cssVar('--c1');
    var halo = darkField ? 'rgba(21,24,28,.55)' : 'rgba(255,255,255,.8)';
    var truthColor = cssVar('--c2');
    var reject = darkField ? '#ffd0c6' : cssVar('--bad');

    if (S.flow) {
      R.body(ctx, S.flow, onField ? cssVar('--glass2') : 'rgba(116,127,142,.16)',
        darkField ? 'rgba(255,255,255,.55)' : 'rgba(88,99,114,.45)');
    }
    if (S.ov.grid && S.res) {
      R.grid(ctx, S.res, darkField ? 'rgba(255,255,255,.35)' : 'rgba(88,99,114,.26)', 0.9 / k);
    }
    if (!S.res) return;

    var s = arrowScale();
    var showTruth = S.ov.truth && S.truth;
    if (showTruth) {
      R.truthVectors(ctx, S.res, S.truth, { scale: s, color: truthColor, lineWidth: 3.6 / k, alpha: .95 });
    }
    if (S.ov.vectors) {
      R.vectors(ctx, S.res, {
        scale: s, limit: reveal.n, lineWidth: 1.2 / k,
        color: arrow, halo: showTruth ? null : halo,
        showRejected: true, rejectedColor: reject
      });
    }
    if (S.ov.error && S.truth) {
      R.errorVectors(ctx, S.res, S.truth, { scale: s * 10, color: truthColor, lineWidth: 1.3 / k });
    }

    if (reveal.n < reveal.target && reveal.n > 0) {
      var kk = Math.min(reveal.n, reveal.target - 1);
      var i = kk % S.res.nx, j = (kk - i) / S.res.nx;
      R.windowMarker(ctx, S.res.xs[i], S.res.ys[j], S.res.win, cssVar('--accent'), 1.6 / k);
    }
    if (S.picked >= 0) {
      var pi = S.picked % S.res.nx, pj = (S.picked - pi) / S.res.nx;
      R.windowMarker(ctx, S.res.xs[pi], S.res.ys[pj], S.res.win,
        cssVar('--accent'), 1.8 / k, 'rgba(255,255,255,.8)');
    }
    updateScaleBar(cssW);
  }

  function speedRange() {
    if (!S.der) return [0, 1];
    if (!S.speedRange) S.speedRange = Color.niceRange(S.der.mag, S.res.status, false);
    return S.speedRange;
  }

  /* 화살표 길이 1.0 = 가장 긴 벡터가 격자 간격만큼 */
  function arrowScale() {
    return S.scale * (S.res.step * 0.95) / Math.max(0.3, speedRange()[1]);
  }

  /* ---------- 범례 ---------- */

  function updateLegend(spec) {
    var bar = $('rampBar');
    if (spec) {
      bar.hidden = false;
      $('ramp').style.background = Color.gradient(spec.ramp, 90);
      var dec = Math.abs(S.range[1]) < 0.1 ? 3 : (Math.abs(S.range[1]) < 2 ? 2 : 1);
      $('rampLo').textContent = fmt(S.range[0], dec);
      $('rampHi').textContent = fmt(S.range[1], dec);
    } else bar.hidden = true;
    $('legendCap').textContent = t('lc.' + S.bg) +
      (S.floored ? ' ' + tf('lc.floored', fmt(S.floored, 3)) : '');
    /* 열쇠는 화면에 실제로 그려진 색으로 — viridis 위에서는 흰 화살표다 */
    var darkField = !!(spec && spec.ramp === 'field');
    key('keyMeas', darkField ? '#ffffff' : 'var(--c1)', darkField);
    key('keyRej', darkField ? '#ffd0c6' : 'var(--bad)', darkField);
    key('keyTruth', 'var(--c2)', false);
    $('keyMeas').hidden = !S.ov.vectors;
    $('keyTruth').hidden = !(S.ov.truth && S.truth);
    $('keyRej').hidden = !S.ov.vectors;
    $('keyScale').hidden = !S.ov.vectors || !S.res;
  }

  function key(id, color, outlined) {
    var el = $(id);
    el.style.color = color;
    el.firstElementChild.style.boxShadow = outlined ? '0 0 0 1px rgba(21,24,28,.55)' : 'none';
  }

  /* 화살표 길이의 기준자 — 보기 좋은 수를 골라 그 길이만큼 선을 긋는다 */
  function updateScaleBar(cssW) {
    if (!S.res || !S.ov.vectors) return;
    var perDisp = arrowScale() * (cssW / S.img.width);   /* 화면 px / 변위 px */
    var nice = [0.5, 1, 2, 5, 10, 20], pick = nice[0];
    for (var i = 0; i < nice.length; i++) {
      pick = nice[i];
      if (nice[i] * perDisp >= 22) break;
    }
    $('scaleTick').style.width = Math.max(10, Math.min(90, pick * perDisp)).toFixed(0) + 'px';
    $('scaleText').textContent = tf('legend.scale', pick);
  }

  /* ---------- 상관 현미경 ---------- */

  function autoPick() {
    if (!S.res) return;
    var res = S.res, n = res.nx * res.ny, k, speeds = [];
    for (k = 0; k < n; k++) if (res.status[k] === 0) speeds.push(Math.hypot(res.u[k], res.v[k]));
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
    R.zoom($('winA'), ins.a, ins.win);
    R.zoom($('winB'), ins.b, ins.win);
    var half = Math.min(ins.limit, S.corrMode === '3d' ? 12 : 10);
    if (S.corrMode === '3d') R.corrSurface($('corr'), ins, half, cssVar('--text'));
    else R.corrMap($('corr'), ins, half);

    var k = S.picked;
    $('rPos').textContent = Math.round(ins.cx) + ', ' + Math.round(ins.cy) + ' px';
    $('rMeas').textContent = fmt(ins.u, 3) + ', ' + fmt(ins.v, 3) + ' px';
    if (S.truth) {
      $('rTruth').textContent = fmt(S.truth.tu[k], 3) + ', ' + fmt(S.truth.tv[k], 3) + ' px';
      $('rErr').textContent = fmt(Math.hypot(ins.u - S.truth.tu[k], ins.v - S.truth.tv[k]), 3) + ' px';
    } else {
      $('rTruth').textContent = '—';
      $('rErr').textContent = '—';
    }
    $('rSub').textContent = fmt(ins.peak.sx, 3) + ', ' + fmt(ins.peak.sy, 3) + ' px';
    $('rShift').textContent = ins.shiftX + ', ' + ins.shiftY + ' px';
    $('rPeak').textContent = fmt(ins.peak.peak, 3);
    $('rSnr').textContent = fmt(ins.peak.snr, 2);
    var st = S.res.status[k], v = $('rStatus');
    v.setAttribute('data-st', st);
    v.textContent = t(st === 0 ? 'st.ok' : st === 1 ? 'st.outlier' : st === 2 ? 'st.masked' : 'st.weak');
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

  /* ---------- 측정 요약 ---------- */

  function summary() {
    var res = S.res, n = res.nx * res.ny;
    var valid = 0, masked = 0, peakSum = 0, snrSum = 0, cnt = 0;
    for (var k = 0; k < n; k++) {
      if (res.status[k] === 2) { masked++; continue; }
      cnt++;
      peakSum += res.corr[k];
      snrSum += Math.min(20, res.snr[k]);
      if (res.status[k] === 0) valid++;
    }
    return {
      n: n, masked: masked, cnt: cnt,
      meanPeak: cnt ? peakSum / cnt : 0,
      meanSnr: cnt ? snrSum / cnt : 0,
      validPct: cnt ? 100 * valid / cnt : 0
    };
  }

  function percentileSpeed(p) {
    var v = [], k;
    if (S.truth) {
      for (k = 0; k < S.truth.tu.length; k++) {
        if (S.res.status[k] === 2) continue;
        v.push(Math.hypot(S.truth.tu[k], S.truth.tv[k]));
      }
    } else if (S.der) {
      for (k = 0; k < S.der.mag.length; k++) {
        if (S.res.status[k] === 2) continue;
        v.push(S.der.mag[k]);
      }
    }
    if (!v.length) return S.disp;
    v.sort(function (a, b) { return a - b; });
    return v[Math.min(v.length - 1, Math.floor(v.length * p))];
  }

  function updateStats() {
    var res = S.res, m = summary();
    if (S.truth) {
      $('heroCap').textContent = t('m.rms');
      $('heroVal').textContent = fmt(S.truth.rms, 3) + ' px';
      $('stSubpx').textContent = S.truth.rms > 0
        ? tf('m.subpxv', Math.round(1 / S.truth.rms)) : '—';
    } else {
      $('heroCap').textContent = t('m.peakcap');
      $('heroVal').textContent = fmt(m.meanPeak, 3);
      $('stSubpx').textContent = '—';
    }
    $('stVectors').textContent = res.nx + '×' + res.ny + ' = ' + (m.n - m.masked);
    $('stValid').textContent = fmt(m.validPct, 1) + ' %';
    $('stPeak').textContent = fmt(m.meanPeak, 3);
    $('stBias').textContent = S.truth
      ? fmt(S.truth.biasX, 3) + ', ' + fmt(S.truth.biasY, 3) + ' px' : '—';
    $('stPasses').textContent = res.passes.map(function (p) { return p.win; }).join(' → ') + ' px';
    $('stTime').textContent = Math.round(res.ms) + ' ms';
  }

  /* ---------- 단계 ---------- */

  function setStep(n) {
    S.step = n;
    var btns = $('stepSeg').children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = (+btns[i].getAttribute('data-step') === n) ? 'on' : '';
    }
    $('headHint').textContent = n ? t('step.' + n + '.d') : '';
    if (n === 1) { S.bg = 'a'; S.ov.vectors = false; S.ov.grid = false; S.ov.truth = false; }
    else if (n === 2) { S.bg = 'blink'; S.ov.vectors = false; S.ov.grid = false; }
    else if (n === 3) { S.bg = 'a'; S.ov.vectors = false; S.ov.grid = true; }
    else if (n === 4) { S.bg = 'speed'; S.ov.vectors = true; S.ov.grid = false; }
    pushControls();
    updateStates();
    updateBlink();
    bgKey = '';
    if (n === 3 && S.res && S.picked < 0) autoPick();
    if (n === 4 && S.res) startReveal(); else draw();
  }

  function updateBlink() {
    var want = S.bg === 'blink';
    if (want === blink.on) return;
    blink.on = want;
    cancelAnimationFrame(blink.raf);
    if (!want) { blink.phase = 0; bgKey = ''; draw(); return; }
    var last = 0;
    function frame(ts) {
      if (!last) last = ts;
      if (ts - last > 420) { last = ts; blink.phase ^= 1; bgKey = ''; draw(); }
      if (blink.on) blink.raf = requestAnimationFrame(frame);
    }
    blink.raf = requestAnimationFrame(frame);
  }

  /* ---------- 내 영상 ---------- */

  function loadFile(file, which) {
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var sc = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(64, Math.round(img.naturalWidth * sc));
      var h = Math.max(64, Math.round(img.naturalHeight * sc));
      var c = R.offscreen(w, h), cc = c.getContext('2d');
      cc.drawImage(img, 0, 0, w, h);
      var rec = { g: Synth.fromImageData(cc.getImageData(0, 0, w, h)), w: w, h: h };
      if (which === 'a') S.pendingA = rec; else S.pendingB = rec;
      URL.revokeObjectURL(url);
      tryUploaded();
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('copy.fail'); };
    img.src = url;
  }

  function tryUploaded() {
    if (!S.pendingA || !S.pendingB) return;
    var A = S.pendingA, B = S.pendingB, w = A.w, h = A.h, b = B.g, note = '';
    if (B.w !== w || B.h !== h) {
      var out = new Float32Array(w * h);
      for (var j = 0; j < h; j++) {
        for (var i = 0; i < w; i++) out[j * w + i] = (i < B.w && j < B.h) ? B.g[j * B.w + i] : 0;
      }
      b = out; note = 'upload.size';
    }
    S.uploaded = { a: A.g, b: b, w: w, h: h };
    S.picked = -1;
    if (note) toast(note);
    updateStates(); updateHints();
    run(true);
  }

  function toast(key, raw) {
    var el = $('toast');
    el.textContent = raw || t(key);
    if (toast.timer) clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  function csv() {
    var res = S.res, lines = ['x_px,y_px,dx_px,dy_px,peak_R,snr,status'];
    for (var j = 0; j < res.ny; j++) {
      for (var i = 0; i < res.nx; i++) {
        var k = j * res.nx + i;
        lines.push([res.xs[i].toFixed(1), res.ys[j].toFixed(1),
          res.u[k].toFixed(4), res.v[k].toFixed(4), res.corr[k].toFixed(4),
          Math.min(99, res.snr[k]).toFixed(2), res.status[k]].join(','));
      }
    }
    return lines.join('\n');
  }

  function showDump(text) {
    var d = $('dump');
    d.value = text; d.hidden = false; d.select();
    $('gUpload').open = true;
    toast('copy.fail');
  }

  /* ---------- 배선 ---------- */

  function applyLang(next) {
    I18N.apply(next);
    document.title = t('doc.title');
    buildFlowSelect();
    pushControls();
    updateHints(); updateStates();
    $('headHint').textContent = S.step ? t('step.' + S.step + '.d') : '';
    $('runBtn').textContent = t(S.res ? 'run.again' : 'run');
    var lb = $('langSeg').children;
    for (var i = 0; i < lb.length; i++) {
      lb[i].className = lb[i].getAttribute('data-lang') === I18N.lang ? 'on' : '';
    }
    if (S.res) { updateStats(); updateWarn(); drawInspector(); bgKey = ''; draw(); }
    try { localStorage.setItem('piv.lang', I18N.lang); } catch (e) { /* 사생활 보호 모드 */ }
  }

  function afterChange(act) {
    updateHints();
    updateStates();
    updateWarn();
    if (act === 'draw') updateBlink();
    schedule(act);
  }

  function bind() {
    NUMS.forEach(function (p) {
      var r = $(p.range), n = $(p.num);
      r.addEventListener('input', function () {
        S[p.key] = +r.value;
        n.value = fmt(S[p.key], p.dec);
        afterChange(p.act);
      });
      n.addEventListener('change', function () {
        var v = +n.value;
        if (!isFinite(v)) { n.value = fmt(S[p.key], p.dec); return; }
        v = Math.max(+r.min, Math.min(+r.max, v));
        S[p.key] = v;
        r.value = v;
        n.value = fmt(v, p.dec);
        afterChange(p.act);
      });
    });

    PICKS.forEach(function (p) {
      $(p.id).addEventListener('change', function () {
        S[p.key] = p.str ? this.value : +this.value;
        if (p.key === 'field' || p.key === 'size') {
          S.uploaded = null; S.pendingA = S.pendingB = null;
        }
        afterChange(p.act);
      });
    });

    ['ovVectors', 'ovTruth', 'ovError', 'ovGrid'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        S.ov[id.slice(2).toLowerCase()] = this.checked;   /* ovTruth -> truth */
        bgKey = '';
        draw();
      });
    });

    $('runBtn').addEventListener('click', function () { run(true); });
    $('reshootBtn').addEventListener('click', function () {
      S.rngSeed = (Math.random() * 1e9) | 0;
      S.uploaded = null; S.pendingA = S.pendingB = null;
      $('fileA').value = ''; $('fileB').value = '';
      updateStates();
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

    $('stepSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-step]');
      if (b) setStep(+b.getAttribute('data-step'));
    });
    $('langSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-lang]');
      if (b) applyLang(b.getAttribute('data-lang'));
    });
    $('corrSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (!b) return;
      S.corrMode = b.getAttribute('data-mode');
      var kids = this.children;
      for (var i = 0; i < kids.length; i++) kids[i].className = kids[i] === b ? 'on' : '';
      drawInspector();
    });

    var wrap = $('stageWrap');
    wrap.addEventListener('click', function (e) { pickAt(e.clientX, e.clientY); });
    wrap.setAttribute('tabindex', '0');
    wrap.addEventListener('keydown', function (e) {
      if (!S.res) return;
      var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      var k = S.picked < 0 ? 0 : S.picked;
      var i = k % S.res.nx, j = (k - i) / S.res.nx;
      i = Math.max(0, Math.min(S.res.nx - 1, i + d[0]));
      j = Math.max(0, Math.min(S.res.ny - 1, j + d[1]));
      inspect(j * S.res.nx + i);
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
      updateStates(); updateHints();
      run(true);
    });

    var rt;
    root.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { bgKey = ''; draw(); }, 120);
    });
  }

  /* ---------- 시작 ---------- */

  function init() {
    var saved = null;
    try { saved = localStorage.getItem('piv.lang'); } catch (e) { /* 무시 */ }
    applyLang(saved === 'en' ? 'en' : 'ko');
    bind();
    pushControls();
    updateHints();
    updateStates();
    shoot();
    compute(true);
    veil(null);
    $('runBtn').textContent = t('run.again');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
