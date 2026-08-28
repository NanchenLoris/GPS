// Normalises the browser sensor APIs into event streams:
//
//   'motion'      { t, dt, ax, ay, az, amag, yawRate }   ~50-100 Hz (devicemotion)
//   'orientation' { t, heading, accuracy, beta, gamma }   OS fused compass
//   'mag'         { x, y, z }                             raw magnetometer, uT (Chrome/Android)
//   'pressure'    { hPa }                                 barometer (Chrome/Android)
//   'rate'        { hz }                                  motion sample rate, 1 Hz
//
// heading and yawRate are degrees, clockwise-positive, 0 = north.

export class Sensors extends EventTarget {
  constructor() {
    super();
    this._onMotion = this._onMotion.bind(this);
    this._onOri = this._onOri.bind(this);
    this.running = false;
    this._lastT = 0;
    this._count = 0;
    this._rateT = 0;
    this._haveAbsHeading = false;
    this.hasMag = false;
    this.hasBaro = false;
    this._mag = null;
    this._baro = null;
  }

  async requestPermission() {
    const asks = [];
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      asks.push(DeviceMotionEvent.requestPermission());
    }
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      asks.push(DeviceOrientationEvent.requestPermission());
    }
    if (asks.length === 0) return true;
    try {
      const results = await Promise.all(asks);
      return results.every((r) => r === 'granted');
    } catch {
      return false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._rateT = performance.now() / 1000;
    window.addEventListener('devicemotion', this._onMotion);
    window.addEventListener('deviceorientationabsolute', this._onOri);
    window.addEventListener('deviceorientation', this._onOri);
    this._startGeneric();
  }

  stop() {
    this.running = false;
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientationabsolute', this._onOri);
    window.removeEventListener('deviceorientation', this._onOri);
    try { this._mag && this._mag.stop(); } catch { /* */ }
    try { this._baro && this._baro.stop(); } catch { /* */ }
  }

  async _startGeneric() {
    // Raw magnetometer — Generic Sensor API, Chrome/Android, secure context.
    try {
      if ('Magnetometer' in window) {
        let allowed = true;
        if (navigator.permissions) {
          try {
            const p = await navigator.permissions.query({ name: 'magnetometer' });
            allowed = p.state !== 'denied';
          } catch { /* permission name unknown -> just try */ }
        }
        if (allowed) {
          this._mag = new Magnetometer({ frequency: 20, referenceFrame: 'device' });
          this._mag.addEventListener('reading', () => {
            this.hasMag = true;
            this.dispatchEvent(new CustomEvent('mag',
              { detail: { x: this._mag.x, y: this._mag.y, z: this._mag.z } }));
          });
          this._mag.addEventListener('error', () => { this._mag = null; });
          this._mag.start();
        }
      }
    } catch { this._mag = null; }

    // Barometer — Generic Sensor API extra class, Chrome/Android.
    try {
      if ('Barometer' in window) {
        this._baro = new Barometer({ frequency: 4 });
        this._baro.addEventListener('reading', () => {
          this.hasBaro = true;
          this.dispatchEvent(new CustomEvent('pressure',
            { detail: { hPa: this._baro.pressure } }));
        });
        this._baro.addEventListener('error', () => { this._baro = null; });
        this._baro.start();
      }
    } catch { this._baro = null; }
  }

  _onMotion(e) {
    const now = performance.now() / 1000;
    let dt = e.interval || 0;
    if (dt > 0.5) dt /= 1000;
    if (!dt || dt <= 0) dt = this._lastT ? now - this._lastT : 0.02;
    this._lastT = now;

    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    const ax = a.x, ay = a.y, az = a.z;
    const amag = Math.hypot(ax, ay, az);

    let yawRate = 0;
    const rr = e.rotationRate;
    if (rr && rr.alpha != null) yawRate = -rr.alpha;

    this._count++;
    if (now - this._rateT >= 1) {
      this.dispatchEvent(new CustomEvent('rate',
        { detail: { hz: this._count / (now - this._rateT) } }));
      this._count = 0;
      this._rateT = now;
    }

    this.dispatchEvent(new CustomEvent('motion',
      { detail: { t: now, dt, ax, ay, az, amag, yawRate } }));
  }

  _onOri(e) {
    let heading = null;
    let accuracy = null;

    if (e.webkitCompassHeading != null) {
      heading = e.webkitCompassHeading;
      accuracy = e.webkitCompassAccuracy;
      this._haveAbsHeading = true;
    } else if (e.absolute && e.alpha != null) {
      heading = (360 - e.alpha) % 360;
      this._haveAbsHeading = true;
    } else if (!this._haveAbsHeading && e.alpha != null) {
      heading = (360 - e.alpha) % 360;
      accuracy = 999;
    }
    if (heading == null) return;

    this.dispatchEvent(new CustomEvent('orientation', {
      detail: { t: performance.now() / 1000, heading, accuracy, beta: e.beta, gamma: e.gamma },
    }));
  }
}
