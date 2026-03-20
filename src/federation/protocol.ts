/**
 * Federation message protocol types.
 *
 * All messages are JSON-serialized. The `payload` is serialized to a string,
 * signed with the sender's Ed25519 private key, and the base64-encoded
 * signature is placed in the `signature` field before transmission.
 */

export type FederationMessageType =
  | 'ANNOUNCE'
  | 'MEMORY_QUERY'
  | 'MEMORY_RESULT'
  | 'PING'
  | 'PONG'
  | 'GOODBYE';

/** Wire format for every federation message. */
export interface FederationMessage {
  type: FederationMessageType;
  fromNodeId: string;
  /**
   * Base64-encoded Ed25519 signature of the canonical JSON string of `payload`.
   * Recipients verify this before processing.
   */
  signature: string;
  payload: FederationPayload;
}

// ── Payload types ────────────────────────────────────────────────────────────

export interface AnnouncePayload {
  nodeId: string;
  host: string;
  /** Gateway WS federation port (not the HTTP RPC port). */
  federationPort: number;
  /** Base64-encoded Ed25519 public key. */
  publicKey: string;
  gatewayVersion: string;
  /** Unix ms timestamp. */
  ts: number;
}

export interface MemoryQueryPayload {
  requestId: string;
  query: string;
  partition?: string;
  limit?: number;
}

export interface MemoryResultEntry {
  id: string;
  content: string;
  partition?: string;
  createdAt: number;
  /** Cosine similarity score if the peer computed embeddings. */
  score?: number;
}

export interface MemoryResultPayload {
  requestId: string;
  fromNodeId: string;
  entries: MemoryResultEntry[];
}

export interface PingPayload {
  ts: number;
}

export interface PongPayload {
  ts: number;
}

export interface GoodbyePayload {
  nodeId: string;
  reason?: string;
}

export type FederationPayload =
  | AnnouncePayload
  | MemoryQueryPayload
  | MemoryResultPayload
  | PingPayload
  | PongPayload
  | GoodbyePayload;

// ── Signing helpers ──────────────────────────────────────────────────────────

import { createSign, createVerify } from 'node:crypto';

/** Canonical JSON string of a payload (sorted keys for determinism). */
export function canonicalize(payload: FederationPayload): string {
  return JSON.stringify(payload, Object.keys(payload as object).sort());
}

/** Sign a payload using an Ed25519 private key (PEM or KeyObject). Returns base64. */
export function signPayload(
  payload: FederationPayload,
  privateKeyPem: string,
): string {
  const signer = createSign('SHA512');
  signer.update(canonicalize(payload));
  return signer.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' }, 'base64');
}

/** Verify the signature of a federation message against the sender's public key (base64). */
export function verifyMessage(
  msg: FederationMessage,
  publicKeyBase64: string,
): boolean {
  try {
    const pubKeyPem =
      `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
    const verifier = createVerify('SHA512');
    verifier.update(canonicalize(msg.payload));
    return verifier.verify(
      { key: pubKeyPem, dsaEncoding: 'ieee-p1363' },
      msg.signature,
      'base64',
    );
  } catch {
    return false;
  }
}
