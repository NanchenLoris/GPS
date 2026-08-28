// Heading estimator: gyro integration with a slow complementary pull toward the
// compass, an observable gyro-bias term, a zero-rotation-update from standstill,
// and Heuristic Drift Elimination (snap to dominant walking directions).

import { wrap360, angleDiff, clamp } from './utils.js';

export class Ahrs {
  constructor(cfg) {
    this.cfg = cfg;
    this.heading = null;   // deg cw from north, gyro-integrated
    this.bias = 0;         // deg/s, estimated gyro yaw bias
  }

  setConfig(cfg) { this.cfg = cfg; }

  seed(h) {
    if (this.heading == null && h != null) this.heading = wrap360(h);
  }

  // yawRate: deg/s, clockwise-positive.
  predict(yawRate, dt) {
    if (this.heading == null || yawRate == null) return;
    this.heading = wrap360(this.heading + (yawRate - this.bias) * dt);
  }

  // headingMeas: absolute heading from a compass. trust in (0, 1].
  updateCompass(headingMeas, dt, trust = 1) {
    if (headingMeas == null) return;
    this.seed(headingMeas);
    if (this.heading == null || this.cfg.headingMode === 'gyro') return;
    const tau = Math.max(0.3, this.cfg.compassTauS / Math.max(0.05, trust));
    const g = clamp(dt / tau, 0, 1);
    const err = angleDiff(headingMeas, this.heading);
    this.heading = wrap360(this.heading + err * g);
    // A persistent compass error means the gyro is over/under-rotating: if the
    // heading keeps drifting positive (err negative) the bias must increase so
    // predict() subtracts more. Hence -= err.
    this.bias -= clamp(this.cfg.compassBiasGain, 0, 0.05) * err * trust;
    this.bias = clamp(this.bias, -5, 5);
  }

  // Called with the mean gyro yaw rate measured while the phone was still.
  zuptBias(meanYawRate) {
    if (meanYawRate == null || !isFinite(meanYawRate)) return;
    this.bias = 0.5 * this.bias + 0.5 * meanYawRate;
    this.bias = clamp(this.bias, -5, 5);
  }

  // Snap toward a dominant direction while walking straight.
  hde(targetDir, gain) {
    if (this.heading == null || targetDir == null) return;
    this.heading = wrap360(this.heading + angleDiff(targetDir, this.heading) * gain);
  }

  // External correction (e.g. from map matching).
  correct(errDeg, gain) {
    if (this.heading == null) return;
    this.heading = wrap360(this.heading + errDeg * gain);
  }

  get() {
    return this.heading == null
      ? null
      : wrap360(this.heading + (this.cfg.headingOffsetDeg || 0));
  }
}

// Nearest dominant direction for HDE. `adaptive` is an array of learned
// directions (deg); the fixed modes use a regular rosette.
export function nearestDominant(headingDeg, mode, adaptive) {
  let dirs = null;
  if (mode === '4') dirs = [0, 90, 180, 270];
  else if (mode === '8') dirs = [0, 45, 90, 135, 180, 225, 270, 315];
  else if (mode === 'adaptive') dirs = adaptive && adaptive.length ? adaptive : null;
  if (!dirs) return null;

  let best = null;
  let bd = 1e9;
  for (const d of dirs) {
    const e = Math.abs(angleDiff(d, headingDeg));
    if (e < bd) { bd = e; best = d; }
  }
  return { dir: best, err: bd };
}

// Learns dominant corridors from the headings observed during straight walking.
export class AdaptiveDirs {
  constructor() { this.samples = []; }
  add(headingDeg) {
    this.samples.push(wrap360(headingDeg));
    if (this.samples.length > 600) this.samples.shift();
  }
  // Peaks of a 10-degree histogram, folded to 0..180 so opposite travel
  // directions on the same road reinforce each other.
  dirs() {
    if (this.samples.length < 30) return [];
    const bins = new Array(18).fill(0);
    for (const h of this.samples) bins[Math.floor(wrap360(h) % 180 / 10)]++;
    const mean = this.samples.length / 18;
    const peaks = [];
    for (let i = 0; i < 18; i++) {
      const c = bins[i];
      if (c < mean * 1.5 || c < 3) continue;
      const prev = bins[(i + 17) % 18];
      const next = bins[(i + 1) % 18];
      if (c >= prev && c >= next) {
        const centre = i * 10 + 5;
        peaks.push(centre, wrap360(centre + 180));
      }
    }
    return peaks;
  }
}
