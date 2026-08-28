// Loop-closure detection. Records the ENU track and, when the current estimate
// comes back within a radius of a much earlier point, reports the closure so the
// caller can redistribute the accumulated error across the intervening track.

export class LoopCloser {
  constructor(cfg) {
    this.cfg = cfg;
    this.track = [];             // [{ e, n }] one entry per step
    this._grid = new Map();      // "cx_cy" -> [track index]
    this.cell = 8;               // m
  }

  setConfig(cfg) { this.cfg = cfg; }

  reset() {
    this.track.length = 0;
    this._grid.clear();
  }

  _cellKey(e, n) {
    return `${Math.floor(e / this.cell)}_${Math.floor(n / this.cell)}`;
  }

  // Add the latest position; returns a closure { matchIdx, error:{e,n} } or null.
  add(e, n) {
    const idx = this.track.length;
    this.track.push({ e, n });

    let closure = null;
    if (this.cfg.loopAuto && idx > this.cfg.loopMinSteps) {
      const cx = Math.floor(e / this.cell);
      const cy = Math.floor(n / this.cell);
      let bestIdx = -1;
      let bestD = this.cfg.loopRadiusM;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = this._grid.get(`${gx}_${gy}`);
          if (!arr) continue;
          for (const j of arr) {
            if (idx - j < this.cfg.loopMinSteps) continue;
            const p = this.track[j];
            const d = Math.hypot(p.e - e, p.n - n);
            if (d < bestD) { bestD = d; bestIdx = j; }
          }
        }
      }
      if (bestIdx >= 0) {
        const p = this.track[bestIdx];
        closure = { matchIdx: bestIdx, error: { e: e - p.e, n: n - p.n } };
      }
    }

    const k = this._cellKey(e, n);
    let arr = this._grid.get(k);
    if (!arr) { arr = []; this._grid.set(k, arr); }
    arr.push(idx);
    return closure;
  }

  // Redistribute `error` linearly from matchIdx to the end; rebuild the grid.
  // Returns the corrected track.
  applyClosure(matchIdx, error) {
    const last = this.track.length - 1;
    const span = Math.max(1, last - matchIdx);
    for (let i = matchIdx; i <= last; i++) {
      const f = (i - matchIdx) / span;
      this.track[i].e -= error.e * f;
      this.track[i].n -= error.n * f;
    }
    this._grid.clear();
    this.track.forEach((p, i) => {
      const k = this._cellKey(p.e, p.n);
      let arr = this._grid.get(k);
      if (!arr) { arr = []; this._grid.set(k, arr); }
      arr.push(i);
    });
    return this.track;
  }
}
