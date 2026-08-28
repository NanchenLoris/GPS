// Hook for a learned inertial-odometry model (RoNIN / TLIO / IONet style): a
// small network that maps a window of raw IMU samples to a 2D displacement,
// orientation-agnostic, replacing the Weinberg step-length heuristic.
//
// No runtime or weights are bundled — a trained model is several MB and needs
// onnxruntime-web (or tfjs). This is a stub with the integration surface in
// place. See README "Learned inertial model" for how to wire one in.

export class InertialModel {
  constructor() {
    this.ready = false;
    this.session = null;
    this.winSamples = 200;   // ~1 s at 200 Hz, model-dependent
  }

  async load(/* url */) {
    throw new Error(
      'No inference runtime bundled. Add onnxruntime-web from cdnjs and a ' +
      'RoNIN/TLIO ONNX model, then implement load()/infer() here.');
  }

  // imuWindow: Float32Array [ax,ay,az,gx,gy,gz] * winSamples (device frame).
  // Should return { dx, dy } world-frame displacement in metres, or null.
  infer(/* imuWindow */) {
    return null;
  }
}
