import { createClient } from '@/lib/supabase/server';
import { parseModelRouting } from '@/lib/ai/model-routing';
import { ModelRoutingEditor } from './ModelRoutingEditor';

// Account settings (Phase 8). First section: model routing. RLS scopes the read to
// the caller's own account.
export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('model_routing').maybeSingle();
  const initial = parseModelRouting(account?.model_routing);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="text-sm opacity-70">Defaults that apply across your channels.</p>
      </div>
      <ModelRoutingEditor initial={initial} />
    </div>
  );
}
