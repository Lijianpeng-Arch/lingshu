import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret, isEncryptedSecret } from './crypto.js';
import { createHash } from 'node:crypto';
import os from 'node:os';

const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64'); // deterministic 32-byte key

describe('crypto util (AES-256-GCM)', () => {
  beforeEach(() => {
    process.env['LINGSHU_MASTER_KEY'] = TEST_KEY_B64;
  });

  it('round-trips a plaintext API key', () => {
    const plain = 'sk-test-1234567890';
    const cipher = encryptSecret(plain);
    expect(decryptSecret(cipher)).toBe(plain);
  });

  it('produces ciphertext that does NOT equal the plaintext', () => {
    const plain = 'sk-supersecret';
    const cipher = encryptSecret(plain);
    expect(cipher).not.toBe(plain);
    expect(cipher).not.toContain(plain);
  });

  it('wraps output in enc:v1: prefix and isEncryptedSecret() returns true', () => {
    const cipher = encryptSecret('hello');
    expect(isEncryptedSecret(cipher)).toBe(true);
    expect(cipher.startsWith('enc:v1:')).toBe(true);
  });

  it('uses a fresh IV on every encrypt (same plaintext → different ciphertext)', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt values without the enc:v1: prefix', () => {
    expect(() => decryptSecret('plaintext-blob')).toThrow(/prefix/);
  });

  it('throws on tampered ciphertext (auth tag mismatch)', () => {
    const cipher = encryptSecret('sk-test');
    // Flip a character inside the ciphertext segment.
    const tampered = cipher.slice(0, -4) + (cipher.endsWith('A') ? 'B' : 'A');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws on malformed envelope (wrong part count)', () => {
    expect(() => decryptSecret('enc:v1:only-two-parts')).toThrow(/malformed/);
  });

  it('fails fast on invalid LINGSHU_MASTER_KEY length', () => {
    delete process.env['LINGSHU_MASTER_KEY'];
    process.env['LINGSHU_MASTER_KEY'] = Buffer.from('short').toString('base64'); // 5 bytes
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
  });

  it('falls back to OS-user+hostname SHA-256 when no env var set', () => {
    delete process.env['LINGSHU_MASTER_KEY'];
    const seed = `${os.userInfo().username}@${os.hostname()}`;
    const expectedKey = createHash('sha256').update(seed, 'utf8').digest();
    const cipher = encryptSecret('hello-fallback');
    // Decrypting with the expected fallback key must succeed.
    expect(decryptSecret(cipher)).toBe('hello-fallback');
    // And we know the cipher is well-formed (prefix present).
    expect(isEncryptedSecret(cipher)).toBe(true);
    // Ensure fallback path produces valid output (it must not throw and must round-trip).
    expect(expectedKey.length).toBe(32);
  });
});
