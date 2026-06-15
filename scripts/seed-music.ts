// Seed a channel's music library (Phase 6, spec 4.2.3 / 4.3). Generates one
// instrumental bed per mood tag via the ElevenLabs Music API, uploads it to R2, and
// inserts a music_tracks row. Idempotent: moods already seeded for the channel are
// skipped, so re-running tops up missing moods without duplicating.
//
// Run: npm run seed:music [channelId]   (needs ELEVENLABS_API_KEY + R2 + Supabase env)
// With no channelId it seeds the first channel in the account.
import { createAdminClient } from '../src/lib/supabase/admin';
import { putObject } from '../src/lib/r2';
import { composeMusic } from '../src/lib/music/elevenlabs-music';
import { MOOD_TAGS, MOOD_PROMPTS } from '../src/lib/music/moods';

const LENGTH_MS = 30_000; // 30s beds; the re-mux loops them to the video length.
const OUTPUT_FORMAT = 'mp3_44100_128';

async function main(): Promise<void> {
  const admin = createAdminClient();
  const channelId = process.argv[2];

  const { data: channel, error } = channelId
    ? await admin.from('channels').select('id, account_id, name').eq('id', channelId).single()
    : await admin.from('channels').select('id, account_id, name').order('created_at').limit(1).single();
  if (error || !channel) throw new Error(`load channel: ${error?.message ?? 'no channel found'}`);
  console.log(`Seeding music for channel "${channel.name}" (${channel.id})`);

  // Skip moods already seeded (idempotent top-up).
  const { data: existing } = await admin.from('music_tracks').select('mood_tags').eq('channel_id', channel.id);
  const haveMoods = new Set<string>();
  for (const row of existing ?? []) for (const t of (row.mood_tags as string[]) ?? []) haveMoods.add(t);

  for (const mood of MOOD_TAGS) {
    if (haveMoods.has(mood)) {
      console.log(`  ${mood}: already seeded, skipping`);
      continue;
    }
    process.stdout.write(`  ${mood}: generating…`);
    const audio = await composeMusic({ prompt: MOOD_PROMPTS[mood], lengthMs: LENGTH_MS, outputFormat: OUTPUT_FORMAT });
    const r2Key = `music/${channel.id}/${mood}.mp3`;
    await putObject(r2Key, audio, 'audio/mpeg');
    const { error: insErr } = await admin.from('music_tracks').insert({
      account_id: channel.account_id,
      channel_id: channel.id,
      source: 'elevenlabs',
      r2_key: r2Key,
      title: `Seeded — ${mood}`,
      mood_tags: [mood],
      duration_seconds: LENGTH_MS / 1000,
      attribution: 'Generated with ElevenLabs Music',
    });
    if (insErr) throw new Error(`insert ${mood}: ${insErr.message}`);
    console.log(` ${(audio.length / 1024).toFixed(0)}KB → ${r2Key}`);
  }

  console.log('\n✅ Music library seeded. Toggle music on for a video to use it.');
}

main().catch((e) => {
  console.error('\nseed-music failed:', e);
  process.exit(1);
});
