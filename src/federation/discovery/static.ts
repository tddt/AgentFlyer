/**
 * Static peer discovery.
 *
 * The simplest discovery mechanism: a hard-coded (or config-driven) list of
 * `host:federationPort` pairs. Useful for known-topology deployments.
 */

export interface StaticPeerEntry {
  /** Arbitrary but unique identifier for this peer (used as a hint). */
  nodeId?: string;
  host: string;
  federationPort: number;
}

export interface StaticDiscovery {
  listPeers(): StaticPeerEntry[];
}

export function createStaticDiscovery(peers: StaticPeerEntry[]): StaticDiscovery {
  return {
    listPeers: () => [...peers],
  };
}
