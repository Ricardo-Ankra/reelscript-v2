'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { countActiveJobs } from './actions';

// Navbar "Jobs" link with a live count of in-flight jobs. Seeded server-side, then
// refreshed on any jobs change over Realtime (RLS scopes the rows).
export function JobsNavBadge({ initialCount }: { initialCount: number }) {
  const supabase = useMemo(() => createClient(), []);
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    const channel = supabase
      .channel('jobs-nav-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        void countActiveJobs().then(setCount);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <Link href="/jobs" className="text-sm opacity-70 hover:opacity-100">
      Jobs
      {count > 0 && (
        <span className="ml-1 rounded-full bg-foreground px-1.5 py-0.5 text-xs text-background">
          {count}
        </span>
      )}
    </Link>
  );
}
