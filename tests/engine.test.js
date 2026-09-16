/* Numerical checks for the PIV engine. Run with: node tests/engine.test.js
 * The synthetic images have an analytic displacement field, so accuracy is
 * measurable rather than assumed.
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var rootDir = path.join(__dirname, '..');
['js/fft.js', 'js/flow.js', 'js/synth.js', 'js/piv.js'].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(rootDir, f), 'utf8'), { filename: f });
});
var S = globalThis.PIVSim;

var fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
}

function measure(o) {
  var W = o.width || 256, H = o.height || 256;
  var flow = S.Flow.bind(o.field, W, H, o.maxDisp);
  var img = S.Synth.generate({
    width: W, height: H, flow: flow, maxDisp: o.maxDisp,
    nPerWindow: o.nPerWindow || 14, dp: o.dp || 2.6,
    noise: o.noise === undefined ? 1.5 : o.noise,
    loss: o.loss || 0, seed: o.seed || 7
  });
  var res = S.PIV.run({
    imgA: img.a, imgB: img.b, width: W, height: H,
    win: o.win || 32, overlap: 0.5, passes: o.passes || 2,
    subpixel: o.subpixel || 'gauss', threshold: 2, snrMin: 1.2,
    masked: flow.def.mask ? flow.masked : null
  });
  var t = S.PIV.truth(res, flow);
  var bad = 0, weak = 0, tot = 0;
  for (var i = 0; i < res.status.length; i++) {
    if (res.status[i] === 2) continue;
    tot++;
    if (res.status[i] === 1) bad++;
    if (res.status[i] === 3) weak++;
  }
  return {
    res: res, truth: t, img: img, flow: flow,
    outlierPct: 100 * bad / tot, weakPct: 100 * weak / tot
  };
}

console.log('\n1. Uniform flow, sub-pixel accuracy');
[2.5, 5.37, 8.2].forEach(function (d) {
  var m = measure({ field: 'uniform', maxDisp: d });
  check('dx=' + d + 'px  RMS=' + m.truth.rms.toFixed(3) + 'px  bias=(' +
    m.truth.biasX.toFixed(3) + ',' + m.truth.biasY.toFixed(3) + ')',
    m.truth.rms < 0.15, 'outliers ' + m.outlierPct.toFixed(1) + '%');
});

console.log('\n2. Every flow field (dx=6px, 3 passes, 32px windows)');
/* The residual error here is spatial-resolution error: the window averages the
 * displacement it contains, while the reference is the value at its centre.
 * It scales with the gradient, so the tolerance is a fraction of dx, and the
 * rejected-vector rate must stay at the level real PIV data shows. */
S.Flow.fields.forEach(function (f) {
  var m = measure({ field: f.id, maxDisp: 6, passes: 3 });
  check(f.id.padEnd(11) + ' RMS=' + m.truth.rms.toFixed(3) + 'px  rejected=' +
    m.outlierPct.toFixed(1) + '%  weak=' + m.weakPct.toFixed(1) + '%',
    m.truth.rms < 0.25 * 6 && m.outlierPct < 8 && m.weakPct < 5);
});

console.log('\n3. Multi-pass improves a large-displacement case (dx=14px, 32px window)');
var p1 = measure({ field: 'vortex', maxDisp: 14, passes: 1 });
var p3 = measure({ field: 'vortex', maxDisp: 14, passes: 3 });
check('1 pass RMS=' + p1.truth.rms.toFixed(3) + '  ->  3 passes RMS=' + p3.truth.rms.toFixed(3),
  p3.truth.rms < p1.truth.rms);

console.log('\n4. Seeding density: too few particles must degrade the result');
var lo = measure({ field: 'uniform', maxDisp: 5, nPerWindow: 1.5 });
var hi = measure({ field: 'uniform', maxDisp: 5, nPerWindow: 20 });
check('N_I=1.5 RMS=' + lo.truth.rms.toFixed(3) + '  vs  N_I=20 RMS=' + hi.truth.rms.toFixed(3),
  hi.truth.rms < lo.truth.rms);

console.log('\n5. Loss of pairs lowers correlation and SNR');
function meanSnr(m) {
  var s = 0, n = 0;
  for (var i = 0; i < m.res.snr.length; i++) if (m.res.status[i] !== 2) { s += m.res.corr[i]; n++; }
  return s / n;
}
var l0 = measure({ field: 'uniform', maxDisp: 5, loss: 0 });
var l5 = measure({ field: 'uniform', maxDisp: 5, loss: 0.5 });
check('peak corr ' + meanSnr(l0).toFixed(3) + ' (0% loss)  ->  ' + meanSnr(l5).toFixed(3) + ' (50% loss)',
  meanSnr(l5) < meanSnr(l0));

console.log('\n6. Peak locking: centroid fitting is worse than Gaussian');
var g = measure({ field: 'uniform', maxDisp: 5.37, subpixel: 'gauss' });
var c = measure({ field: 'uniform', maxDisp: 5.37, subpixel: 'centroid' });
check('gauss RMS=' + g.truth.rms.toFixed(3) + '  centroid RMS=' + c.truth.rms.toFixed(3),
  c.truth.rms > g.truth.rms);

console.log('\n7. Solid-body rotation: vorticity must match 2*sin(Omega) exactly');
var rot = measure({ field: 'rotation', maxDisp: 6, passes: 3 });
var der = S.PIV.derive(rot.res);
var r = rot.res, vs = [], ds = [];
for (var j2 = 2; j2 < r.ny - 2; j2++) {           /* interior: one-sided edges excluded */
  for (var i2 = 2; i2 < r.nx - 2; i2++) {
    var kk = j2 * r.nx + i2;
    vs.push(der.vort[kk]); ds.push(Math.abs(der.div[kk]));
  }
}
var mv = vs.reduce(function (a, b) { return a + b; }, 0) / vs.length;
var sv = Math.sqrt(vs.reduce(function (a, b) { return a + (b - mv) * (b - mv); }, 0) / vs.length);
var md = ds.reduce(function (a, b) { return a + b; }, 0) / ds.length;
var exact = 2 * Math.sin(rot.flow.scale / (Math.min(256, 256) / 2));
check('vorticity ' + mv.toFixed(5) + ' vs exact ' + exact.toFixed(5) + ' /frame (' +
  (100 * (mv - exact) / exact).toFixed(1) + '%), scatter ' + (100 * sv / mv).toFixed(1) +
  '%, |div| ' + md.toFixed(5),
  Math.abs(mv - exact) / exact < 0.05 && sv / mv < 0.2 && md < 0.25 * Math.abs(mv));

console.log('\n8. Refining the window resolves the gradient (vortex core)');
var w32 = measure({ field: 'vortex', maxDisp: 6, win: 32, passes: 3 });
var w16 = measure({ field: 'vortex', maxDisp: 6, win: 16, passes: 3 });
check('32px window RMS=' + w32.truth.rms.toFixed(3) + '  ->  16px window RMS=' +
  w16.truth.rms.toFixed(3), w16.truth.rms < w32.truth.rms);

console.log('\n9. Timing (384x384, 32px windows, 50% overlap, 3 passes)');
var tb = Date.now();
var big = measure({ field: 'street', width: 384, height: 384, maxDisp: 8, passes: 3 });
check(big.res.nx + 'x' + big.res.ny + ' vectors in ' + (Date.now() - tb) + ' ms (engine ' +
  big.res.ms.toFixed(0) + ' ms)', big.res.ms < 4000);

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'all checks passed') + '\n');
process.exit(fails ? 1 : 0);
