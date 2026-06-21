import { createClient } from '@/lib/supabase/server';
import { parseModelRouting } from '@/lib/ai/model-routing';
import { ModelRoutingEditor } from './ModelRoutingEditor';
import { VoiceProfilesEditor, type ProfileBlock } from './VoiceProfilesEditor';
import type { TagMappings } from '@/lib/voice/profile';

// Account settings (Phase 8). Model routing + voice profiles. RLS scopes both reads
// to the caller's own account.
export default async function SettingsPage() {
  const supabase = await createClient();

  const { data: account } = await supabase.from('accounts').select('model_routing').maybeSingle();
  const initialRouting = parseModelRouting(account?.model_routing);

  const { data: profiles } = await supabase
    .from('voice_profiles')
    .select('elevenlabs_model_id, model_name, tag_mappings');
  const initialProfiles: ProfileBlock[] = (profiles ?? []).map((p) => ({
    modelId: p.elevenlabs_model_id as string,
    modelName: p.model_name as string,
    mapping: (p.tag_mappings as TagMappings) ?? {},
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="text-sm opacity-70">Defaults that apply across your channels.</p>
      </div>
      <ModelRoutingEditor initial={initialRouting} />
      <VoiceProfilesEditor initial={initialProfiles} />
    </div>
  );
}
