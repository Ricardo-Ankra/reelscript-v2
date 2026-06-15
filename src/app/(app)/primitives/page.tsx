import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

// Primitive library list view (spec 9.1). Account-scoped under RLS. The starter set is
// always available to the composition AI; this lists the account's authored primitives.
export default async function PrimitivesPage() {
  const supabase = await createClient();
  const { data: prims } = await supabase
    .from('primitives')
    .select('id, name, description, version, status, deployed_version')
    .order('updated_at', { ascending: false });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Primitive library</h1>
        <Link
          href="/primitives/new"
          className="rounded-md border border-black/15 px-2.5 py-1 text-sm font-medium hover:bg-black/[0.04] dark:border-white/20 dark:hover:bg-white/[0.06]"
        >
          New primitive
        </Link>
      </div>

      {!prims || prims.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-8 text-center text-sm opacity-60 dark:border-white/15">
          No authored primitives yet. The starter set is always available; author your own with “New primitive”.
        </p>
      ) : (
        <ul className="space-y-2">
          {prims.map((p) => {
            const deployed = p.deployed_version != null && p.deployed_version === p.version;
            return (
              <li key={p.id as string}>
                <Link
                  href={`/primitives/${p.id}`}
                  className="block rounded-lg border border-black/10 p-3 hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.03]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.name as string}</span>
                    <span className="text-xs opacity-60">
                      v{p.version as number} · {p.status as string} · {deployed ? 'deployed' : 'not deployed'}
                    </span>
                  </div>
                  <p className="text-sm opacity-70">{(p.description as string) || '—'}</p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
