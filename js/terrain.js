// Barometer + digital-elevation-model matching (a hiking TERCOM).
//
// Measured relative altitude comes from the barometer. Given a candidate path
// (from the map matcher) we sample DEM elevations along it, then slide the
// measured profile along the route-distance axis to find the along-track offset
// that best explains the climb/descent seen so far. Only meaningful where there
// is real relief and a path hypothesis.

import { haversine, destination, bearing } from './geo.js';

export class Terrain {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();                 // "lat,lng"(5dp) -> elevation m
    this.provider = (lls) => this._openTopo(lls);
  }

  setConfig(cfg) { this.cfg = cfg; }
  setProvider(fn) { this.provider = fn; } // fn(latlngs) -> Promise<number[]>

  _key(ll) { return `${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`; }

  async _openTopo(lls) {
    const out = new Array(lls.length).fill(null);
    const miss = [];
    lls.forEach((ll, i) => {
      const v = this.cache.get(this._key(ll));
      if (v != null) out[i] = v;
      else miss.push(i);
    });
    for (let b = 0; b < miss.length; b += 90) {
      const idx = miss.slice(b, b + 90);
      const locs = idx.map((i) => `${lls[i].lat},${lls[i].lng}`).join('|');
      const url = `${this.cfg.terrainUrl}?locations=${encodeURIComponent(locs)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`terrain provider ${r.status}`);
      const j = await r.json();
      (j.results || []).forEach((res, k) => {
        const i = idx[k];
        const el = res && res.elevation;
        if (el != null) { out[i] = el; this.cache.set(this._key(lls[i]), el); }
      });
    }
    return out;
  }

  // routeLLs: [{lat,lng}] snapped path (oldest -> newest).
  // measured: [{ s, dz }] cumulative route-distance and relative altitude.
  // Returns an along-track correction in metres to add to the current position
  // along the direction of travel (negative = the estimate is ahead of where
  // the terrain says we are, move it back), or null.
  async match(routeLLs, measured) {
    const c = this.cfg;
    if (!routeLLs || routeLLs.length < 2 || measured.length < 5) return null;

    // resample the route at a fixed spacing
    const seg = [];
    let acc = 0;
    for (let i = 1; i < routeLLs.length; i++) {
      const d = haversine(routeLLs[i - 1], routeLLs[i]);
      seg.push({ s0: acc, s1: acc + d, a: routeLLs[i - 1], b: routeLLs[i], d });
      acc += d;
    }
    const total = acc;
    if (total < c.terrainMinReliefM * 4) return null;

    const step = c.terrainStepM;
    const samples = [];
    for (let s = 0; s <= total; s += step) {
      const sg = seg.find((x) => s >= x.s0 && s <= x.s1) || seg[seg.length - 1];
      const f = sg.d > 0 ? (s - sg.s0) / sg.d : 0;
      samples.push(destination(sg.a, bearing(sg.a, sg.b), f * sg.d));
    }
    let elev;
    try { elev = await this.provider(samples); } catch { return null; }
    if (elev.some((e) => e == null)) return null;

    const relief = Math.max(...elev) - Math.min(...elev);
    if (relief < c.terrainMinReliefM) return null;

    const elevAt = (s) => {
      const x = s / step;
      const i = Math.max(0, Math.min(elev.length - 2, Math.floor(x)));
      return elev[i] + (elev[i + 1] - elev[i]) * (x - i);
    };

    // measured dz is relative; compare shapes after removing the mean
    const m0 = measured[0].s;
    const md = measured.map((p) => ({ s: p.s - m0, dz: p.dz }));
    const span = md[md.length - 1].s;
    const base = total - span; // align measured window to the end of the route

    const mMean = md.reduce((a, b) => a + b.dz, 0) / md.length;
    const scored = [];
    for (let sh = -c.terrainMaxShiftM; sh <= c.terrainMaxShiftM; sh += step) {
      const start = base + sh;
      if (start < 0 || start + span > total) continue;
      const routeEl = md.map((p) => elevAt(start + p.s));
      const mean = routeEl.reduce((a, b) => a + b, 0) / routeEl.length;
      let sse = 0;
      for (let i = 0; i < md.length; i++) {
        const r = (md[i].dz - mMean) - (routeEl[i] - mean);
        sse += r * r;
      }
      scored.push({ sh, rms: Math.sqrt(sse / md.length) });
    }
    if (scored.length < 3) return null;
    scored.sort((a, b) => a.rms - b.rms);
    const best = scored[0];
    // reject a fit that is not clearly better than the next non-adjacent option
    const runnerUp = scored.find((s) => Math.abs(s.sh - best.sh) > 2 * step);
    if (best.rms > c.terrainMinReliefM * 0.6) return null;
    if (runnerUp && best.rms > 0.7 * runnerUp.rms) return null;
    // best.sh is how far to slide the measured window along the route to fit the
    // terrain; that is exactly the along-travel correction for the position.
    return best.sh * c.terrainGain;
  }
}

// Relative altitude (m) from pressure vs a reference pressure p0 (hPa).
export function altFromPressure(hPa, p0) {
  return 44330 * (1 - Math.pow(hPa / p0, 0.1902949));
}
