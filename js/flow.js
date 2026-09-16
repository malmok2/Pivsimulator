/* PIV Simulator — analytic flow fields.
 *
 * Fields are defined in a normalised frame centred on the image:
 *   X = (x - W/2) / R,  Y = (H/2 - y) / R,  R = min(W,H)/2
 * so X,Y are O(1), Y points up (physics convention) while image y points down.
 *
 * Each field returns a dimensionless velocity (U,V); the app scales it so that
 * the 95th-percentile speed maps to the requested particle displacement in
 * pixels per frame. Steady fields, integrated with RK4 over one frame interval.
 */
(function (root) {
  'use strict';

  function sech2(t) { var c = Math.cosh(t); return 1 / (c * c); }

  /* Lamb-Oseen vortex: tangential velocity (1 - exp(-r^2/rc^2)) / r */
  function oseen(X, Y, xc, yc, gamma, rc, out) {
    var dx = X - xc, dy = Y - yc;
    var r2 = dx * dx + dy * dy;
    var r = Math.sqrt(r2);
    if (r < 1e-9) return;
    var ut = gamma * (1 - Math.exp(-r2 / (rc * rc))) / r;
    out[0] += -ut * dy / r;
    out[1] += ut * dx / r;
  }

  var FIELDS = [
    {
      id: 'uniform', group: 'basic',
      fn: function (X, Y, o) { o[0] = 1; o[1] = 0.28; }
    },
    {
      id: 'channel', group: 'basic',
      fn: function (X, Y, o) {
        var h = 0.86, s = Y / h;
        o[0] = s * s < 1 ? 1 - s * s : 0;
        o[1] = 0;
      },
      walls: [-0.86, 0.86]
    },
    {
      id: 'shear', group: 'shear',
      fn: function (X, Y, o) {
        var d = 0.16;
        o[0] = 0.62 + 0.38 * Math.tanh(Y / d);
        /* Kelvin-Helmholtz style roll-up of the interface */
        o[1] = 0.22 * Math.sin(2 * Math.PI * X / 0.9) * sech2(Y / d);
      }
    },
    {
      id: 'jet', group: 'shear',
      fn: function (X, Y, o) {
        var b = 0.11 + 0.16 * (X + 1) * 0.5;
        var f = sech2(Y / b);
        o[0] = f;
        o[1] = 0.28 * (Y / b) * f;
      }
    },
    {
      id: 'stagnation', group: 'shear',
      fn: function (X, Y, o) { o[0] = X; o[1] = -(Y + 1); }
    },
    {
      id: 'vortex', group: 'vortex',
      fn: function (X, Y, o) { o[0] = 0; o[1] = 0; oseen(X, Y, 0, 0, 1, 0.34, o); }
    },
    {
      id: 'vortexPair', group: 'vortex',
      fn: function (X, Y, o) {
        o[0] = 0; o[1] = 0;
        oseen(X, Y, -0.42, 0, 1, 0.26, o);
        oseen(X, Y, 0.42, 0, -1, 0.26, o);
      }
    },
    {
      id: 'rotation', group: 'vortex',
      fn: function (X, Y, o) { o[0] = -Y; o[1] = X; }
    },
    {
      id: 'cylinder', group: 'body',
      fn: function (X, Y, o) {
        var R = 0.36, r2 = X * X + Y * Y;
        if (r2 < R * R) { o[0] = 0; o[1] = 0; return; }
        var r4 = r2 * r2, R2 = R * R;
        o[0] = 1 - R2 * (X * X - Y * Y) / r4;
        o[1] = -2 * R2 * X * Y / r4;
      },
      mask: function (X, Y) { return X * X + Y * Y < 0.36 * 0.36; },
      body: { x: 0, y: 0, r: 0.36 }
    },
    {
      id: 'street', group: 'body',
      fn: function (X, Y, o) {
        var cx = -0.78, R = 0.17, r2 = (X - cx) * (X - cx) + Y * Y;
        o[0] = 1; o[1] = 0;
        if (r2 > R * R) {
          var r4 = r2 * r2, R2 = R * R, dx = X - cx;
          o[0] += -R2 * (dx * dx - Y * Y) / r4;
          o[1] += -2 * R2 * dx * Y / r4;
        } else { o[0] = 0; o[1] = 0; return; }
        /* alternating shed vortices forming the wake */
        var g = 0.46, rc = 0.15;
        for (var k = 0; k < 4; k++) {
          var vx = -0.34 + k * 0.52;
          var vy = (k % 2 === 0) ? 0.15 : -0.15;
          var sgn = (k % 2 === 0) ? -1 : 1;
          oseen(X, Y, vx, vy, sgn * g * Math.exp(-0.12 * k), rc, o);
        }
      },
      mask: function (X, Y) {
        var dx = X + 0.78;
        return dx * dx + Y * Y < 0.17 * 0.17;
      },
      body: { x: -0.78, y: 0, r: 0.17 }
    }
  ];

  var byId = Object.create(null);
  FIELDS.forEach(function (f) { byId[f.id] = f; });

  /* A field instance bound to an image size and a displacement scale.
   * velocity(x, y, out) gives pixel velocity per frame in image coordinates.
   */
  function bind(id, width, height, maxDisp) {
    var f = byId[id] || byId.uniform;
    var R = Math.min(width, height) / 2;
    var cx = width / 2, cy = height / 2;
    var tmp = [0, 0];

    /* Normalise so the 95th-percentile speed equals 1. */
    var samples = [];
    for (var j = 0; j <= 64; j++) {
      for (var i = 0; i <= 64; i++) {
        var X = (i / 64) * (width / R) - width / (2 * R);
        var Y = height / (2 * R) - (j / 64) * (height / R);
        if (f.mask && f.mask(X, Y)) continue;
        tmp[0] = 0; tmp[1] = 0; f.fn(X, Y, tmp);
        samples.push(Math.hypot(tmp[0], tmp[1]));
      }
    }
    samples.sort(function (a, b) { return a - b; });
    var ref = samples[Math.floor(samples.length * 0.95)] || 1;
    var k = maxDisp / (ref || 1);

    function velocity(x, y, out) {
      var X = (x - cx) / R, Y = (cy - y) / R;
      tmp[0] = 0; tmp[1] = 0;
      f.fn(X, Y, tmp);
      out[0] = tmp[0] * k;
      out[1] = -tmp[1] * k;   /* back to image (y-down) coordinates */
      return out;
    }

    /* Displacement over one frame interval: RK4 on dx/dtau = velocity, tau in [0,1]. */
    var k1 = [0, 0], k2 = [0, 0], k3 = [0, 0], k4 = [0, 0];
    function displacement(x, y, out, steps) {
      var n = steps || 4, h = 1 / n, px = x, py = y;
      for (var s = 0; s < n; s++) {
        velocity(px, py, k1);
        velocity(px + 0.5 * h * k1[0], py + 0.5 * h * k1[1], k2);
        velocity(px + 0.5 * h * k2[0], py + 0.5 * h * k2[1], k3);
        velocity(px + h * k3[0], py + h * k3[1], k4);
        px += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
        py += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
      }
      out[0] = px - x; out[1] = py - y;
      return out;
    }

    function maskedPx(x, y) {
      if (!f.mask) return false;
      return f.mask((x - cx) / R, (cy - y) / R);
    }

    return {
      id: f.id, def: f, width: width, height: height, scale: k,
      velocity: velocity, displacement: displacement, masked: maskedPx,
      /* body outline in pixel coordinates, for drawing */
      bodyPx: f.body ? { x: cx + f.body.x * R, y: cy - f.body.y * R, r: f.body.r * R } : null,
      wallsPx: f.walls ? f.walls.map(function (Y) { return cy - Y * R; }) : null
    };
  }

  root.PIVSim = root.PIVSim || {};
  root.PIVSim.Flow = { fields: FIELDS, bind: bind };
})(typeof globalThis !== 'undefined' ? globalThis : this);
