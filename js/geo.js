// WGS84 <-> local ENU (metres) and spherical helpers.
// ENU points use { e, n }; lat/lng points use { lat, lng }.

const R = 6378137; // Earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function enuToLatLng(origin, e, n) {
  const dLat = (n / R) * R2D;
  const dLon = (e / (R * Math.cos(origin.lat * D2R))) * R2D;
  return { lat: origin.lat + dLat, lng: origin.lng + dLon };
}

export function latLngToEnu(origin, lat, lng) {
  const e = (lng - origin.lng) * D2R * R * Math.cos(origin.lat * D2R);
  const n = (lat - origin.lat) * D2R * R;
  return { e, n };
}

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLng = (b.lng - a.lng) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Initial bearing a -> b, degrees clockwise from north.
export function bearing(a, b) {
  const dLng = (b.lng - a.lng) * D2R;
  const y = Math.sin(dLng) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) -
    Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos(dLng);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(a, bearingDeg, dist) {
  const d = dist / R;
  const br = bearingDeg * D2R;
  const lat1 = a.lat * D2R;
  const lng1 = a.lng * D2R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * R2D, lng: lng2 * R2D };
}

// Project planar point p onto segment a-b (all { e, n }); clamped to the segment.
export function projPointSeg(p, a, b) {
  const abx = b.e - a.e;
  const aby = b.n - a.n;
  const L2 = abx * abx + aby * aby || 1e-9;
  let t = ((p.e - a.e) * abx + (p.n - a.n) * aby) / L2;
  t = Math.max(0, Math.min(1, t));
  const point = { e: a.e + t * abx, n: a.n + t * aby };
  const dist = Math.hypot(p.e - point.e, p.n - point.n);
  return { t, point, dist };
}

// Bearing (deg cw from north) of a planar direction vector.
export function vecBearing(de, dn) {
  return (Math.atan2(de, dn) * R2D + 360) % 360;
}
