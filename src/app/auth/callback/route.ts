import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Handles the code-exchange redirect from Supabase Auth (email confirmation,
// magic links, OAuth). Exchanges the one-time code for a session, then forwards
// to the app.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent('Could not sign you in.')}`,
  );
}
