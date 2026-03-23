/**
 * Tailscale peer discovery.
 *
 * Queries the local Tailscale daemon (`tailscale status --json`) to discover
 * other nodes in the same tailnet that are also running AgentFlyer.  The
 * `federationPort` is assumed to be the same on all tailnet peers (configured
 * in the federation config block), or overridden per-node via hostname tags.
 *
 * This module shells out to `tailscale status --json`. It requires the
 * `tailscale` CLI to be installed and authenticated.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../core/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('federation:discovery:tailscale');

export interface TailscalePeerEntry {
  nodeId: string;
  host: string;
  federationPort: number;
}

interface TailscaleStatusPeer {
  DNSName?: string;
  TailscaleIPs?: string[];
  Tags?: string[];
  Online?: boolean;
  Hostname?: string;
}

interface TailscaleStatus {
  Peer?: Record<string, TailscaleStatusPeer>;
}

/**
 * Discover AgentFlyer peers on the local Tailscale network.
 * Returns entries only for peers that have `tag:agentflyer` in their ACL tags
 * (or all online peers if no tag filter is set).
 *
 * @param defaultFederationPort  Port to assume for every peer.
 * @param tagFilter              Only include peers with this tag (optional).
 */
export async function discoverTailscalePeers(
  defaultFederationPort: number,
  tagFilter = 'tag:agentflyer',
): Promise<TailscalePeerEntry[]> {
  try {
    const { stdout } = await execAsync('tailscale status --json', { timeout: 5000 });
    const status = JSON.parse(stdout) as TailscaleStatus;
    const peers: TailscalePeerEntry[] = [];

    for (const [key, peer] of Object.entries(status.Peer ?? {})) {
      if (!peer.Online) continue;
      if (tagFilter && !(peer.Tags ?? []).includes(tagFilter)) continue;
      const host = peer.TailscaleIPs?.[0] ?? peer.DNSName ?? '';
      if (!host) continue;
      peers.push({
        nodeId: key,
        host: host.replace(/\.$/, ''), // strip trailing dot from DNS name
        federationPort: defaultFederationPort,
      });
    }
    logger.info('Tailscale discovery complete', { found: peers.length });
    return peers;
  } catch (err) {
    logger.warn('Tailscale discovery failed', { error: String(err) });
    return [];
  }
}
