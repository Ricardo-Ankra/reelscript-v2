// Structured cinematography + provenance authored/derived per shot (V2 Slice 0).
// Stored snake_case on shots.{camera_spec,lighting_spec,provenance}; this module is
// the single source of the stored shapes for the editor, the router (Slice 1), and
// assembly (Slice 3). Never-throw normalizers mirror parseVisualBrief.

export type ShotKind = 'generative' | 'motion_graphic' | 'live_action';
export const SHOT_KINDS: readonly ShotKind[] = ['generative', 'motion_graphic', 'live_action'];

export type ShotSize = 'ECU' | 'CU' | 'MS' | 'WS' | 'EWS' | 'two_shot' | 'OTS' | 'POV';
export type CameraAngle = 'eye_level' | 'low' | 'high' | 'dutch' | 'aerial' | 'overhead';
export type CameraMove =
  | 'static' | 'dolly_in' | 'dolly_out' | 'arc_left' | 'arc_right' | 'orbit_360'
  | 'crane_up' | 'crane_down' | 'tracking' | 'pan_left' | 'pan_right' | 'tilt_up'
  | 'tilt_down' | 'whip_pan' | 'push_in' | 'pull_back' | 'handheld' | 'bullet_time'
  | 'boom' | 'snorricam' | 'fpv_drone';
export type Dof = 'shallow' | 'deep' | 'rack_focus';

export const SHOT_SIZES: readonly ShotSize[] = ['ECU', 'CU', 'MS', 'WS', 'EWS', 'two_shot', 'OTS', 'POV'];
export const CAMERA_ANGLES: readonly CameraAngle[] = ['eye_level', 'low', 'high', 'dutch', 'aerial', 'overhead'];
export const CAMERA_MOVES: readonly CameraMove[] = [
  'static', 'dolly_in', 'dolly_out', 'arc_left', 'arc_right', 'orbit_360',
  'crane_up', 'crane_down', 'tracking', 'pan_left', 'pan_right', 'tilt_up',
  'tilt_down', 'whip_pan', 'push_in', 'pull_back', 'handheld', 'bullet_time',
  'boom', 'snorricam', 'fpv_drone',
];
export const DOFS: readonly Dof[] = ['shallow', 'deep', 'rack_focus'];

export interface CameraSpec {
  shot_size: ShotSize;
  angle: CameraAngle;
  move: CameraMove;       // ONE primary move — single value, never an array
  lens_mm: number;
  dof: Dof;
  motion_strength: number;
}

export interface LightingSpec {
  key: string;
  ratio: string;
  time_of_day: string;
  palette: string;
  texture: string;
}

export interface Provenance {
  synthetic: boolean;
  source: string | null;     // 'higgsfield:dop-preview' | 'remotion' | 'stock:pexels' | 'shot:on-site' | null (stub)
  model: string | null;
  seed: number | null;
  source_uri: string | null;
  created_at: string | null;
  operator: string | null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function parseCameraSpec(value: unknown): CameraSpec | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const lensRaw = typeof o.lens_mm === 'number' && Number.isFinite(o.lens_mm) ? (o.lens_mm as number) : 35;
  const msRaw = typeof o.motion_strength === 'number' && Number.isFinite(o.motion_strength) ? (o.motion_strength as number) : 0.7;
  return {
    shot_size: SHOT_SIZES.includes(o.shot_size as ShotSize) ? (o.shot_size as ShotSize) : 'MS',
    angle: CAMERA_ANGLES.includes(o.angle as CameraAngle) ? (o.angle as CameraAngle) : 'eye_level',
    move: CAMERA_MOVES.includes(o.move as CameraMove) ? (o.move as CameraMove) : 'static',
    lens_mm: Math.round(lensRaw),
    dof: DOFS.includes(o.dof as Dof) ? (o.dof as Dof) : 'shallow',
    motion_strength: clamp01(msRaw),
  };
}

export function parseLightingSpec(value: unknown): LightingSpec | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const str = (k: string, dflt: string): string =>
    typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : dflt;
  return {
    key: str('key', 'soft key from frame left'),
    ratio: str('ratio', '3:1'),
    time_of_day: str('time_of_day', 'golden hour'),
    palette: str('palette', 'teal shadows, warm highlights'),
    texture: str('texture', 'subtle film grain'),
  };
}

export function parseProvenance(value: unknown): Provenance | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const sOrNull = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    synthetic: o.synthetic === true,
    source: sOrNull('source'),
    model: sOrNull('model'),
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? (o.seed as number) : null,
    source_uri: sOrNull('source_uri'),
    created_at: sOrNull('created_at'),
    operator: sOrNull('operator'),
  };
}
