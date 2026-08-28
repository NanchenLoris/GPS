// Wiring: sensors -> PDR (+ magnetometer heading) -> corrections (map matching,
// terrain, loop closure, network leash) -> map + chart + readouts.

import { Sensors } from './sensors.js';
import { PDR } from './pdr.js';
import { StripChart } from './chart.js';
import { TrackMap } from './map.js';
import { RoadGraph } from './roadgraph.js';
import { MapMatcher } from './mapmatch.js';
import { Terrain, altFromPressure } from './terrain.js';
import { NetFix } from './netfix.js';
import { LoopCloser } from './loop.js';
import { InertialModel } from './model.js';
import { MagCal, tiltHeading } from './magcal.js';
import { loadSettings, saveSettings, DEFAULTS, angleDiff } from './utils.js';
import { enuToLatLng, latLngToEnu, haversine, bearing, destination } from './geo.js';

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
const sensors = new Sensors();
const pdr = new PDR(settings);
const map = new TrackMap('map');
const chart = new StripChart($('chart'), { thrHigh: settings.thrHigh, thrLow: settings.thrLow });
const magcal = new MagCal();
const terrain = new Terrain(settings);
const netfix = new NetFix();
const loop = new LoopCloser(settings);
const model = new InertialModel();
map.invalidate();

let graph = null;
let mm = null;
let graphBBox = null;
let lastFetchT = 0;
let lastMatch = null;
let lastMotionT = 0;
let lastAccel = null;
let sensorsOn = false;
let tracking = false;
let wakeLock = null;
let p0 = null;             // reference pressure
let curRelAlt = null;
let terrainBuf = [];
let terrainBusy = false;
const speedWin = [];

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
const FIELDS = {
  sHeadingMode: 'headingMode', sStepMode: 'stepMode', sWeinbergK: 'weinbergK',
  sConstantL: 'constantL', sHeightCm: 'heightCm', sThrHigh: 'thrHigh', sThrLow: 'thrLow',
  sMinStepMs: 'minStepMs', sMinAmp: 'minAmp', sHeadingOffset: 'headingOffsetDeg',
};

function settingsToForm() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = settings[key];
}
function formToSettings() {
  for (const [id, key] of Object.entries(FIELDS)) {
    const el = $(id);
    settings[key] = el.type === 'number' ? parseFloat(el.value) : el.value;
  }
  apply();
}
for (const id of Object.keys(FIELDS)) $(id).addEventListener('change', formToSettings);
settingsToForm();

// ---------------------------------------------------------------------------
// Corrections sheet (schema-generated)
// ---------------------------------------------------------------------------
const CORR = [
  ['compassTauS', 'Compass time constant (s)', 'number', 0.5],
  ['compassCleanGate', 'Ignore disturbed magnetic field', 'bool'],
  ['compassCleanTolUT', 'Field-clean tolerance (µT)', 'number', 1],
  ['gyroBiasZupt', 'Gyro-bias estimation at standstill', 'bool'],
  ['stillAccVar', 'Standstill accel-var threshold', 'number', 0.01],
  ['hdeMode', 'Heuristic Drift Elimination', 'select',
    [['off', 'off'], ['4', '4 axes'], ['8', '8 axes'], ['adaptive', 'adaptive']]],
  ['hdeGain', 'HDE snap gain', 'number', 0.01],
  ['hdeStraightSteps', 'HDE straight-step count', 'number', 1],
  ['mmMode', 'OSM map matching', 'select',
    [['off', 'off'], ['overpass', 'online (Overpass)'], ['file', 'loaded GeoJSON']]],
  ['mmWayTypes', 'Way types', 'text'],
  ['mmSearchRadiusM', 'Match radius σ (m)', 'number', 1],
  ['mmGainPos', 'MM position gain', 'number', 0.01],
  ['mmGainHeading', 'MM heading gain', 'number', 0.01],
  ['mmGainStride', 'MM stride gain', 'number', 0.01],
  ['mmMinConfidence', 'MM min confidence', 'number', 0.05],
  ['mmOverpassUrl', 'Overpass endpoint', 'text'],
  ['terrainMatch', 'Barometer + DEM terrain matching', 'bool'],
  ['terrainUrl', 'Elevation endpoint', 'text'],
  ['terrainMinReliefM', 'Min relief to match (m)', 'number', 1],
  ['netFix', 'Coarse network leash (not GPS)', 'bool'],
  ['netFixIntervalS', 'Network leash interval (s)', 'number', 5],
  ['loopAuto', 'Automatic loop closure', 'bool'],
  ['loopRadiusM', 'Loop-closure radius (m)', 'number', 1],
  ['loopMinSteps', 'Loop-closure min steps', 'number', 10],
];

