// Simplified wiring: sensors -> PDR (+ magnetometer heading) -> map matching +
// loop closure -> map + readouts. The full engine is intact; the UI just runs it
// with fixed sensible defaults instead of exposing every knob.

import { Sensors } from './sensors.js';
import { PDR } from './pdr.js';
import { TrackMap } from './map.js';
import { RoadGraph } from './roadgraph.js';
import { MapMatcher } from './mapmatch.js';
import { MagCal, tiltHeading } from './magcal.js';
import { DEFAULTS, angleDiff } from './utils.js';
import { enuToLatLng } from './geo.js';

const $ = (id) => document.getElementById(id);
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

// Fixed configuration: good outdoor defaults + online OSM map matching on.
const settings = { ...DEFAULTS, mmMode: 'overpass' };

const sensors = new Sensors();
const pdr = new PDR(settings);
const map = new TrackMap('map');
const magcal = new MagCal();
map.invalidate();

let graph = null;
let mm = null;
let graphBBox = null;
let lastFetchT = 0;
let lastMotionT = 0;
let lastAccel = null;
let sensorsOn = false;
let tracking = false;
let wakeLock = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
}

// ---------------------------------------------------------------------------
// Sensors -> PDR
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
  if (!lastAccel) return;
  if (settings.compassCleanGate &&
      !magcal.fieldClean(e.detail, settings.compassCleanTolUT)) return;
  const h = tiltHeading(magcal.cal(e.detail), lastAccel);
  if (h != null) pdr.feedHeading(h, 0.2 + 0.8 * magcal.quality(), 'mag');
});

// ---------------------------------------------------------------------------
// PDR -> map matching + loop closure (runs on every detected step)
// ---------------------------------------------------------------------------
pdr.stepHook = (p) => {
  if (!mm || settings.mmMode === 'off') return;
  const stepL = (p._lastStep && p._lastStep.L) || 0.7;
  const r = mm.step(p.getEN(), p.getHeading(), stepL);
  if (r.snapped && r.confidence >= settings.mmMinConfidence) {
    p.applyPositionCorrection(r.snapped, settings.mmGainPos);
    if (r.bearing != null) {
      p.applyHeadingCorrection(angleDiff(r.bearing, p.getHeading()), settings.mmGainHeading);
    }
    if (r.alongDelta > 0 && stepL > 0) {
      p.adjustStride(r.alongDelta / stepL, settings.mmGainStride);
    }
    map.setSnapped(enuToLatLng(p.origin, r.snapped.e, r.snapped.n));
  }
};

pdr.addEventListener('pos', (e) => {
  const d = e.detail;
  map.update(d.latlng, d.sigma);
  set('rSteps', d.steps);
  set('rDist', `${d.dist.toFixed(0)} m`);
  set('rHeading', `${d.heading.toFixed(0)}° ${compassPoint(d.heading)}`);
  set('rSigma', `± ${d.sigma.toFixed(0)} m`);
  maybeRefetch(d.latlng);
});

function compassPoint(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// ---------------------------------------------------------------------------
// Idle / sensor-health watchdog
// ---------------------------------------------------------------------------
setInterval(() => {
  if (sensorsOn && lastMotionT && performance.now() / 1000 - lastMotionT > 2) {
    setStatus('no sensor data — check permissions, or try Chrome / Safari', 'bad');
  }
}, 1000);

// ---------------------------------------------------------------------------
// OSM roads (fetched automatically once a start point is set)
// ---------------------------------------------------------------------------
async function fetchWays(centerLL) {
  if (!centerLL) return;
  const half = settings.mmFetchRadiusM;
  const dLat = half / 111320;
  const dLng = half / (111320 * Math.cos(centerLL.lat * Math.PI / 180));
  const s = centerLL.lat - dLat, w = centerLL.lng - dLng;
  const n = centerLL.lat + dLat, ee = centerLL.lng + dLng;
  const q = `[out:json][timeout:25];way["highway"](${s},${w},${n},${ee});out geom;`;
  try {
    const r = await fetch(settings.mmOverpassUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!r.ok) return;
    const j = await r.json();
    buildGraph(j.elements || []);
    graphBBox = { s, w, n, e: ee };
    lastFetchT = Date.now();
  } catch { /* offline — dead reckoning still runs, just unaided */ }
}

function buildGraph(elements) {
  if (!pdr.origin) return;
  graph = new RoadGraph({ lat: pdr.origin.lat, lng: pdr.origin.lng });
  graph.loadOverpass(elements, settings.mmWayTypes);
  mm = new MapMatcher(graph, settings);
  map.drawRoads(graph, pdr.origin);
}

function maybeRefetch(ll) {
  if (!graphBBox) return;
  const pad = 120 / 111320;
  const padLng = 120 / (111320 * Math.cos(ll.lat * Math.PI / 180));
  const nearEdge = ll.lat < graphBBox.s + pad || ll.lat > graphBBox.n - pad ||
    ll.lng < graphBBox.w + padLng || ll.lng > graphBBox.e - padLng;
  if (nearEdge && Date.now() - lastFetchT > settings.mmRefetchGapS * 1000) {
    lastFetchT = Date.now();
    fetchWays(ll);
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
  setStatus('sensors on — set your start point', 'good');
  $('btnStart').disabled = false;
  $('btnEnable').disabled = true;
});

$('btnStart').addEventListener('click', () => {
  if (!navigator.geolocation) { tapToStart(); return; }
  setStatus('getting a GPS fix…', 'warn');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      seedOrigin({ lat: p.coords.latitude, lng: p.coords.longitude }, p.coords.accuracy);
      setStatus(`start set (±${p.coords.accuracy.toFixed(0)} m) — press Start`, 'good');
    },
    () => {
      setStatus('no GPS — tap your location on the map', 'warn');
      tapToStart();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
  );
});

function tapToStart() {
  map.onClickOnce((latlng) => {
    seedOrigin(latlng, null);
    setStatus('start set — press Start', 'good');
  });
}

function seedOrigin(latlng, acc) {
  pdr.setOrigin(latlng, acc);
  map.setOrigin(latlng, acc);
  graph = null; mm = null; graphBBox = null;
  $('btnTrack').disabled = false;
  $('btnReset').disabled = false;
  fetchWays(latlng);
}

$('btnTrack').addEventListener('click', async () => {
  tracking = !tracking;
  pdr.enabled = tracking;
  $('btnTrack').textContent = tracking ? 'Stop' : 'Start';
  $('btnTrack').classList.toggle('active', tracking);
  if (tracking) { setStatus('tracking', 'good'); await acquireWake(); }
  else { setStatus('paused', 'warn'); releaseWake(); }
});

$('btnReset').addEventListener('click', () => {
  const origin = pdr.origin ? { lat: pdr.origin.lat, lng: pdr.origin.lng } : null;
  pdr.reset();
  pdr.enabled = tracking;
  if (mm) mm.reset();
  if (origin) {
    pdr.setOrigin(origin, 3);
    map.setTrack([origin]);
    map.setOrigin(origin, 3);
  }
  set('rSteps', 0);
  set('rDist', '0 m');
  set('rSigma', '–');
});

// ---------------------------------------------------------------------------
// Wake lock + service worker
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
