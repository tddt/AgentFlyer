import { describe, expect, it } from 'vitest';
import {
  decrypt,
  deriveKey,
  encrypt,
  fromHex,
  generateKeyPair,
  generateKeyPairSync,
  sha256Hex,
  sign,
  signText,
  toHex,
  verify,
  verifyText,
} from '../../../src/core/crypto.js';

describe('crypto', () => {
  // ─── Hex utilities ─────────────────────────────────────────────────────────
  describe('toHex / fromHex', () => {
    it('round-trips bytes through hex', () => {
      const bytes = new Uint8Array([1, 2, 3, 255, 0]);
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    });

    it('toHex produces lowercase hex', () => {
      const hex = toHex(new Uint8Array([0xab, 0xcd]));
      expect(hex).toBe('abcd');
    });
  });

  describe('sha256Hex', () => {
    it('returns 64-character hex string', () => {
      const h = sha256Hex('hello');
      expect(h).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(h)).toBe(true);
    });

    it('is deterministic', () => {
      expect(sha256Hex('test')).toBe(sha256Hex('test'));
    });

    it('differs for different inputs', () => {
      expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
    });
  });

  // ─── Key pair generation ───────────────────────────────────────────────────
  describe('generateKeyPair (async)', () => {
    it('returns 32-byte private key and 32-byte public key', async () => {
      const kp = await generateKeyPair();
      expect(kp.privateKey).toHaveLength(32);
      expect(kp.publicKey).toHaveLength(32);
    });

    it('each call produces unique keys', async () => {
      const a = await generateKeyPair();
      const b = await generateKeyPair();
      expect(toHex(a.privateKey)).not.toBe(toHex(b.privateKey));
    });
  });

  describe('generateKeyPairSync', () => {
    it('returns 32-byte keys synchronously', () => {
      const kp = generateKeyPairSync();
      expect(kp.privateKey).toHaveLength(32);
      expect(kp.publicKey).toHaveLength(32);
    });
  });

  // ─── Ed25519 sign / verify ─────────────────────────────────────────────────
  describe('sign / verify', () => {
    it('produces a 64-byte signature', async () => {
      const kp = await generateKeyPair();
      const msg = new TextEncoder().encode('hello agentflyer');
      const sig = await sign(msg, kp.privateKey);
      expect(sig).toHaveLength(64);
    });

    it('valid signature verifies as true', async () => {
      const kp = await generateKeyPair();
      const msg = new TextEncoder().encode('verify me');
      const sig = await sign(msg, kp.privateKey);
      const ok = await verify(sig, msg, kp.publicKey);
      expect(ok).toBe(true);
    });

    it('tampered message fails verification', async () => {
      const kp = await generateKeyPair();
      const msg = new TextEncoder().encode('original');
      const sig = await sign(msg, kp.privateKey);
      const tampered = new TextEncoder().encode('tampered');
      const ok = await verify(sig, tampered, kp.publicKey);
      expect(ok).toBe(false);
    });

    it('wrong public key fails verification', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      const msg = new TextEncoder().encode('msg');
      const sig = await sign(msg, kp1.privateKey);
      const ok = await verify(sig, msg, kp2.publicKey);
      expect(ok).toBe(false);
    });
  });

  describe('signText / verifyText', () => {
    it('round-trips text signing', async () => {
      const kp = await generateKeyPair();
      const text = 'Hello, federation!';
      const sigHex = await signText(text, kp.privateKey);
      const ok = await verifyText(text, sigHex, toHex(kp.publicKey));
      expect(ok).toBe(true);
    });

    it('rejects tampered text', async () => {
      const kp = await generateKeyPair();
      const sigHex = await signText('original', kp.privateKey);
      const ok = await verifyText('tampered', sigHex, toHex(kp.publicKey));
      expect(ok).toBe(false);
    });
  });

  // ─── AES-256-GCM encryption ────────────────────────────────────────────────
  describe('encrypt / decrypt', () => {
    const key32 = new Uint8Array(32).fill(7); // deterministic test key

    it('encrypt produces non-empty hex string', () => {
      const ct = encrypt('secret data', key32);
      expect(typeof ct).toBe('string');
      expect(ct.length).toBeGreaterThan(0);
    });

    it('round-trip encrypts and decrypts', () => {
      const plaintext = 'AgentFlyer is awesome!';
      const ct = encrypt(plaintext, key32);
      const pt = decrypt(ct, key32);
      expect(pt).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const ct1 = encrypt('same', key32);
      const ct2 = encrypt('same', key32);
      expect(ct1).not.toBe(ct2);
    });

    it('decryption fails with wrong key', () => {
      const ct = encrypt('data', key32);
      const wrongKey = new Uint8Array(32).fill(9);
      expect(() => decrypt(ct, wrongKey)).toThrow();
    });
  });

  // ─── Key derivation ────────────────────────────────────────────────────────
  describe('deriveKey', () => {
    it('produces a 32-byte key', async () => {
      const key = await deriveKey('my-password', 'my-salt');
      expect(key).toHaveLength(32);
    });

    it('is deterministic for same password + salt', async () => {
      const k1 = await deriveKey('pw', 'salt');
      const k2 = await deriveKey('pw', 'salt');
      expect(toHex(k1)).toBe(toHex(k2));
    });

    it('differs for different passwords', async () => {
      const k1 = await deriveKey('pw1', 'salt');
      const k2 = await deriveKey('pw2', 'salt');
      expect(toHex(k1)).not.toBe(toHex(k2));
    });

    it('derived key works with encrypt/decrypt', async () => {
      const key = await deriveKey('secret', 'random-salt');
      const ct = encrypt('payload', key);
      expect(decrypt(ct, key)).toBe('payload');
    });
  });
});