function buildCorrFields() {
  const host = $('corrFields');
  host.innerHTML = '';
  for (const [key, label, type, extra] of CORR) {
    const lab = document.createElement('label');
    lab.textContent = label + ' ';
    let el;
    if (type === 'bool') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = !!settings[key];
      el.addEventListener('change', () => { settings[key] = el.checked; apply(); });
    } else if (type === 'select') {
      el = document.createElement('select');
      for (const [v, t] of extra) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        el.appendChild(o);
      }
      el.value = settings[key];
      el.addEventListener('change', () => { settings[key] = el.value; apply(); });
    } else {
      el = document.createElement('input');
      el.type = type === 'number' ? 'number' : 'text';
      if (type === 'number') el.step = extra;
      el.value = settings[key];
      el.addEventListener('change', () => {
        settings[key] = type === 'number' ? parseFloat(el.value) : el.value;
        apply();
      });
    }
    lab.appendChild(el);
    host.appendChild(lab);
  }
}
function syncCorrForm() { buildCorrFields(); }
buildCorrFields();

function corrMsg(t) { $('corrMsg').textContent = t || ''; }

// honour anything restored from localStorage (e.g. netFix already on)
apply();

// ---------------------------------------------------------------------------
// apply(): push settings everywhere
// ---------------------------------------------------------------------------
function apply() {
  saveSettings(settings);
  pdr.setConfig(settings);
  chart.setThresholds(settings.thrHigh, settings.thrLow);
  terrain.setConfig(settings);
  loop.setConfig(settings);
  if (mm) mm.setConfig(settings);

  if (settings.netFix && !netfix.timer) netfix.start(settings.netFixIntervalS, onNetFix);
  if (!settings.netFix && netfix.timer) netfix.stop();

  if (settings.mmMode === 'overpass' && pdr.origin && !graph) fetchWays(currentLL());
  if (settings.mmMode === 'off') { map.setSnapped(null); $('rMM').textContent = 'off'; }
}

$('btnSettings').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
  $('calib').hidden = true; $('corrections').hidden = true;
});
$('btnSettingsClose').addEventListener('click', () => { $('settings').hidden = true; });
$('btnSettingsReset').addEventListener('click', () => {
  settings = { ...DEFAULTS };
  settingsToForm(); syncCorrForm(); apply();
});
$('btnCorr').addEventListener('click', () => {
  $('corrections').hidden = !$('corrections').hidden;
  $('settings').hidden = true; $('calib').hidden = true;
});
$('btnCorrClose').addEventListener('click', () => { $('corrections').hidden = true; });

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------
sensors.addEventListener('motion', (e) => {
  lastMotionT = performance.now() / 1000;
  const d = e.detail;
  lastAccel = { x: d.ax, y: d.ay, z: d.az };
  pdr.feedMotion(d);
});

sensors.addEventListener('orientation', (e) => pdr.feedOrientation(e.detail));

sensors.addEventListener('mag', (e) => {
  magcal.add(e.detail);
  pdr.markMagActive();
  $('rMagCal').textContent = `${(magcal.quality() * 100).toFixed(0)}%`;
  if (!lastAccel) return;
  if (settings.compassCleanGate &&
      !magcal.fieldClean(e.detail, settings.compassCleanTolUT)) return;
  const h = tiltHeading(magcal.cal(e.detail), lastAccel);
  if (h != null) pdr.feedHeading(h, 0.2 + 0.8 * magcal.quality(), 'mag');
});

sensors.addEventListener('pressure', (e) => {
  const h = e.detail.hPa;
  if (p0 == null) p0 = h;
  curRelAlt = altFromPressure(h, p0);
  $('rAlt').textContent = `${curRelAlt >= 0 ? '+' : ''}${curRelAlt.toFixed(1)} m`;
});

sensors.addEventListener('rate', (e) => {
  $('rHz').textContent = `${e.detail.hz.toFixed(0)} Hz`;
});

// ---------------------------------------------------------------------------
// PDR
// ---------------------------------------------------------------------------
pdr.addEventListener('signal', (e) => chart.push(e.detail.hp));

pdr.addEventListener('heading', (e) => {
  $('rHeadSrc').textContent = e.detail.source;
  const c = e.detail.compass;
  $('rCompass').textContent = c == null ? '–' : `${c.toFixed(0)}°`;
});

