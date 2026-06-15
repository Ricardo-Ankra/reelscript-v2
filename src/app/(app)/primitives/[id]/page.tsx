import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Studio } from '../Studio';
import type { PropSchema } from '@/lib/primitives/contract';

// Edit an existing primitive (spec 9.8: edit in place; the prop-schema lifecycle keeps
// old specs valid). RLS scopes the load to the signed-in account.
export default async function EditPrimitivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: p } = await supabase
    .from('primitives')
    .select('id, name, description, code, prop_schema')
    .eq('id', id)
    .maybeSingle();
  if (!p) notFound();

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/primitives" className="text-sm opacity-60 hover:opacity-100">
          ← Library
        </Link>
        <h1 className="text-lg font-semibold">Edit: {p.name as string}</h1>
      </div>
      <Studio
        initial={{
          id: p.id as string,
          name: p.name as string,
          description: (p.description as string) ?? '',
          code: p.code as string,
          propSchema: (p.prop_schema as PropSchema) ?? [],
        }}
      />
    </div>
  );
}
