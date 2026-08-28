// Rolling strip chart of the dynamic acceleration signal, with the peak
// thresholds drawn as guide lines and detected steps marked. Purely a tuning
// aid — watch it while walking and adjust the thresholds so one spike = one step.

export class StripChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.n = opts.n || 320;
    this.buf = new Float32Array(this.n);
    this.stepMark = new Uint8Array(this.n);
    this.i = 0;
    this.fullScale = opts.fullScale || 4; // m/s^2 at top/bottom edge
    this.thrHigh = opts.thrHigh ?? 1.2;
    this.thrLow = opts.thrLow ?? 0.35;
    this._resize = this._resize.bind(this);
    this._resize();
    addEventListener('resize', this._resize);
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this.draw();
  }

  setThresholds(high, low) {
    this.thrHigh = high;
    this.thrLow = low;
  }

  push(value) {
    this.buf[this.i] = value;
    this.stepMark[this.i] = 0;
    this.i = (this.i + 1) % this.n;
    this.draw();
  }

  markStep() {
    const idx = (this.i - 1 + this.n) % this.n;
    this.stepMark[idx] = 1;
  }

  draw() {
    const { ctx, w, h, n } = this;
    if (!w || !h) return;
    const mid = h / 2;
    const scale = (h / 2) / this.fullScale;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#22303c';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    ctx.strokeStyle = '#2f5d3a';
    ctx.beginPath();
    ctx.moveTo(0, mid - this.thrHigh * scale);
    ctx.lineTo(w, mid - this.thrHigh * scale);
    ctx.stroke();

    ctx.strokeStyle = '#5d472f';
    ctx.beginPath();
    ctx.moveTo(0, mid - this.thrLow * scale);
    ctx.lineTo(w, mid - this.thrLow * scale);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,207,92,0.85)';
    for (let k = 0; k < n; k++) {
      const idx = (this.i + k) % n;
      if (this.stepMark[idx]) {
        const x = (k / n) * w;
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }

    ctx.strokeStyle = '#57b6ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const idx = (this.i + k) % n;
      const x = (k / n) * w;
      const y = mid - this.buf[idx] * scale;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
