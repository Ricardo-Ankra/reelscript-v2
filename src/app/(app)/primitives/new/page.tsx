import Link from 'next/link';
import { Studio } from '../Studio';

// Author a brand-new primitive (spec 9.4). The studio handles draft → gates → save.
export default function NewPrimitivePage() {
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/primitives" className="text-sm opacity-60 hover:opacity-100">
          ← Library
        </Link>
        <h1 className="text-lg font-semibold">New primitive</h1>
      </div>
      <Studio initial={{ name: '', description: '', code: '', propSchema: [] }} />
    </div>
  );
}
