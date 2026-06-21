// App-layer secret encryption (Phase 8). AES-256-GCM via node:crypto. PURE: the key
// is injected as a 64-hex-char string (32 bytes) so this is unit-testable with a
// fixed key and never reads env. Payload format: "iv.ciphertext.tag" (each base64).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

function keyBuffer(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32) {
    throw new Error('Encryption key must be 64 hex characters (32 bytes).');
  }
  return buf;
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyBuffer(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join('.');
}

export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted payload.');
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Malformed encrypted payload (iv).');
  const decipher = createDecipheriv(ALGO, keyBuffer(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
