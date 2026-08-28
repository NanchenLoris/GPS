# Dead Reckoning

A browser app that estimates your position outdoors from the phone's IMU after a
single start fix — no continuous GPS.

It is **pedestrian dead reckoning**: it counts steps and advances the estimate
one stride at a time along a fused heading. It does *not* double-integrate
acceleration (that diverges in seconds on phone MEMS). On top of the dead
reckoning it runs several **drift corrections** that need no GPS.

## The honest limit

Dead reckoning error grows without bound. A single seed fix plus perfect heading
still leaves a stride-scale error of a few percent: 1 km → ~30 m, 10 km →
~300 m, 100 km → kilometres. To stay precise you need something to *match*
against. There is no phone-sensor-only absolute fix in a featureless field.

What actually bounds the error here:

| Correction | What it needs | Effect |
|---|---|---|
| Calibrated tilt-compensated **magnetometer** heading | raw Magnetometer sensor (Chrome/Android) | absolute heading ±1–3°; turns cubic heading-drift error into linear stride error |
| **Gyro-bias ZUPT** | nothing | removes most gyro drift by reading the bias while you stand still |
| **Heuristic Drift Elimination** | nothing | snaps heading to dominant travel directions while walking straight; caps heading drift |
| **OSM map matching** (HMM) | internet for OSM data (Overpass), or a loaded GeoJSON | snaps to the path network — the big one when you're on roads/trails; corrects position, heading and stride scale |
| **Barometer + DEM terrain matching** | Barometer sensor + internet for elevation data | resolves along-track position from the climb/descent profile in hilly terrain |
| **Loop closure** | nothing | redistributes accumulated error when your track revisits a point |
| **Waypoint reset** | you tap a known point | hard position reset |
| **Coarse network leash** (off by default; *not* GPS) | cell/Wi-Fi positioning | caps gross drift to tens–hundreds of metres |

Realistic outcome: on mapped paths, tens of metres held over a multi-km route.
Off-trail with only IMU + compass, it slowly diverges.

## Platform support

Web sensor APIs are uneven:

- **Android / Chrome**: accelerometer, gyroscope, OS compass, **raw magnetometer**
  and **barometer** all available (magnetometer/barometer need a secure context
  and may prompt for permission). Full feature set.
- **iOS / Safari**: accelerometer, gyroscope and the fused `webkitCompassHeading`
  work (after the permission prompt). No raw magnetometer, no barometer — so
  no custom mag calibration and no terrain matching; heading falls back to the
  OS compass.

## Run it

Sensors require a secure context, so `http://<lan-ip>` will not work. Pick one:

- **Local HTTPS**: `python serve.py` → open the printed `https://<lan-ip>:8443/`
  on the phone, accept the certificate warning once. Needs `pip install
  cryptography` or `openssl` on PATH (falls back to plain HTTP otherwise).
- **Tunnel**: `cloudflared tunnel --url http://localhost:8443` and open the https
  URL it prints.
- **Static host**: push the folder to GitHub Pages / Netlify.

Then on the phone:

1. **Enable sensors** (iOS shows a prompt).
2. **Seed start · GPS** outdoors, or **Seed start · tap map**.
3. **Calibrate stride** once — enter a known distance, walk it straight, Stop,
   Apply. Biggest single accuracy win.
4. Open **Corrections** and turn on what applies:
   - `OSM map matching` → `online (Overpass)` if you'll be on paths and have a
     connection, then **Fetch OSM roads now** (or load a `.geojson` of ways).
   - `Barometer + DEM terrain matching` in hilly terrain (Android only).
   - Leave HDE and gyro-bias ZUPT on (defaults).
5. **Start tracking** and walk. The blue trace is the estimate; the green ring is
   the snapped map-match; the shaded circle is the growing uncertainty.

To calibrate the magnetometer (Android): wave the phone in a figure-8 a few times
after enabling sensors — watch `mag cal` climb toward 100%.

## Tuning

The strip chart shows dynamic acceleration (blue), the peak thresholds
(green/orange) and detected steps (yellow). Aim for one yellow bar per footfall;
raise thresholds if over-counting, lower them if missing steps. Heading assumes
the phone is held roughly flat, top edge pointing where you walk — set a
**heading offset** if you carry it rotated.

The correction gains (`MM position/heading/stride gain`, `HDE snap gain`,
`terrain gain`) are deliberately small. Raising them corrects faster but can make
the track twitchy or let a wrong map-match hypothesis capture you.

## Layout

```
index.html          UI shell, loads Leaflet from CDN
js/sensors.js        browser sensor APIs -> normalised event streams
js/magcal.js         hard/soft-iron calibration + tilt-compensated compass
js/ahrs.js           heading fusion, gyro-bias, ZUPT, HDE
js/pdr.js            step detection, stride model, position; correction hooks
js/roadgraph.js      OSM ways -> routable graph + spatial index + bounded Dijkstra
js/mapmatch.js       online HMM (Viterbi) map matching
js/terrain.js        barometer altitude + DEM elevation-profile matching
js/loop.js           loop-closure detection + error redistribution
js/netfix.js         optional coarse network-location leash
js/model.js          learned inertial-odometry hook (stub — see below)
js/chart.js          tuning strip chart
js/map.js            Leaflet track, roads, snapped point, waypoints
js/geo.js            WGS84 <-> ENU + spherical helpers
js/utils.js          helpers, sliding window, settings persistence
js/app.js            wiring
serve.py             local HTTPS dev server
sw.js                offline app-shell cache
```

## Learned inertial model (optional, not bundled)

`js/model.js` is a hook for a RoNIN / TLIO / IONet-style network that maps a
window of raw IMU samples to a 2D displacement — orientation-agnostic, ~2–3% of
distance, and it removes the carry-mode problem (pocket/bag). Wiring one in
needs `onnxruntime-web` (from cdnjs) plus a trained ONNX model (several MB);
implement `load()` / `infer()` and call it from `pdr._onStep` in place of the
Weinberg length. Left as a stub because the weights can't ship here.
