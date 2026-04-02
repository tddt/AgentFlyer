// Ed25519 signing + AES-256-GCM encryption
// Uses @noble/ed25519 (pure JS, no native deps) and @noble/ciphers

import { pbkdf2 as _pbkdf2, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gcm } from '@noble/ciphers/aes';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { type NodeId, asNodeId } from './types.js';

// ed25519 v2 requires sha512 for sync operations
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const pbkdf2 = promisify(_pbkdf2);

// ─── Hex encoding helpers ─────────────────────────────────────────────────────
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── Key pair ─────────────────────────────────────────────────────────────────
export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function generateKeyPairSync(): KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey) as Uint8Array;
  return { privateKey, publicKey };
}

// ─── Signing ──────────────────────────────────────────────────────────────────
export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  return ed.sign(message, privateKey);
}

export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export async function signText(text: string, privateKey: Uint8Array): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const sig = await sign(bytes, privateKey);
  return toHex(sig);
}

export async function verifyText(
  text: string,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  return verify(fromHex(signatureHex), new TextEncoder().encode(text), fromHex(publicKeyHex));
}

// ─── AES-256-GCM encryption ───────────────────────────────────────────────────
/**
 * Encrypt plaintext using AES-256-GCM.
 * Output format: hex(12-byte IV) + hex(ciphertext + 16-byte auth tag)
 */
export function encrypt(plaintext: string, key: Uint8Array): string {
  const iv = randomBytes(12);
  const data = new TextEncoder().encode(plaintext);
  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(data);
  return toHex(iv) + toHex(encrypted);
}

/**
 * Decrypt AES-256-GCM hex payload produced by `encrypt()`.
 */
export function decrypt(hexPayload: string, key: Uint8Array): string {
  const bytes = fromHex(hexPayload);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const cipher = gcm(key, iv);
  const decrypted = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Derive a 32-byte AES key from password + salt using PBKDF2-SHA256.
 * Use for encrypting credential files.
 */
export async function deriveKey(password: string, salt: string): Promise<Uint8Array> {
  const key = await pbkdf2(password, salt, 100_000, 32, 'sha256');
  return new Uint8Array(key);
}

// ─── Federation identity ──────────────────────────────────────────────────────
export interface FederationIdentityPublic {
  nodeId: NodeId;
  publicKeyHex: string;
  createdAt: number;
}

export interface FederationIdentityFull extends FederationIdentityPublic {
  privateKeyHex: string;
}

/**
 * Load existing federation identity from disk, or generate a fresh one.
 * Private key is stored at `identityDir/identity.key` (file mode 0o600).
 * Public identity is stored at `identityDir/identity.json`.
 */
export async function loadOrCreateFederationIdentity(identityDir: string): Promise<{
  identity: FederationIdentityPublic;
  privateKey: Uint8Array;
}> {
  mkdirSync(identityDir, { recursive: true });

  const idPath = join(identityDir, 'identity.json');
  const keyPath = join(identityDir, 'identity.key');

  if (existsSync(idPath) && existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(idPath, 'utf-8')) as FederationIdentityPublic;
    const privateKey = fromHex(readFileSync(keyPath, 'utf-8').trim());
    return { identity: raw, privateKey };
  }

  const kp = await generateKeyPair();
  const nodeId = asNodeId(toHex(kp.publicKey).slice(0, 16));

  const identity: FederationIdentityPublic = {
    nodeId,
    publicKeyHex: toHex(kp.publicKey),
    createdAt: Date.now(),
  };

  writeFileSync(idPath, JSON.stringify(identity, null, 2), 'utf-8');
  // mode 0o600 restricts read/write to owner only
  writeFileSync(keyPath, toHex(kp.privateKey), { mode: 0o600 });

  return { identity, privateKey: kp.privateKey };
}
