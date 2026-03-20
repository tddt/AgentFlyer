/**
 * FederationNode — the main federation runtime for a single gateway.
 *
 * Responsibilities:
 * - Manage the Ed25519 keypair (persisted to dataDir)
 * - Drive the WS transport (server + outbound peer connections)
 * - Handle federation message protocol (ANNOUNCE / PING / PONG / GOODBYE)
 * - Route MEMORY_QUERY to local MemoryStore and reply with MEMORY_RESULT
 * - Trigger discovery (static / mDNS / Tailscale)
 * - Expose listPeers() for the RPC layer
 *
 * Federation WS port convention:
 *   federationWsPort = gatewayHttpPort + 200
 *   (e.g. gateway on 19789 → federation WS on 19989)
 */
import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import type { FederationConfig } from '../core/config/schema.js';
import type { MemoryStore } from '../memory/store.js';
import { PeerRegistry, type PeerInfo } from './peer.js';
import { WsFederationTransport } from './transport/ws.js';
import {
  type FederationMessage,
  type AnnouncePayload,
  type MemoryQueryPayload,
  type MemoryResultPayload,
  signPayload,
  verifyMessage,
} from './protocol.js';
import { createStaticDiscovery } from './discovery/static.js';
import { createMdnsDiscovery } from './discovery/mdns.js';
import { discoverTailscalePeers } from './discovery/tailscale.js';

const logger = createLogger('federation:node');

/** Offset added to the gateway HTTP port to get the federation WS port. */
const FEDERATION_WS_PORT_OFFSET = 200;

const KEY_DIR = 'federation';
const PRIVATE_KEY_FILE = 'ed25519-private.pem';
const PUBLIC_KEY_FILE = 'ed25519-public.pem';
const NODE_ID_FILE = 'node-id.txt';

export interface FederationNodeDeps {
  config: FederationConfig;
  gatewayPort: number;
  dataDir: string;
  /** Gateway version string for ANNOUNCE payload. */
  gatewayVersion: string;
  /** Optional memory store — when present, MEMORY_QUERY messages are answered. */
  memoryStore?: MemoryStore;
}

export class FederationNode {
  private readonly nodeId: string;
  private readonly publicKeyPem: string;
  private readonly privateKeyPem: string;
  private readonly peers: PeerRegistry;
  private readonly transport: WsFederationTransport;
  private readonly federationPort: number;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private mdnsDiscovery: ReturnType<typeof createMdnsDiscovery> | null = null;

  constructor(private readonly deps: FederationNodeDeps) {
    this.federationPort = deps.gatewayPort + FEDERATION_WS_PORT_OFFSET;
    const keys = this.loadOrGenerateKeys();
    this.nodeId = keys.nodeId;
    this.publicKeyPem = keys.publicKeyPem;
    this.privateKeyPem = keys.privateKeyPem;
    this.peers = new PeerRegistry();
    this.transport = new WsFederationTransport(this.nodeId);
    this.transport.onMessage(this.handleMessage.bind(this));
  }

  private loadOrGenerateKeys(): {
    nodeId: string;
    publicKeyPem: string;
    privateKeyPem: string;
  } {
    const keyDir = join(this.deps.dataDir, KEY_DIR);
    const privPath = join(keyDir, PRIVATE_KEY_FILE);
    const pubPath = join(keyDir, PUBLIC_KEY_FILE);
    const idPath = join(keyDir, NODE_ID_FILE);

    if (existsSync(privPath) && existsSync(pubPath) && existsSync(idPath)) {
      return {
        nodeId: readFileSync(idPath, 'utf-8').trim(),
        privateKeyPem: readFileSync(privPath, 'utf-8'),
        publicKeyPem: readFileSync(pubPath, 'utf-8'),
      };
    }

    // Generate fresh keypair
    mkdirSync(keyDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }) as string;
    const publicKeyPem = (publicKey as KeyObject).export({ type: 'spki', format: 'pem' }) as string;
    const nodeId = ulid();

    writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
    writeFileSync(pubPath, publicKeyPem);
    writeFileSync(idPath, nodeId);
    logger.info('Generated new federation keypair', { nodeId });
    return { nodeId, privateKeyPem, publicKeyPem };
  }

  private buildMessage<T extends FederationMessage['payload']>(
    type: FederationMessage['type'],
    payload: T,
  ): FederationMessage {
    return {
      type,
      fromNodeId: this.nodeId,
      signature: signPayload(payload, this.privateKeyPem),
      payload,
    };
  }

  private async handleMessage(msg: FederationMessage, fromPeerId: string): Promise<void> {
    // Verify signature if we have the peer's public key
    const peer = this.peers.get(msg.fromNodeId);
    if (peer?.publicKey) {
      if (!verifyMessage(msg, peer.publicKey)) {
        logger.warn('Federation message signature invalid', { fromNodeId: msg.fromNodeId });
        return;
      }
    }

    switch (msg.type) {
      case 'ANNOUNCE': {
        const p = msg.payload as AnnouncePayload;
        this.peers.upsert({
          nodeId: p.nodeId,
          host: p.host,
          federationPort: p.federationPort,
          publicKey: p.publicKey,
          status: 'connected',
        });
        logger.info('Peer announced', { nodeId: p.nodeId, host: p.host });
        // Send our own announce back
        await this.transport.send(
          fromPeerId,
          this.buildMessage('ANNOUNCE', this.buildAnnouncePayload()),
        );
        break;
      }

      case 'PING': {
        await this.transport.send(
          fromPeerId,
          this.buildMessage('PONG', { ts: Date.now() }),
        );
        break;
      }

      case 'PONG': {
        // Used to update latency (latency = now - ping.ts, handled by caller)
        this.peers.setStatus(fromPeerId, 'connected');
        break;
      }

      case 'MEMORY_QUERY': {
        if (!this.deps.memoryStore) break;
        const q = msg.payload as MemoryQueryPayload;
        try {
          const entries = this.deps.memoryStore.searchFts(
            q.query,
            q.partition,
            q.limit ?? 5,
          );
          const resultPayload: MemoryResultPayload = {
            requestId: q.requestId,
            fromNodeId: this.nodeId,
            entries: entries.map(e => ({
              id: e.id,
              content: e.content,
              partition: e.partition,
              createdAt: e.createdAt,
            })),
          };
          await this.transport.send(
            fromPeerId,
            this.buildMessage('MEMORY_RESULT', resultPayload),
          );
        } catch (err) {
          logger.warn('MEMORY_QUERY handler error', { error: String(err) });
        }
        break;
      }

      case 'GOODBYE': {
        this.peers.setStatus(msg.fromNodeId, 'disconnected');
        logger.info('Peer said goodbye', { nodeId: msg.fromNodeId });
        break;
      }

      default:
        break;
    }
  }

  private buildAnnouncePayload(): AnnouncePayload {
    // Strip PEM headers/footers and newlines to get raw base64
    const publicKey = this.publicKeyPem
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '');
    return {
      nodeId: this.nodeId,
      host: 'localhost',
      federationPort: this.federationPort,
      publicKey,
      gatewayVersion: this.deps.gatewayVersion,
      ts: Date.now(),
    };
  }

  async start(): Promise<void> {
    logger.info('Starting federation node', { nodeId: this.nodeId, port: this.federationPort });

    // Start WS server
    await this.transport.start(this.federationPort);

    // Connect to static peers
    const staticPeers = this.deps.config.discovery.static
      ? this.deps.config.peers
      : [];
    for (const sp of staticPeers) {
      this.peers.upsert({ nodeId: sp.nodeId, host: sp.host, federationPort: sp.port });
      const ok = await this.transport.connect(sp.host, sp.port, sp.nodeId);
      if (ok) {
        this.peers.setStatus(sp.nodeId, 'connected');
        await this.transport.send(
          sp.nodeId,
          this.buildMessage('ANNOUNCE', this.buildAnnouncePayload()),
        );
      }
    }

    // mDNS discovery
    if (this.deps.config.discovery.mdns) {
      this.mdnsDiscovery = createMdnsDiscovery();
      await this.mdnsDiscovery.start(this.nodeId, this.federationPort);
    }

    // Tailscale discovery
    if (this.deps.config.discovery.tailscale) {
      const tsPeers = await discoverTailscalePeers(this.federationPort);
      for (const tsp of tsPeers) {
        this.peers.upsert({ nodeId: tsp.nodeId, host: tsp.host, federationPort: tsp.federationPort });
        const ok = await this.transport.connect(tsp.host, tsp.federationPort, tsp.nodeId);
        if (ok) this.peers.setStatus(tsp.nodeId, 'connected');
      }
    }

    // Periodic PING to keep connections alive
    this.pingInterval = setInterval(() => void this.pingAll(), 30_000);

    await this.broadcast(this.buildMessage('ANNOUNCE', this.buildAnnouncePayload()));
    logger.info('Federation node started', {
      nodeId: this.nodeId,
      connected: this.transport.connectedPeers().length,
    });
  }

  private async pingAll(): Promise<void> {
    await this.broadcast(this.buildMessage('PING', { ts: Date.now() }));
    this.peers.evictStale(5 * 60_000); // remove peers not seen in 5 min
  }

  private async broadcast(msg: FederationMessage): Promise<void> {
    await this.transport.broadcast(msg).catch(err =>
      logger.warn('Broadcast error', { error: String(err) }),
    );
  }

  async stop(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    await this.broadcast(
      this.buildMessage('GOODBYE', { nodeId: this.nodeId, reason: 'shutdown' }),
    );
    await this.mdnsDiscovery?.stop();
    await this.transport.stop();
    logger.info('Federation node stopped', { nodeId: this.nodeId });
  }

  /** For RPC: return all known peers with their current status. */
  listPeers(): Array<{
    nodeId: string;
    host: string;
    port: number;
    status: string;
    latencyMs?: number;
    lastSeen?: number;
  }> {
    return this.peers.list().map(p => ({
      nodeId: p.nodeId,
      host: p.host,
      port: p.federationPort,
      status: p.status,
      latencyMs: p.latencyMs,
      lastSeen: p.lastSeen,
    }));
  }

  getNodeId(): string {
    return this.nodeId;
  }
}