pdr.stepHook = (p) => {
  // --- OSM map matching ------------------------------------------------
  if (mm && settings.mmMode !== 'off') {
    const stepL = (p._lastStep && p._lastStep.L) || 0.7;
    const r = mm.step(p.getEN(), p.getHeading(), stepL);
    lastMatch = r;
    if (r.snapped && r.confidence >= settings.mmMinConfidence) {
      p.applyPositionCorrection(r.snapped, settings.mmGainPos);
      if (r.bearing != null) {
        p.applyHeadingCorrection(angleDiff(r.bearing, p.getHeading()), settings.mmGainHeading);
      }
      if (r.alongDelta > 0 && stepL > 0) {
        p.adjustStride(r.alongDelta / stepL, settings.mmGainStride);
      }
      map.setSnapped(enuToLatLng(p.origin, r.snapped.e, r.snapped.n));
      $('rMM').textContent = `${(r.confidence * 100).toFixed(0)}%`;
      $('rRoad').textContent = r.name || '(unnamed)';
    } else {
      $('rMM').textContent = 'searching';
    }
  }

  // --- loop closure -------------------------------------------------
  const en = p.getEN();
  const closure = loop.add(en.e, en.n);
  if (closure) {
    const track = loop.applyClosure(closure.matchIdx, closure.error);
    p.setTrack(track);
    const lls = track.map((t) => enuToLatLng(p.origin, t.e, t.n));
    map.setTrack([p.origin, ...lls]);
    map.flash(lls[lls.length - 1]);
    corrMsg('loop closure applied');
  }

  // --- terrain matching -------------------------------------------
  if (settings.terrainMatch && curRelAlt != null && mm) {
    terrainBuf.push({ s: mm.cumAlong, dz: curRelAlt });
    while (terrainBuf.length > 2 &&
           mm.cumAlong - terrainBuf[0].s > settings.terrainWindowM * 1.5) {
      terrainBuf.shift();
    }
    if (p.steps % settings.terrainEveryNSteps === 0) tryTerrainMatch(p);
  }
};

pdr.addEventListener('pos', (e) => {
  const d = e.detail;
  if (d.step) {
    chart.markStep();
    speedWin.push({ t: performance.now() / 1000, L: d.L });
    while (speedWin.length > 8) speedWin.shift();
  }
  map.update(d.latlng, d.sigma);

  $('rSteps').textContent = d.steps;
  $('rDist').textContent = `${d.dist.toFixed(1)} m`;
  $('rDisp').textContent = `${d.disp.toFixed(1)} m`;
  $('rHeading').textContent = `${d.heading.toFixed(0)}°`;
  $('rBias').textContent = `${d.gyroBias.toFixed(2)} °/s`;
  $('rStride').textContent = d.strideScale.toFixed(2);
  $('rSigma').textContent = `± ${d.sigma.toFixed(0)} m`;
  if (d.cadence) $('rCadence').textContent = `${d.cadence.toFixed(2)} Hz`;
  if (speedWin.length >= 2) {
    const span = speedWin[speedWin.length - 1].t - speedWin[0].t;
    const dist = speedWin.slice(1).reduce((s, x) => s + x.L, 0);
    if (span > 0) $('rSpeed').textContent = `${(dist / span).toFixed(1)} m/s`;
  }

  maybeRefetch(d.latlng);
});

setInterval(() => {
  if (pdr.hasOrigin()) {
    $('rElapsed').textContent = `${(performance.now() / 1000 - pdr.startT).toFixed(0)} s`;
  }
  if (sensorsOn && lastMotionT && performance.now() / 1000 - lastMotionT > 2) {
    setStatus('no sensor data — check permissions / try Chrome or Safari', 'bad');
  }
}, 1000);

function setStatus(text, kind) {
  const el = $('rStatus');
  el.textContent = text;
  el.style.color = kind === 'bad' ? 'var(--bad)'
    : kind === 'good' ? 'var(--good)' : kind === 'warn' ? 'var(--warn)' : '';
}

function currentLL() {
  return pdr.origin ? enuToLatLng(pdr.origin, pdr.e, pdr.n) : null;
}

// ---------------------------------------------------------------------------
// OSM fetch
// ---------------------------------------------------------------------------
async function fetchWays(centerLL) {
  if (!centerLL) return;
  const half = settings.mmFetchRadiusM;
  const dLat = half / 111320;
  const dLng = half / (111320 * Math.cos(centerLL.lat * Math.PI / 180));
  const s = centerLL.lat - dLat, w = centerLL.lng - dLng;
  const n = centerLL.lat + dLat, ee = centerLL.lng + dLng;
  const q = `[out:json][timeout:25];way["highway"](${s},${w},${n},${ee});out geom;`;
  corrMsg('fetching OSM roads…');
  try {
    const r = await fetch(settings.mmOverpassUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!r.ok) { corrMsg(`Overpass error ${r.status}`); return; }
    const j = await r.json();
    buildGraph({ overpass: j.elements || [] });
    graphBBox = { s, w, n, e: ee };
    lastFetchT = Date.now();
    corrMsg(`loaded ${graph.size} road segments`);
  } catch (err) {
    corrMsg(`Overpass fetch failed: ${err.message}`);
  }
}

