/**
 * Federation module public API.
 */
export { FederationNode } from './node.js';
export type { FederationNodeDeps } from './node.js';
export { PeerRegistry } from './peer.js';
export type { PeerInfo, PeerStatus } from './peer.js';
export { queryFederatedMemory } from './memory-sync.js';
export type { FederatedQueryOptions, FederatedQueryResult } from './memory-sync.js';
export { WsFederationTransport } from './transport/ws.js';
export { createStaticDiscovery } from './discovery/static.js';
export { createMdnsDiscovery } from './discovery/mdns.js';
export { discoverTailscalePeers } from './discovery/tailscale.js';
export * from './protocol.js';
