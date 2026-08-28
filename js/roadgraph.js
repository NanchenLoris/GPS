// A routable graph of OSM ways in local ENU metres, with a uniform-grid spatial
// index for "segments near a point" and a bounded Dijkstra for the along-network
// distance between two projected positions (used by the HMM map matcher).

import { latLngToEnu, projPointSeg } from './geo.js';

const NODE_GRID = 0.6;   // m, coordinate snap to weld ways at shared vertices
const SEG_CELL = 30;     // m, spatial index cell size

export class RoadGraph {
  constructor(origin) {
    this.origin = origin;
    this.nodes = [];              // [{ e, n }]
    this._nodeKey = new Map();    // "gx_gy" -> node index
    this.edges = [];              // [{ a, b, len, dir:[de,dn], name }]
    this.adj = [];                // node index -> [{ to, edge, len }]
    this._grid = new Map();       // "cx_cy" -> [edge index]
    this.bbox = null;             // { s, w, n2, e2 } lat/lng of loaded area
  }

  get size() { return this.edges.length; }

  _node(e, n) {
    const key = `${Math.round(e / NODE_GRID)}_${Math.round(n / NODE_GRID)}`;
    let idx = this._nodeKey.get(key);
    if (idx == null) {
      idx = this.nodes.length;
      this.nodes.push({ e, n });
      this.adj.push([]);
      this._nodeKey.set(key, idx);
    }
    return idx;
  }

  _indexEdge(ei) {
    const { a, b } = this.edges[ei];
    const A = this.nodes[a], B = this.nodes[b];
    const minx = Math.min(A.e, B.e), maxx = Math.max(A.e, B.e);
    const miny = Math.min(A.n, B.n), maxy = Math.max(A.n, B.n);
    for (let cx = Math.floor(minx / SEG_CELL); cx <= Math.floor(maxx / SEG_CELL); cx++) {
      for (let cy = Math.floor(miny / SEG_CELL); cy <= Math.floor(maxy / SEG_CELL); cy++) {
        const k = `${cx}_${cy}`;
        let arr = this._grid.get(k);
        if (!arr) { arr = []; this._grid.set(k, arr); }
        arr.push(ei);
      }
    }
  }

  _addPolyline(latlngs, name) {
    let prev = null;
    for (const ll of latlngs) {
      const { e, n } = latLngToEnu(this.origin, ll.lat, ll.lng);
      const idx = this._node(e, n);
      if (prev != null && prev !== idx) {
        const A = this.nodes[prev], B = this.nodes[idx];
        const len = Math.hypot(B.e - A.e, B.n - A.n);
        if (len > 0.1) {
          const ei = this.edges.length;
          const dir = [(B.e - A.e) / len, (B.n - A.n) / len];
          this.edges.push({ a: prev, b: idx, len, dir, name: name || '' });
          this.adj[prev].push({ to: idx, edge: ei, len });
          this.adj[idx].push({ to: prev, edge: ei, len });
          this._indexEdge(ei);
        }
      }
      prev = idx;
    }
  }

  // Overpass JSON (`out geom`) elements.
  loadOverpass(elements, wayTypes) {
    const allow = new Set((wayTypes || '').split(',').map((s) => s.trim()).filter(Boolean));
    for (const el of elements) {
      if (el.type !== 'way' || !el.geometry) continue;
      const hw = el.tags && el.tags.highway;
      if (allow.size && hw && !allow.has(hw)) continue;
      this._addPolyline(
        el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })),
        (el.tags && (el.tags.name || el.tags.ref || hw)) || '',
      );
    }
  }

  // GeoJSON FeatureCollection with LineString / MultiLineString geometry.
  loadGeoJSON(gj) {
    const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
    for (const f of feats) {
      const g = f.geometry || f;
      const name = (f.properties && (f.properties.name || f.properties.highway)) || '';
      if (g.type === 'LineString') {
        this._addPolyline(g.coordinates.map((c) => ({ lat: c[1], lng: c[0] })), name);
      } else if (g.type === 'MultiLineString') {
        for (const line of g.coordinates) {
          this._addPolyline(line.map((c) => ({ lat: c[1], lng: c[0] })), name);
        }
      }
    }
  }

  // Edges with a projection within `radius` m of planar point p ({ e, n }).
  segmentsNear(p, radius) {
    const out = [];
    const seen = new Set();
    const r = Math.ceil(radius / SEG_CELL);
    const cx = Math.floor(p.e / SEG_CELL);
    const cy = Math.floor(p.n / SEG_CELL);
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        const arr = this._grid.get(`${gx}_${gy}`);
        if (!arr) continue;
        for (const ei of arr) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const ed = this.edges[ei];
          const proj = projPointSeg(p, this.nodes[ed.a], this.nodes[ed.b]);
          if (proj.dist <= radius) out.push({ edge: ei, proj });
        }
      }
    }
    return out;
  }

  // Along-network distance between two candidates
  //   c = { edge, proj:{ t, point } }
  // Returns metres, or Infinity beyond `maxDist`.
  routeDistance(cA, cB, maxDist) {
    const eA = this.edges[cA.edge];
    const eB = this.edges[cB.edge];
    if (cA.edge === cB.edge) {
      return Math.abs(cA.proj.t - cB.proj.t) * eA.len;
    }
    const targetA = eB.a, targetB = eB.b;
    const distToTargetA = cB.proj.t * eB.len;
    const distToTargetB = (1 - cB.proj.t) * eB.len;

    const best = new Map();
    const pq = [
      { node: eA.a, d: cA.proj.t * eA.len },
      { node: eA.b, d: (1 - cA.proj.t) * eA.len },
    ];
    best.set(eA.a, pq[0].d);
    best.set(eA.b, pq[1].d);
    let result = Infinity;

    while (pq.length) {
      let mi = 0;
      for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[mi].d) mi = i;
      const cur = pq.splice(mi, 1)[0];
      if (cur.d > maxDist) break;
      if ((best.get(cur.node) ?? Infinity) < cur.d) continue;

      if (cur.node === targetA) result = Math.min(result, cur.d + distToTargetA);
      if (cur.node === targetB) result = Math.min(result, cur.d + distToTargetB);
      if (isFinite(result)) continue; // first arrival at B's edge is optimal enough

      for (const nb of this.adj[cur.node]) {
        const nd = cur.d + nb.len;
        if (nd <= maxDist && nd < (best.get(nb.to) ?? Infinity)) {
          best.set(nb.to, nd);
          pq.push({ node: nb.to, d: nd });
        }
      }
    }
    return result;
  }
}
