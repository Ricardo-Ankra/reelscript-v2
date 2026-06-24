import type { CameraSpec, LightingSpec } from '../videos/cinematography';
import type { VisualBrief } from '../videos/visual-brief';

const NEGATIVE = 'no text, no logo, no warped anatomy, no smeared motion blur';

// Build the Higgsfield image-to-video prompt (v3 §6): front-load shot size, lock the
// subject with the brief, describe one camera move, end with the explicit negative.
export function buildClipPrompt(
  brief: VisualBrief,
  camera: CameraSpec,
  lighting: LightingSpec,
): string {
  return [
    `${camera.shot_size} ${camera.angle} angle, ${camera.lens_mm}mm lens, ${camera.dof} depth of field.`,
    `${brief.subject}. ${brief.action}. ${brief.setting}.`,
    `${lighting.key}, ${lighting.ratio} key-to-fill, ${lighting.time_of_day}, ${lighting.palette}, ${lighting.texture}.`,
    `Camera: ${camera.move.replace(/_/g, ' ')}, smooth and deliberate.`,
    `Negative: ${NEGATIVE}.`,
  ].join(' ');
}
