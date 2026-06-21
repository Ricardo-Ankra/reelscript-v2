import { redirect } from 'next/navigation';

// The dashboard is superseded by Home (/). Keep the route as a redirect so old
// links/bookmarks (and the prior logo target) still resolve.
export default function DashboardPage() {
  redirect('/');
}