function buildGraph(src) {
  if (!pdr.origin) return;
  graph = new RoadGraph({ lat: pdr.origin.lat, lng: pdr.origin.lng });
  if (src.overpass) graph.loadOverpass(src.overpass, settings.mmWayTypes);
  if (src.geojson) graph.loadGeoJSON(src.geojson);
  mm = new MapMatcher(graph, settings);
  terrainBuf = [];
  map.drawRoads(graph, pdr.origin);
}

function maybeRefetch(ll) {
  if (settings.mmMode !== 'overpass' || !graphBBox) return;
  const pad = 120 / 111320;
  const padLng = 120 / (111320 * Math.cos(ll.lat * Math.PI / 180));
  const nearEdge = ll.lat < graphBBox.s + pad || ll.lat > graphBBox.n - pad ||
    ll.lng < graphBBox.w + padLng || ll.lng > graphBBox.e - padLng;
  if (nearEdge && Date.now() - lastFetchT > settings.mmRefetchGapS * 1000) {
    lastFetchT = Date.now();
    fetchWays(ll);
  }
}

$('btnLoadWays').addEventListener('click', () => {
  if (!pdr.origin) { corrMsg('seed a start point first'); return; }
  settings.mmMode = 'overpass'; syncCorrForm(); apply();
  fetchWays(currentLL());
});

$('mmFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!pdr.origin) { corrMsg('seed a start point first'); return; }
  try {
    const gj = JSON.parse(await f.text());
    buildGraph({ geojson: gj });
    settings.mmMode = 'file'; syncCorrForm(); apply();
    corrMsg(`loaded ${graph.size} segments from file`);
  } catch (err) {
    corrMsg(`bad GeoJSON: ${err.message}`);
  }
});

$('btnLoadModel').addEventListener('click', async () => {
  try { await model.load(); corrMsg('model loaded'); }
  catch (err) { corrMsg(err.message); }
});

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
async function tryTerrainMatch(p) {
  if (terrainBusy || !mm) return;
  terrainBusy = true;
  try {
    const route = mm.recentRoute(settings.terrainWindowM);
    const shift = await terrain.match(route, terrainBuf.slice());
    if (shift != null && Math.abs(shift) > 2 && lastMatch && lastMatch.bearing != null) {
      p.nudgeAlong(lastMatch.bearing, shift);
      corrMsg(`terrain: ${shift > 0 ? '+' : ''}${shift.toFixed(0)} m along-track`);
    }
  } catch { /* provider offline */ } finally {
    terrainBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Network leash
// ---------------------------------------------------------------------------
function onNetFix(fix) {
  map.setNetFix(fix, fix.acc);
  if (!pdr.origin) return;
  const cur = currentLL();
  const d = haversine(cur, fix);
  if (d > fix.acc) {
    const tgt = destination(cur, bearing(cur, fix), d - fix.acc);
    const en = latLngToEnu(pdr.origin, tgt.lat, tgt.lng);
    pdr.applyPositionCorrection(en, settings.netFixPull);
    corrMsg(`network leash: pulled ${(d - fix.acc).toFixed(0)} m`);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('btnEnable').addEventListener('click', async () => {
  const ok = await sensors.requestPermission();
  if (!ok) { setStatus('sensor permission denied', 'bad'); return; }
  sensors.start();
  sensorsOn = true;
  setStatus('sensors on — seed a start point', 'good');
  $('btnGPS').disabled = false;
  $('btnMapStart').disabled = false;
  $('btnEnable').disabled = true;
});

$('btnGPS').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('no geolocation API', 'bad'); return; }
  setStatus('getting a fix…', 'warn');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      seedOrigin({ lat: p.coords.latitude, lng: p.coords.longitude }, p.coords.accuracy);
      setStatus(`start set (±${p.coords.accuracy.toFixed(0)} m)`, 'good');
    },
    (err) => setStatus(`fix failed: ${err.message}`, 'bad'),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
});

$('btnMapStart').addEventListener('click', () => {
  setStatus('tap the map at your current position', 'warn');
  map.onClickOnce((latlng) => {
    seedOrigin(latlng, null);
    setStatus('start set (manual)', 'good');
  });
});

