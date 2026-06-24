import type { CameraMove, CameraSpec } from '../videos/cinematography';

// Map each camera move to a Higgsfield motion_id. PLACEHOLDER ids — replace with the
// live Higgsfield motion_id UUID set before go-live (v3 §12). The fake provider does
// not care about the value; only that one exists per move.
export const MOTION_ID: Record<CameraMove, string> = {
  static: 'placeholder-static',
  dolly_in: 'placeholder-dolly_in',
  dolly_out: 'placeholder-dolly_out',
  arc_left: 'placeholder-arc_left',
  arc_right: 'placeholder-arc_right',
  orbit_360: 'placeholder-orbit_360',
  crane_up: 'placeholder-crane_up',
  crane_down: 'placeholder-crane_down',
  tracking: 'placeholder-tracking',
  pan_left: 'placeholder-pan_left',
  pan_right: 'placeholder-pan_right',
  tilt_up: 'placeholder-tilt_up',
  tilt_down: 'placeholder-tilt_down',
  whip_pan: 'placeholder-whip_pan',
  push_in: 'placeholder-push_in',
  pull_back: 'placeholder-pull_back',
  handheld: 'placeholder-handheld',
  bullet_time: 'placeholder-bullet_time',
  boom: 'placeholder-boom',
  snorricam: 'placeholder-snorricam',
  fpv_drone: 'placeholder-fpv_drone',
};

export function resolveMotion(camera: CameraSpec): { motionId: string; motionStrength: number } {
  return { motionId: MOTION_ID[camera.move], motionStrength: camera.motion_strength };
}
