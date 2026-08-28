// Optional coarse absolute fix from the browser's network (cell / Wi-Fi)
// positioning. This is NOT GPS and is far too imprecise to navigate with, but it
// caps gross drift: if the dead-reckoned estimate wanders outside the fix's
// accuracy radius, it is pulled back to the edge. Off by default.

export class NetFix {
  constructor() {
    this.timer = null;
    this.onFix = null;
    this.last = null;
  }

  start(intervalS, onFix) {
    this.stop();
    if (!navigator.geolocation) return false;
    this.onFix = onFix;
    const poll = () => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          this.last = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy,
            t: Date.now(),
          };
          this.onFix && this.onFix(this.last);
        },
        () => { /* ignore a failed poll */ },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 30000 },
      );
    };
    poll();
    this.timer = setInterval(poll, Math.max(15, intervalS) * 1000);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