function seedOrigin(latlng, acc) {
  pdr.setOrigin(latlng, acc);
  map.setOrigin(latlng, acc);
  loop.reset();
  terrainBuf = [];
  graph = null; mm = null; graphBBox = null;
  speedWin.length = 0;
  for (const id of ['btnTrack', 'btnReset', 'btnWaypoint', 'btnReposition',
    'btnCloseLoop', 'btnCalib']) $(id).disabled = false;
  if (settings.mmMode === 'overpass') fetchWays(latlng);
}

$('btnTrack').addEventListener('click', async () => {
  tracking = !tracking;
  pdr.enabled = tracking;
  $('btnTrack').textContent = tracking ? 'Stop tracking' : 'Start tracking';
  $('btnTrack').classList.toggle('active', tracking);
  if (tracking) { setStatus('tracking', 'good'); await acquireWake(); }
  else { setStatus('paused', 'warn'); releaseWake(); }
});

$('btnReset').addEventListener('click', () => {
  const origin = pdr.origin ? { lat: pdr.origin.lat, lng: pdr.origin.lng } : null;
  pdr.reset();
  pdr.enabled = tracking;
  loop.reset();
  terrainBuf = [];
  if (mm) mm.reset();
  if (origin) { pdr.setOrigin(origin, 3); map.setTrack([origin]); map.setOrigin(origin, 3); }
  speedWin.length = 0;
});

$('btnWaypoint').addEventListener('click', () => {
  const ll = currentLL();
  if (ll) map.addWaypoint(ll, `wp ${pdr.steps}`);
});

$('btnReposition').addEventListener('click', () => {
  setStatus('tap the map at your true position', 'warn');
  map.onClickOnce((latlng) => {
    const en = latLngToEnu(pdr.origin, latlng.lat, latlng.lng);
    pdr.e = en.e; pdr.n = en.n; pdr.posSigma = 5;
    map.update(latlng, 5);
    setStatus('repositioned', 'good');
  });
});

$('btnCloseLoop').addEventListener('click', () => {
  if (loop.track.length < 10) { corrMsg('not enough track to close'); return; }
  const en = pdr.getEN();
  const track = loop.applyClosure(0, { e: en.e, n: en.n });
  pdr.setTrack(track);
  const lls = track.map((t) => enuToLatLng(pdr.origin, t.e, t.n));
  map.setTrack([pdr.origin, ...lls]);
  map.flash(pdr.origin);
  corrMsg('closed to start');
});

// ---------------------------------------------------------------------------
// Stride calibration
// ---------------------------------------------------------------------------
let calibResult = null;

$('btnCalib').addEventListener('click', () => {
  $('calib').hidden = !$('calib').hidden;
  $('settings').hidden = true; $('corrections').hidden = true;
});
$('btnCalibClose').addEventListener('click', () => { $('calib').hidden = true; });

$('btnCalibStart').addEventListener('click', () => {
  pdr.enabled = true;
  pdr.startCalib();
  calibResult = null;
  $('cResult').textContent = 'walking… tap Stop at the end line';
  $('btnCalibStart').disabled = true;
  $('btnCalibStop').disabled = false;
  $('btnCalibApply').disabled = true;
});

$('btnCalibStop').addEventListener('click', () => {
  const known = parseFloat($('cKnown').value);
  calibResult = pdr.stopCalib(known);
  $('btnCalibStart').disabled = false;
  $('btnCalibStop').disabled = true;
  pdr.enabled = tracking;
  if (!calibResult) {
    $('cResult').textContent = 'not enough steps detected — try a longer leg';
    return;
  }
  $('cResult').textContent =
    `${calibResult.steps} steps over ${known} m → avg stride ` +
    `${calibResult.avgL.toFixed(2)} m, Weinberg K ${calibResult.weinbergK.toFixed(3)}`;
  $('btnCalibApply').disabled = false;
});

$('btnCalibApply').addEventListener('click', () => {
  if (!calibResult) return;
  settings.weinbergK = +calibResult.weinbergK.toFixed(3);
  settings.constantL = +calibResult.avgL.toFixed(2);
  settingsToForm(); apply();
  $('cResult').textContent = 'applied ✓';
  $('btnCalibApply').disabled = true;
});

// ---------------------------------------------------------------------------
// Wake lock + PWA
// ---------------------------------------------------------------------------
async function acquireWake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
}
function releaseWake() {
  try { wakeLock?.release(); } catch { /* */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (tracking && wakeLock == null && document.visibilityState === 'visible') acquireWake();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* */ });
  });
}
