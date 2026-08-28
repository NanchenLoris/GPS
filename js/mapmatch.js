// Online HMM map matching (forward Viterbi) against a RoadGraph.
//
// Each step, candidate road positions are scored by:
//   emission  - Gaussian on the perpendicular distance from the PDR point
//   transition - closeness of the along-network hop to the PDR step length,
//                times a Gaussian on heading vs the road bearing of travel
// The best current candidate is returned as a snapped position plus the road
// bearing in the direction of travel and the matched along-route hop (used to
// correct heading and stride scale).

import { angleDiff, wrap360 } from './utils.js';
import { enuToLatLng, vecBearing } from './geo.js';

export class MapMatcher {
  constructor(graph, cfg) {
    this.graph = graph;
    this.cfg = cfg;
    this.cands = [];        // [{ edge, proj, along, score, back }]
    this.prevPoint = null;
    this.lastBest = null;
    this.cumAlong = 0;      // metres matched along the network so far
    this.hist = [];         // [{ ll, s }] snapped path for terrain matching
  }

  setConfig(cfg) { this.cfg = cfg; }

  reset() {
    this.cands = [];
    this.prevPoint = null;
    this.lastBest = null;
    this.cumAlong = 0;
    this.hist = [];
  }

  _bearingOfTravel(cand, headingDeg) {
    const d = this.graph.edges[cand.edge].dir;
    let b = vecBearing(d[0], d[1]);
    if (Math.abs(angleDiff(b, headingDeg)) > 90) b = wrap360(b + 180);
    return b;
  }

  // p: PDR position { e, n }. Returns { snapped, confidence, bearing, alongDelta, name }.
  step(p, headingDeg, stepDist) {
    const c = this.cfg;
    const near = this.graph.segmentsNear(p, c.mmMaxCandidateM);
    if (!near.length) {
      this.cands = [];
      this.prevPoint = p;
      this.lastBest = null;
      return { snapped: null, confidence: 0 };
    }

    const next = near.map((s) => {
      const ed = this.graph.edges[s.edge];
      return {
        edge: s.edge,
        proj: s.proj,
        along: s.proj.t * ed.len,
        name: ed.name,
        score: 0,
        back: null,
      };
    });

    const emis = (cand) =>
      Math.exp(-0.5 * (cand.proj.dist / c.mmSearchRadiusM) ** 2);

    if (!this.cands.length) {
      for (const cand of next) cand.score = emis(cand);
    } else {
      const maxHop = stepDist * 3 + 30;
      for (const cand of next) {
        let best = 0;
        let bestPrev = null;
        for (const prev of this.cands) {
          const dR = this.graph.routeDistance(prev, cand, maxHop);
          const hop = isFinite(dR)
            ? Math.exp(-Math.abs(dR - stepDist) / c.mmTransBeta)
            : 1e-6;
          const brg = this._bearingOfTravel(cand, headingDeg);
          const hd = Math.exp(
            -0.5 * (angleDiff(brg, headingDeg) / c.mmHeadingSigmaDeg) ** 2);
          const sc = prev.score * (hop * hd + 1e-6);
          if (sc > best) { best = sc; bestPrev = prev; }
        }
        cand.score = best * emis(cand);
        cand.back = bestPrev;
      }
    }

    let sum = 0;
    for (const cand of next) sum += cand.score;
    if (sum <= 0) {
      // every transition was impossible (off-network gap, bad hypothesis) —
      // re-acquire from the emission model so we are not stuck at zero.
      for (const cand of next) { cand.score = emis(cand); cand.back = null; sum += cand.score; }
    }
    if (sum > 0) for (const cand of next) cand.score /= sum;

    let best = next[0];
    for (const cand of next) if (cand.score > best.score) best = cand;

    let alongDelta = 0;
    let bearing = null;
    if (best.back) {
      const dR = this.graph.routeDistance(best.back, best, stepDist * 3 + 30);
      if (isFinite(dR)) alongDelta = dR;
      bearing = this._bearingOfTravel(best, headingDeg);
    } else if (this.lastBest) {
      bearing = this._bearingOfTravel(best, headingDeg);
    }

    this.cands = next;
    this.prevPoint = p;
    this.lastBest = best;

    const confidence = best.proj.dist <= c.mmMaxCandidateM ? best.score : 0;
    const snapped = best.proj.point;

    if (confidence >= c.mmMinConfidence) {
      this.cumAlong += alongDelta || stepDist;
      const ll = enuToLatLng(this.graph.origin, snapped.e, snapped.n);
      this.hist.push({ ll, s: this.cumAlong });
      const keep = c.terrainWindowM * 2.5;
      while (this.hist.length > 2 && this.cumAlong - this.hist[0].s > keep) {
        this.hist.shift();
      }
    }

    return { snapped, confidence, bearing, alongDelta, name: best.name };
  }

  // Snapped path polyline over the last `windowM` metres, as [{lat,lng}].
  recentRoute(windowM) {
    if (this.hist.length < 2) return null;
    const cut = this.cumAlong - windowM;
    const pts = this.hist.filter((h) => h.s >= cut).map((h) => h.ll);
    return pts.length >= 2 ? pts : null;
  }
}
