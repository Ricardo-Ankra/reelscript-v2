import Link from 'next/link';

// Presentational Videos|Settings tab strip. Server <Link>s drive the ?tab= query so
// the initial paint needs no client router. 'videos' is the default (no query).
export function ChannelTabs({
  channelId,
  active,
}: {
  channelId: string;
  active: 'videos' | 'settings';
}) {
  const base = `/channels/${channelId}`;
  const cls = (on: boolean) =>
    on
      ? 'border-b-2 border-foreground pb-2 text-sm font-medium'
      : 'border-b-2 border-transparent pb-2 text-sm opacity-60 hover:opacity-100';
  return (
    <div className="flex gap-6 border-b border-black/10 dark:border-white/10">
      <Link href={base} className={cls(active === 'videos')}>
        Videos
      </Link>
      <Link href={`${base}?tab=settings`} className={cls(active === 'settings')}>
        Settings
      </Link>
    </div>
  );
}
