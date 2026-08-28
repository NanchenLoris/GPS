// Pedestrian dead reckoning engine.
//
// Detects discrete steps from the dynamic acceleration magnitude, estimates a
// length for each, and advances the position estimate one step at a time along
// the fused heading (see ahrs.js). It does NOT integrate acceleration into
// velocity/position. Heading, stride scale and position all accept external
// corrections (from magnetometer, map matching, loop closure, ...).
//
// Events:
//   'signal'  { t, hp }                       every motion sample (chart)
//   'heading' { heading, source, compass, acc }
//   'pos'     { latlng, e, n, steps, dist, disp, heading, headingSource,
//               gyroBias, strideScale, sigma, elapsed, step?, L?, amp?, cadence? }

import { wrap360, clamp, d2r, Window } from './utils.js';
import { enuToLatLng } from './geo.js';
import { Ahrs, nearestDominant, AdaptiveDirs } from './ahrs.js';

export class PDR extends EventTarget {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ahrs = new Ahrs(cfg);
    this.adaptive = new AdaptiveDirs();
    this.enabled = false;
    this.stepHook = null;      // called (this) on each step before 'pos' is emitted
    this.reset();
  }

  setConfig(cfg) { this.cfg = cfg; this.ahrs.setConfig(cfg); }

  reset() {
    this.origin = null;
    this.e = 0;
    this.n = 0;
    this.steps = 0;
    this.dist = 0;
    this.strideScale = this.cfg.strideScale || 1;

    this.lp = null;
    this.inPeak = false;
    this.peakVal = 0;
    this.winMax = -1e9;
    this.winMin = 1e9;
    this.lastStepMs = 0;
    this.prevStepT = 0;

    this.ahrs.heading = null;
    this.ahrs.bias = 0;
    this.headingSource = '–';
    this._lastHeadingT = performance.now() / 1000;

    this._accVar = new Window(25);   // ~0.5 s of |a|_dyn for stillness
    this._yawWin = new Window(25);   // yaw rate for straightness + ZUPT
    this._stillSince = 0;
    this._stillYaw = [];
    this._straightSteps = 0;

    this.posSigma = 0;
    this.startT = performance.now() / 1000;
    this.calib = null;
  }

  setOrigin(latlng, gpsAcc) {
    this.origin = { lat: latlng.lat, lng: latlng.lng };
    this.e = 0;
    this.n = 0;
    this.dist = 0;
    this.steps = 0;
    this.posSigma = gpsAcc || 3;
    this.startT = performance.now() / 1000;
    this._emitPos();
  }

  hasOrigin() { return this.origin != null; }
  getEN() { return { e: this.e, n: this.n }; }
  getHeading() { return this.ahrs.get(); }

  // ---- external corrections ------------------------------------------
  applyPositionCorrection(en, gain) {
    this.e += gain * (en.e - this.e);
    this.n += gain * (en.n - this.n);
    this.posSigma *= (1 - 0.3 * gain);
  }
  applyHeadingCorrection(errDeg, gain) { this.ahrs.correct(errDeg, gain); }
  adjustStride(ratio, gain) {
    if (!(ratio > 0) || !isFinite(ratio)) return;
    this.strideScale = clamp(this.strideScale * (1 + gain * (ratio - 1)), 0.5, 1.6);
  }
  nudgeAlong(bearingDeg, dist) {
    this.e += Math.sin(bearingDeg * d2r) * dist;
    this.n += Math.cos(bearingDeg * d2r) * dist;
  }
  setTrack(enArray) {
    if (!enArray || !enArray.length) return;
    const last = enArray[enArray.length - 1];
    this.e = last.e;
    this.n = last.n;
  }

  // ---- heading inputs ----------------------------------------------
  feedHeading(headingDeg, trust, source) {
    const now = performance.now() / 1000;
    const dt = clamp(now - this._lastHeadingT, 0.01, 1);
    this._lastHeadingT = now;
    this.ahrs.updateCompass(headingDeg, dt, trust);
    this.headingSource = source;
    this.dispatchEvent(new CustomEvent('heading', {
      detail: { heading: this.ahrs.get(), source, compass: headingDeg, acc: trust },
    }));
  }

  // OS fused compass (used only when no raw magnetometer feed is present).
  feedOrientation(s) {
    if (this._magActive) return;
    let trust = 1;
    if (s.accuracy === 999) trust = 0.05;
    else if (s.accuracy != null && s.accuracy > 25) trust = 0.3;
    this.feedHeading(s.heading, trust, 'os-compass');
  }
  markMagActive() { this._magActive = true; }

  // ---- motion ----------------------------------------------------
  feedMotion(s) {
    const c = this.cfg;

    this.ahrs.predict(s.yawRate, s.dt);
    this._yawWin.push(s.yawRate);

    if (this.lp == null) this.lp = s.amag;
    const ag = clamp(s.dt / Math.max(0.2, c.gravityTauS), 0, 1);
    this.lp += ag * (s.amag - this.lp);
    const hp = s.amag - this.lp;
    this._accVar.push(hp);

    this.dispatchEvent(new CustomEvent('signal', { detail: { t: s.t, hp } }));

    // stillness -> gyro-bias ZUPT
    if (c.gyroBiasZupt) {
      const still = this._accVar.full() && this._accVar.variance() < c.stillAccVar;
      const nowMs = s.t * 1000;
      if (still) {
        if (!this._stillSince) { this._stillSince = nowMs; this._stillYaw = []; }
        this._stillYaw.push(s.yawRate);
      } else if (this._stillSince) {
        if (nowMs - this._stillSince > c.stillMinMs && this._stillYaw.length > 5) {
          const m = this._stillYaw.reduce((a, b) => a + b, 0) / this._stillYaw.length;
          this.ahrs.zuptBias(m);
        }
        this._stillSince = 0;
      }
    }

    if (!this.enabled || !this.origin) return;

    const nowMs = s.t * 1000;
    if (!this.inPeak) {
      this.winMax = s.amag;
      this.winMin = s.amag;
      if (hp > c.thrHigh && (nowMs - this.lastStepMs) > c.minStepMs) {
        this.inPeak = true;
        this.peakVal = hp;
      }
    } else {
      this.winMax = Math.max(this.winMax, s.amag);
      this.winMin = Math.min(this.winMin, s.amag);
      if (hp > this.peakVal) this.peakVal = hp;
      if (hp < c.thrLow) {
        this.inPeak = false;
        const amp = this.winMax - this.winMin;
        if (amp >= c.minAmp) {
          this._onStep(s.t, this._stepLength(amp), amp);
          this.lastStepMs = nowMs;
        }
      }
    }
  }

  _stepLength(amp) {
    const c = this.cfg;
    let L;
    if (c.stepMode === 'constant') L = c.constantL;
    else if (c.stepMode === 'height') L = (c.heightCm / 100) * 0.415;
    else L = c.weinbergK * Math.pow(Math.max(amp, 0.01), 0.25);
    return L * this.strideScale;
  }

  _onStep(t, L, amp) {
    const c = this.cfg;

    if (this.calib) {
      this.calib.steps++;
      this.calib.sumQ += Math.pow(Math.max(amp, 0.01), 0.25);
    }

    // Heuristic Drift Elimination: after several straight steps, snap heading
    // toward the nearest dominant walking direction.
    const yawVar = this._yawWin.variance();
    if (yawVar < c.hdeYawVarMax) {
      this._straightSteps++;
      this.adaptive.add(this.ahrs.heading ?? 0);
      if (c.hdeMode !== 'off' && this._straightSteps >= c.hdeStraightSteps) {
        const nd = nearestDominant(this.ahrs.heading ?? 0, c.hdeMode, this.adaptive.dirs());
        if (nd && nd.err <= c.hdeMaxSnapDeg) this.ahrs.hde(nd.dir, c.hdeGain);
      }
    } else {
      this._straightSteps = 0;
    }

    this.steps++;
    this.dist += L;
    const hr = this.getHeading() * d2r;
    this.e += L * Math.sin(hr);
    this.n += L * Math.cos(hr);

    const cadence = this.prevStepT ? 1 / (t - this.prevStepT) : 0;
    this.prevStepT = t;

    const headSig = c.headingNoiseDeg * d2r;
    this.posSigma += Math.hypot(L * headSig, L * c.driftPerStep);

    this._lastStep = { t, L, amp, cadence };
    if (this.stepHook) this.stepHook(this);
    this._emitPos({ step: true, L, amp, cadence });
  }

  _emitPos(extra = {}) {
    if (!this.origin) return;
    const latlng = enuToLatLng(this.origin, this.e, this.n);
    this.dispatchEvent(new CustomEvent('pos', {
      detail: {
        latlng,
        e: this.e,
        n: this.n,
        steps: this.steps,
        dist: this.dist,
        disp: Math.hypot(this.e, this.n),
        heading: this.getHeading(),
        headingSource: this.headingSource,
        gyroBias: this.ahrs.bias,
        strideScale: this.strideScale,
        sigma: this.posSigma,
        elapsed: performance.now() / 1000 - this.startT,
        ...extra,
      },
    }));
  }

  // ---- stride calibration ---------------------------------------
  startCalib() { this.calib = { steps: 0, sumQ: 0 }; }
  stopCalib(knownDist) {
    const cal = this.calib;
    this.calib = null;
    if (!cal || cal.steps < 3 || !(knownDist > 0)) return null;
    return {
      steps: cal.steps,
      avgL: knownDist / cal.steps,
      weinbergK: cal.sumQ > 0 ? knownDist / cal.sumQ : this.cfg.weinbergK,
    };
  }
}
