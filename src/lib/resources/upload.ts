import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signedPutUrl, signedGetUrl } from '../r2';
import { anthropic, COMPOSITION_MODEL } from '../ai/anthropic';
import { buildResourceTagPrompt, parseResourceTag } from '../ai/vision';

// Channel-resource upload (spec 4.3 / 13.5), server capability. Two steps so bytes go
// client → R2 directly (the frontend never proxies large files): createResourceUpload
// reserves a row + signed PUT URL; the client PUTs; confirmResourceUpload hashes the
// bytes for dedupe and runs one fast Claude-vision call to fill description + tags.
// The Phase-8 resource-library UI wraps these; for now a script/server caller drives
// them. The caller supplies an authed Supabase client (RLS) + the resolved account.

export type UploadableResourceKind = 'image' | 'video';

const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

// Anthropic image blocks accept a fixed set of media types; map our stored ext to one.
type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
function visionMediaType(r2Key: string): VisionMediaType {
  if (r2Key.endsWith('.png')) return 'image/png';
  if (r2Key.endsWith('.webp')) return 'image/webp';
  if (r2Key.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// Reserve a channel_resources row + a signed PUT URL the client uploads the bytes to.
// description/tags/content_hash are filled by confirmResourceUpload after the upload.
export async function createResourceUpload(
  client: SupabaseClient,
  accountId: string,
  channelId: string,
  input: { filename: string; contentType: string; kind: UploadableResourceKind },
): Promise<{ resourceId: string; r2Key: string; uploadUrl: string }> {
  const ext = EXT_FOR_TYPE[input.contentType] ?? (input.kind === 'video' ? 'mp4' : 'jpg');
  const r2Key = `resources/${accountId}/${randomUUID()}.${ext}`;

  const { data, error } = await client
    .from('channel_resources')
    .insert({
      account_id: accountId,
      channel_id: channelId,
      kind: input.kind,
      r2_key: r2Key,
      original_filename: input.filename,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`create resource row: ${error?.message ?? 'no row'}`);

  const uploadUrl = await signedPutUrl(r2Key, input.contentType);
  return { resourceId: data.id as string, r2Key, uploadUrl };
}

// After the client has PUT the bytes: hash for dedupe and, for images, run one fast
// vision call to auto-describe + tag. Non-image kinds keep the filename as description
// (no vision over video/audio here). Returns the resolved { description, tags }.
export async function confirmResourceUpload(
  client: SupabaseClient,
  accountId: string,
  resourceId: string,
): Promise<{ description: string; tags: string[] }> {
  const { data: row, error } = await client
    .from('channel_resources')
    .select('r2_key, kind, original_filename')
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .single();
  if (error || !row) throw new Error(`load resource ${resourceId}: ${error?.message ?? 'not found'}`);

  const r2Key = row.r2_key as string;
  const url = await signedGetUrl(r2Key, 300);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch resource bytes: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  let description = (row.original_filename as string) ?? '';
  let tags: string[] = [];

  if (row.kind === 'image') {
    const msg = await anthropic().messages.create({
      model: COMPOSITION_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: visionMediaType(r2Key), data: bytes.toString('base64') } },
            { type: 'text', text: buildResourceTagPrompt() },
          ],
        },
      ],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const tag = parseResourceTag(text);
    if (tag) {
      description = tag.description;
      tags = tag.tags;
    }
  }

  await client
    .from('channel_resources')
    .update({ description, tags, content_hash: contentHash })
    .eq('id', resourceId)
    .eq('account_id', accountId);

  return { description, tags };
}
