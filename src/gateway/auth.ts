import { randomBytes } from 'node:crypto';
import { createLogger } from '../core/logger.js';

const logger = createLogger('gateway:auth');

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a bearer token from the `Authorization` header.
 * Format: `Authorization: Bearer <token>`
 */
export function validateToken(
  authHeader: string | null | undefined,
  expectedToken: string,
): AuthResult {
  if (!authHeader) {
    return { ok: false, reason: 'Missing Authorization header' };
  }
  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return { ok: false, reason: 'Invalid Authorization format; expected: Bearer <token>' };
  }
  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, expectedToken)) {
    logger.warn('Auth token mismatch');
    return { ok: false, reason: 'Invalid token' };
  }
  return { ok: true };
}

/** Naive constant-time string comparison (ASCII-safe). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate to avoid length-based timing leak
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0 && a.length === b.length;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Generate a random gateway token (32 hex chars). */
export function generateToken(): string {
  return randomBytes(16).toString('hex');
}
