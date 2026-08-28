// Leaflet wrapper: origin, walked polyline, current dot + uncertainty circle,
// the loaded road network, the snapped position, waypoints, and the coarse
// network-fix circle. `L` is the global from the Leaflet CDN script.

export class TrackMap {
  constructor(elId) {
    this.map = L.map(elId, { zoomControl: true, tap: true }).setView([46.8, 8.23], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(this.map);

    this.pts = [];
    this.roads = L.layerGroup().addTo(this.map);
    this.track = L.polyline([], { color: '#39a0ff', weight: 3 }).addTo(this.map);
    this.unc = L.circle([0, 0], {
      radius: 0, color: '#39a0ff', weight: 1, opacity: 0.4, fillOpacity: 0.08,
    });
    this.netCircle = L.circle([0, 0], {
      radius: 0, color: '#ffcf5c', weight: 1, opacity: 0.5, fillOpacity: 0.05,
    });
    this.originM = L.circleMarker([0, 0], {
      radius: 5, color: '#fff', weight: 2, fillColor: '#35d07f', fillOpacity: 1,
    });
    this.snapM = L.circleMarker([0, 0], {
      radius: 4, color: '#35d07f', weight: 2, fillColor: 'transparent',
    });
    this.cur = L.circleMarker([0, 0], {
      radius: 6, color: '#fff', weight: 2, fillColor: '#39a0ff', fillOpacity: 1,
    });
    this.waypoints = L.layerGroup().addTo(this.map);
  }

  setOrigin(latlng, gpsAcc) {
    const p = [latlng.lat, latlng.lng];
    this.pts = [p];
    this.track.setLatLngs(this.pts);
    this.originM.setLatLng(p).addTo(this.map);
    this.cur.setLatLng(p).addTo(this.map);
    this.unc.setLatLng(p).setRadius(gpsAcc || 3).addTo(this.map);
    this.map.setView(p, 18);
  }

  update(latlng, sigma) {
    const p = [latlng.lat, latlng.lng];
    this.pts.push(p);
    this.track.setLatLngs(this.pts);
    this.cur.setLatLng(p);
    this.unc.setLatLng(p).setRadius(sigma || 0);
    if (!this.map.getBounds().pad(-0.25).contains(p)) this.map.panTo(p, { animate: true });
  }

  // Replace the whole polyline (after a loop-closure redistribution).
  setTrack(latlngs) {
    this.pts = latlngs.map((ll) => [ll.lat, ll.lng]);
    this.track.setLatLngs(this.pts);
    if (this.pts.length) this.cur.setLatLng(this.pts[this.pts.length - 1]);
  }

  setSnapped(latlng) {
    if (!latlng) { this.map.removeLayer(this.snapM); return; }
    this.snapM.setLatLng([latlng.lat, latlng.lng]).addTo(this.map);
  }

  setNetFix(latlng, acc) {
    this.netCircle.setLatLng([latlng.lat, latlng.lng]).setRadius(acc || 0).addTo(this.map);
  }

  addWaypoint(latlng, label) {
    L.circleMarker([latlng.lat, latlng.lng], {
      radius: 5, color: '#ffcf5c', weight: 2, fillColor: '#ffcf5c', fillOpacity: 0.9,
    }).bindTooltip(label || 'waypoint').addTo(this.waypoints);
  }

  // Draw the loaded road graph (edges as light lines) for context.
  drawRoads(graph, originLatLng) {
    this.roads.clearLayers();
    const toLL = (nd) => {
      const R = 6378137, D2R = Math.PI / 180, R2D = 180 / Math.PI;
      return [
        originLatLng.lat + (nd.n / R) * R2D,
        originLatLng.lng + (nd.e / (R * Math.cos(originLatLng.lat * D2R))) * R2D,
      ];
    };
    for (const ed of graph.edges) {
      L.polyline([toLL(graph.nodes[ed.a]), toLL(graph.nodes[ed.b])], {
        color: '#5c6b7a', weight: 1, opacity: 0.55, interactive: false,
      }).addTo(this.roads);
    }
  }

  flash(latlng) {
    const c = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 4, color: '#35d07f', weight: 3, fillOpacity: 0,
    }).addTo(this.map);
    let r = 4;
    const iv = setInterval(() => {
      r += 6;
      c.setRadius(r).setStyle({ opacity: Math.max(0, 1 - r / 60) });
      if (r > 60) { clearInterval(iv); this.map.removeLayer(c); }
    }, 40);
  }

  onClickOnce(cb) { this.map.once('click', (e) => cb(e.latlng)); }
  invalidate() { setTimeout(() => this.map.invalidateSize(), 100); }
}
