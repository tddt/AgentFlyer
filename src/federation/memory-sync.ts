/**
 * Federated memory query helpers.
 *
 * Sends MEMORY_QUERY messages to all connected peers and merges the results.
 * Responses are collected with a configurable timeout; peers that don't
 * respond in time are skipped (non-blocking degradation).
 */
import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import type { PeerRegistry } from './peer.js';
import type { FederationMessage, MemoryResultEntry, MemoryResultPayload } from './protocol.js';
import { signPayload } from './protocol.js';
import type { FederationTransport } from './transport/interface.js';

const logger = createLogger('federation:memory-sync');

const DEFAULT_TIMEOUT_MS = 3000;

export interface FederatedQueryOptions {
  query: string;
  partition?: string;
  limit?: number;
  timeoutMs?: number;
}

export interface FederatedQueryResult {
  entries: MemoryResultEntry[];
  /** nodeIds that responded within the timeout. */
  respondedPeers: string[];
  /** nodeIds that did not respond. */
  timedOutPeers: string[];
}

/**
 * Query all connected federation peers for matching memory entries.
 * Results are collected asynchronously; partial results are returned if
 * some peers time out.
 */
export async function queryFederatedMemory(
  opts: FederatedQueryOptions,
  transport: FederationTransport,
  _peers: PeerRegistry,
  selfNodeId: string,
  privateKeyPem: string,
): Promise<FederatedQueryResult> {
  const connectedPeerIds = transport.connectedPeers();
  if (connectedPeerIds.length === 0) {
    return { entries: [], respondedPeers: [], timedOutPeers: [] };
  }

  const requestId = ulid();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, (entries: MemoryResultEntry[]) => void>();
  const respondedPeers: string[] = [];
  const timedOutPeers: string[] = [];

  // Build the query message
  const queryPayload = {
    requestId,
    query: opts.query,
    partition: opts.partition,
    limit: opts.limit ?? 5,
  };
  const signature = signPayload(queryPayload, privateKeyPem);
  const queryMsg: FederationMessage = {
    type: 'MEMORY_QUERY',
    fromNodeId: selfNodeId,
    signature,
    payload: queryPayload,
  };

  // Set up response listeners
  const responsePromises: Promise<MemoryResultEntry[]>[] = connectedPeerIds.map((peerId) => {
    return new Promise<MemoryResultEntry[]>((resolve) => {
      pending.set(peerId, resolve);
    });
  });

  // We'll route incoming MEMORY_RESULT messages from the handler registered
  // in FederationNode. Here we return a handler the caller must register.
  // To keep this module self-contained, we use a one-shot message watcher.
  const resultHandler = (msg: FederationMessage, fromPeerId: string): void => {
    if (msg.type !== 'MEMORY_RESULT') return;
    const payload = msg.payload as MemoryResultPayload;
    if (payload.requestId !== requestId) return;
    const resolve = pending.get(fromPeerId);
    if (resolve) {
      pending.delete(fromPeerId);
      respondedPeers.push(fromPeerId);
      resolve(payload.entries);
    }
  };

  transport.onMessage(resultHandler);

  // Broadcast query to all connected peers
  await transport.broadcast(queryMsg);

  // Wait for all responses or timeout
  const timeoutPromises = connectedPeerIds.map(
    (peerId) =>
      new Promise<MemoryResultEntry[]>((resolve) =>
        setTimeout(() => {
          if (pending.has(peerId)) {
            pending.delete(peerId);
            timedOutPeers.push(peerId);
            logger.warn('Federation peer did not respond in time', { peerId, requestId });
          }
          resolve([]);
        }, timeoutMs),
      ),
  );

  const results = await Promise.all(
    responsePromises.map((p, i) => {
      const timeoutPromise = timeoutPromises[i];
      if (!timeoutPromise) {
        throw new Error(`Missing timeout promise for response index ${i}`);
      }
      return Promise.race([p, timeoutPromise]);
    }),
  );

  // Merge and de-duplicate by entry id
  const seen = new Set<string>();
  const merged: MemoryResultEntry[] = [];
  for (const batch of results) {
    for (const entry of batch) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }
  }

  // Sort by score descending if available, otherwise by createdAt desc
  merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.createdAt - a.createdAt);

  logger.debug('Federated query complete', {
    requestId,
    total: merged.length,
    respondedPeers: respondedPeers.length,
    timedOutPeers: timedOutPeers.length,
  });

  return { entries: merged, respondedPeers, timedOutPeers };
}
