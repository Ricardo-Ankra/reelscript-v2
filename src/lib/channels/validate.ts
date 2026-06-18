// Pure channel-name validation — no react / server-only / network, so the
// node:test loader can import it directly. Length cap matches the spec.

export const MAX_CHANNEL_NAME = 60;

export type ValidateChannelNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function validateChannelName(name: unknown): ValidateChannelNameResult {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, reason: 'Enter a channel name.' };
  if (trimmed.length > MAX_CHANNEL_NAME) {
    return { ok: false, reason: 'Channel name is too long.' };
  }
  return { ok: true, value: trimmed };
}
