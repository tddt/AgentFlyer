/**
 * PeerRegistry — tracks known and connected federation peers.
 */

export type PeerStatus = 'discovered' | 'connected' | 'disconnected' | 'banned';

export interface PeerInfo {
  nodeId: string;
  host: string;
  federationPort: number;
  /** Base64-encoded Ed25519 public key (set after ANNOUNCE is received). */
  publicKey?: string;
  status: PeerStatus;
  lastSeen: number;
  latencyMs?: number;
}

export class PeerRegistry {
  private peers = new Map<string, PeerInfo>();

  upsert(
    info: Omit<PeerInfo, 'status' | 'lastSeen'> & Partial<Pick<PeerInfo, 'status' | 'lastSeen'>>,
  ): void {
    const existing = this.peers.get(info.nodeId);
    this.peers.set(info.nodeId, {
      status: 'discovered',
      lastSeen: Date.now(),
      ...existing,
      ...info,
    });
  }

  get(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }

  list(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  listConnected(): PeerInfo[] {
    return this.list().filter((p) => p.status === 'connected');
  }

  remove(nodeId: string): void {
    this.peers.delete(nodeId);
  }

  setStatus(nodeId: string, status: PeerStatus): void {
    const p = this.peers.get(nodeId);
    if (p) {
      p.status = status;
      p.lastSeen = Date.now();
    }
  }

  updateLatency(nodeId: string, ms: number): void {
    const p = this.peers.get(nodeId);
    if (p) p.latencyMs = ms;
  }

  /** Remove peers not seen within the given TTL (ms). */
  evictStale(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff && peer.status !== 'connected') {
        this.peers.delete(id);
      }
    }
  }
}
