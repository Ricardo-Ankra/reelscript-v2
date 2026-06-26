import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except static assets and image files. Also exclude
    // /api/inngest: the Inngest serve route authenticates itself via the signing
    // key and must be publicly reachable for Inngest Cloud to sync + invoke it —
    // the Supabase session middleware would otherwise redirect those (cookie-less)
    // requests to /login. (Cloud-mode deploy fix; harmless locally.)
    '/((?!_next/static|_next/image|favicon.ico|api/inngest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
