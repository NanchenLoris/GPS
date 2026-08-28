// Shared helpers + settings persistence.

export const d2r = Math.PI / 180;
export const r2d = 180 / Math.PI;

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// Normalise degrees to [0, 360). Snaps a value that floating-point error left a
// hair below 360 back to 0 so callers never display "360°".
export const wrap360 = (x) => {
  const r = ((x % 360) + 360) % 360;
  return r >= 360 - 1e-9 ? 0 : r;
};

// Shortest signed difference a - b, in (-180, 180].
export function angleDiff(a, b) {
  let d = wrap360(a - b);
  if (d > 180) d -= 360;
  return d;
}

// Minimal 3-vector ops (plain arrays [x, y, z]).
export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize: (a) => {
    const n = Math.hypot(a[0], a[1], a[2]) || 1e-9;
    return [a[0] / n, a[1] / n, a[2] / n];
  },
};

// Fixed-length sliding window with mean/variance.
export class Window {
  constructor(n) { this.n = n; this.buf = []; }
  push(x) { this.buf.push(x); if (this.buf.length > this.n) this.buf.shift(); }
  get length() { return this.buf.length; }
  full() { return this.buf.length >= this.n; }
  mean() {
    if (!this.buf.length) return 0;
    return this.buf.reduce((s, v) => s + v, 0) / this.buf.length;
  }
  variance() {
    if (this.buf.length < 2) return 0;
    const m = this.mean();
    return this.buf.reduce((s, v) => s + (v - m) * (v - m), 0) / this.buf.length;
  }
  clear() { this.buf.length = 0; }
}

export function fmt(n, digits = 1) {
  if (n == null || !isFinite(n)) return '–';
  return n.toFixed(digits);
}

export const DEFAULTS = {
  // --- stride / step detection ------------------------------------------
  headingMode: 'fused',        // 'fused' | 'compass' | 'gyro'
  stepMode: 'weinberg',        // 'weinberg' | 'constant' | 'height'
  weinbergK: 0.42,
  constantL: 0.70,
  heightCm: 175,
  strideScale: 1.0,            // multiplicative, corrected by map-matching
  thrHigh: 1.2,
  thrLow: 0.35,
  minStepMs: 260,
  minAmp: 1.6,
  gravityTauS: 2.0,
  driftPerStep: 0.02,
  headingNoiseDeg: 3,

  // --- heading fusion -------------------------------------------------
  compassTauS: 6,              // s, how slowly the compass corrects the gyro
  compassBiasGain: 0.002,      // how strongly compass error pulls gyro bias
  headingOffsetDeg: 0,        // device-to-walk carry offset
  compassCleanGate: true,      // drop compass when the magnetic field looks disturbed
  compassCleanTolUT: 14,       // µT deviation from the running median allowed

  // --- gyro-bias ZUPT ----------------------------------------------
  gyroBiasZupt: true,
  stillAccVar: 0.06,           // (m/s^2)^2 over ~0.5 s => "standing still"
  stillMinMs: 600,

  // --- Heuristic Drift Elimination -------------------------------
  hdeMode: 'adaptive',         // 'off' | '4' | '8' | 'adaptive'
  hdeGain: 0.12,
  hdeStraightSteps: 4,
  hdeYawVarMax: 10,            // (deg/s)^2 over window => walking straight
  hdeMaxSnapDeg: 35,           // don't snap if the nearest axis is further than this

  // --- OSM map matching ----------------------------------------------
  mmMode: 'off',               // 'off' | 'overpass' | 'file'
  mmWayTypes: 'motorway,trunk,primary,secondary,tertiary,unclassified,residential,service,living_street,pedestrian,footway,path,track,cycleway,bridleway,steps',
  mmSearchRadiusM: 22,         // emission sigma
  mmMaxCandidateM: 60,
  mmTransBeta: 12,             // transition sharpness, m
  mmHeadingSigmaDeg: 45,
  mmGainPos: 0.35,
  mmGainHeading: 0.05,
  mmGainStride: 0.02,
  mmMinConfidence: 0.5,
  mmOverpassUrl: 'https://overpass-api.de/api/interpreter',
  mmFetchRadiusM: 700,
  mmRefetchGapS: 20,

  // --- barometer + DEM terrain matching ----------------------------
  terrainMatch: false,
  terrainUrl: 'https://api.opentopodata.org/v1/srtm30m',
  terrainWindowM: 400,
  terrainStepM: 20,
  terrainMinReliefM: 8,
  terrainMaxShiftM: 120,
  terrainGain: 0.3,
  terrainEveryNSteps: 15,

  // --- coarse network leash (NOT GPS) ----------------------------
  netFix: false,
  netFixIntervalS: 45,
  netFixPull: 0.5,

  // --- loop closure -----------------------------------------------
  loopAuto: true,
  loopRadiusM: 12,
  loopMinSteps: 60,
};

const KEY = 'pdr.settings.v2';

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* no persistence */ }
}
