'use server';

import { createClient } from '@/lib/supabase/server';
import { signedGetUrl } from '@/lib/r2';
import { parseVisualBrief } from '@/lib/videos/visual-brief';
import { storyboardLabel } from '@/lib/videos/storyboard';

export interface StoryboardFrame {
  shotId: string;
  label: string;
  keyframeUrl: string;
}

// Load the generative shots' keyframe stills for the G1 storyboard review (V2 Slice 6a).
// Called once by the editor when the pipeline job pauses at the storyboard gate. RLS-scoped.
export async function loadStoryboard(videoId: string): Promise<StoryboardFrame[]> {
  const supabase = await createClient();
  const { data: scenes } = await supabase.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  if (sceneIds.length === 0) return [];

  const { data: shots } = await supabase
    .from('shots')
    .select('id, description, visual_brief, keyframe_first_key')
    .in('scene_id', sceneIds)
    .eq('kind', 'generative')
    .not('keyframe_first_key', 'is', null)
    .order('position');

  const frames: StoryboardFrame[] = [];
  for (const sh of shots ?? []) {
    const url = await signedGetUrl(sh.keyframe_first_key as string, 60 * 60);
    const brief = parseVisualBrief(sh.visual_brief);
    frames.push({
      shotId: sh.id as string,
      label: storyboardLabel(brief, (sh.description as string) ?? ''),
      keyframeUrl: url,
    });
  }
  return frames;
}
