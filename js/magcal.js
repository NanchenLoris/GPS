// Magnetometer hard/soft-iron calibration (pragmatic "figure-8" method) plus a
// tilt-compensated compass. Only usable where the browser exposes the raw
// Magnetometer sensor (Chrome on Android). Elsewhere the OS fused compass
// heading from deviceorientation is used instead.

import { v3 } from './utils.js';

export class MagCal {
  constructor() {
    this.min = [1e9, 1e9, 1e9];
    this.max = [-1e9, -1e9, -1e9];
    this.h = [0, 0, 0];   // hard-iron offset
    this.s = [1, 1, 1];   // diagonal soft-iron scale
    this.r = [1, 1, 1];
    this.count = 0;
    this.medMag = null;   // running median-ish of calibrated field magnitude
  }

  add(m) {
    const v = [m.x, m.y, m.z];
    for (let i = 0; i < 3; i++) {
      this.min[i] = Math.min(this.min[i], v[i]);
      this.max[i] = Math.max(this.max[i], v[i]);
      // slow shrink so the envelope tracks a changing bias
      this.min[i] += 0.003;
      this.max[i] -= 0.003;
      this.h[i] = (this.min[i] + this.max[i]) / 2;
      this.r[i] = Math.max(1e-6, (this.max[i] - this.min[i]) / 2);
    }
    const avg = (this.r[0] + this.r[1] + this.r[2]) / 3 || 1e-6;
    for (let i = 0; i < 3; i++) this.s[i] = avg / this.r[i];
    this.count++;

    const c = this.cal(m);
    const mag = Math.hypot(c.x, c.y, c.z);
    this.medMag = this.medMag == null ? mag : this.medMag + 0.02 * (mag - this.medMag);
  }

  cal(m) {
    return {
      x: (m.x - this.h[0]) * this.s[0],
      y: (m.y - this.h[1]) * this.s[1],
      z: (m.z - this.h[2]) * this.s[2],
    };
  }

  // 0..1 coverage quality: how balanced the sampled sphere is.
  quality() {
    if (this.count < 40) return 0;
    const spans = [
      this.max[0] - this.min[0],
      this.max[1] - this.min[1],
      this.max[2] - this.min[2],
    ];
    const mn = Math.min(...spans);
    const mx = Math.max(...spans) || 1e-6;
    return Math.max(0, Math.min(1, mn / mx));
  }

  // True when the current field magnitude is close to the running median,
  // i.e. we are probably not next to a car / power line / rebar.
  fieldClean(m, tolUT) {
    if (this.medMag == null) return true;
    const c = this.cal(m);
    return Math.abs(Math.hypot(c.x, c.y, c.z) - this.medMag) <= tolUT;
  }
}

// Tilt-compensated heading, degrees clockwise from magnetic north.
// mCal: calibrated magnetometer vector. accel: accelerationIncludingGravity
// (device frame; reads ~ +g along the "up" axis when static).
export function tiltHeading(mCal, accel) {
  if (!accel || accel.x == null) return null;
  const a = [accel.x, accel.y, accel.z];
  const an = Math.hypot(a[0], a[1], a[2]);
  if (an < 1e-3) return null;

  const down = [-a[0] / an, -a[1] / an, -a[2] / an];
  const m = [mCal.x, mCal.y, mCal.z];

  let east = v3.cross(down, m);
  const en = v3.norm(east);
  if (en < 1e-6) return null;
  east = [east[0] / en, east[1] / en, east[2] / en];
  const north = v3.cross(east, down);

  // Device forward axis = +Y (top edge of the phone). Its components along the
  // world east/north directions give the heading.
  const hd = Math.atan2(east[1], north[1]) * 180 / Math.PI;
  return (hd + 360) % 360;
}
