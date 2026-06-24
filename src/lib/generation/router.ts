import type { CameraMove, CameraSpec, ShotKind } from '../videos/cinematography';

export type Engine = 'remotion' | 'ingest' | `higgsfield.${string}`;

// Moves where the camera motion IS the hero → Higgsfield's first-party dop model.
const HERO_MOVES: readonly CameraMove[] = ['orbit_360', 'bullet_time', 'arc_left', 'arc_right', 'snorricam', 'whip_pan', 'fpv_drone'];

export interface RoutableShot {
  kind: ShotKind;
  camera: CameraSpec | null;
  hero: boolean;
  needs_speech: boolean;
  broadcast_4k: boolean;
}

// Pick the engine per shot (v3 §4). motion_graphic → Remotion; live_action → ingest;
// generative → a Higgsfield model by move/flags. (Fallback chains are a 1b runtime concern.)
export function route(shot: RoutableShot): Engine {
  if (shot.kind === 'motion_graphic') return 'remotion';
  if (shot.kind === 'live_action') return 'ingest';
  if (shot.camera && HERO_MOVES.includes(shot.camera.move)) return 'higgsfield.dop-preview';
  if (shot.needs_speech) return 'higgsfield.veo-3.1';
  if (shot.broadcast_4k) return 'higgsfield.kling-3.0';
  if (shot.hero) return 'higgsfield.seedance-2.0';
  return 'higgsfield.dop-preview';
}
