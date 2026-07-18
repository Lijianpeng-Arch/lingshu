/**
 * AES-256-GCM symmetric encryption for at-rest secrets (e.g. Provider apiKey).
 *
 * Key source: process.env.LINGSHU_MASTER_KEY (base64-encoded 32 bytes).
 *   - When present, we decode it directly.
 *   - When absent, we derive a 32-byte key from SHA-256(os.userInfo().username + os.hostname()).
 *     This is NOT real security for multi-user / hostile-OS scenarios, but it raises
 *     the bar above plaintext for a single-user desktop install. Callers can upgrade
 *     to a real LINGSHU_MASTER_KEY without code changes.
 *
 * Format: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 *   - "enc:v1:" prefix lets us detect already-encrypted blobs and migrate later.
 *   - GCM auth tag is stored separately (Node convention).
 *
 * No external deps — uses Node built-in `node:crypto`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import os from 'node:os';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LEN = 12; // GCM standard

function loadKey(): Buffer {
  const env = process.env['LINGSHU_MASTER_KEY'];
  if (env && env.length > 0) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `LINGSHU_MASTER_KEY must be 32 bytes (base64-encoded); got ${buf.length} bytes`,
      );
    }
    return buf;
  }
  // Fallback: deterministic per-machine, per-OS-user key. Better than plaintext,
  // not real cryptography. Re-encrypting with LINGSHU_MASTER_KEY later is enough
  // to upgrade — the prefix lets the repo detect old vs new ciphertexts.
  const seed = `${os.userInfo().username}@${os.hostname()}`;
  return createHash('sha256').update(seed, 'utf8').digest();
}

/** Encrypt a UTF-8 plaintext into a self-describing envelope string. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypt an envelope produced by `encryptSecret`. Throws on tampered data,
 * wrong key, or malformed input.
 */
export function decryptSecret(payload: string): string {
  if (!payload.startsWith(PREFIX)) {
    throw new Error('ciphertext missing enc:v1: prefix — refusing to decrypt');
  }
  const body = payload.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('malformed ciphertext: expected iv:tag:ct');
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const key = loadKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN) throw new Error(`bad iv length: ${iv.length}`);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

/** Returns true if the value looks like an encrypted envelope (already encrypted). */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}
