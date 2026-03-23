/**
 * mDNS-based federation discovery.
 *
 * Broadcasts an mDNS `_agentflyer._tcp` service record so that other
 * AgentFlyer nodes on the same LAN can discover each other automatically.
 * The `multicast-dns` package is a runtime dependency; import is guarded
 * so the rest of the codebase loads even without it.
 */
import { createLogger } from '../../core/logger.js';

const logger = createLogger('federation:discovery:mdns');

export const MDNS_SERVICE_TYPE = '_agentflyer._tcp';

export interface MdnsPeerEntry {
  nodeId: string;
  host: string;
  federationPort: number;
}

type MdnsLib = {
  default: new () => {
    on(event: 'response', handler: (resp: MdnsResponse) => void): void;
    query(questions: Array<{ name: string; type: string }>): void;
    respond(answers: MdnsRecord[]): void;
    destroy(): void;
  };
};

interface MdnsResponse {
  answers?: MdnsRecord[];
}

interface MdnsRecord {
  name: string;
  type: string;
  ttl?: number;
  data?: MdnsData;
}

interface MdnsData {
  target?: string;
  port?: number;
  txt?: string[];
}

async function loadMdns(): Promise<MdnsLib | null> {
  try {
    return (await import('multicast-dns')) as unknown as MdnsLib;
  } catch {
    logger.warn('`multicast-dns` not installed — mDNS federation discovery disabled');
    return null;
  }
}

export interface MdnsDiscovery {
  /** Start advertising this node and listening for peers. */
  start(selfNodeId: string, federationPort: number): Promise<void>;
  /** Stop advertising and release the mDNS socket. */
  stop(): Promise<void>;
  /** Current list of discovered peers (cached from last query). */
  listPeers(): MdnsPeerEntry[];
}

export function createMdnsDiscovery(): MdnsDiscovery {
  const peers = new Map<string, MdnsPeerEntry>();
  // RATIONALE: closed-over variable avoids `this`-cast on the returned object literal
  let mdnsInstance: {
    query(q: unknown[]): void;
    respond(a: unknown[]): void;
    on(e: string, h: unknown): void;
    destroy(): void;
  } | null = null;

  return {
    async start(selfNodeId: string, federationPort: number): Promise<void> {
      const lib = await loadMdns();
      if (!lib) return;

      const mdns = new lib.default();
      mdnsInstance = mdns;

      // Advertise ourselves
      mdns.respond([
        {
          name: MDNS_SERVICE_TYPE,
          type: 'SRV',
          data: { target: 'local', port: federationPort },
        },
        {
          name: MDNS_SERVICE_TYPE,
          type: 'TXT',
          data: { txt: [`nodeId=${selfNodeId}`] },
        },
      ]);

      // Listen for peers
      mdns.on('response', (res: MdnsResponse) => {
        if (!res.answers) return;
        let nodeId = '';
        let host = '';
        let port = 0;
        for (const answer of res.answers) {
          if (answer.name !== MDNS_SERVICE_TYPE) continue;
          if (answer.type === 'TXT' && answer.data?.txt) {
            const entry = answer.data.txt.find((t) => t.startsWith('nodeId='));
            if (entry) nodeId = entry.slice('nodeId='.length);
          }
          if (answer.type === 'SRV' && answer.data) {
            host = answer.data.target ?? '';
            port = answer.data.port ?? 0;
          }
        }
        if (nodeId && host && port && nodeId !== selfNodeId) {
          peers.set(nodeId, { nodeId, host, federationPort: port });
          logger.info('mDNS peer discovered', { nodeId, host, port });
        }
      });

      // Periodically query for peers
      setInterval(() => {
        mdns.query([{ name: MDNS_SERVICE_TYPE, type: 'SRV' }]);
      }, 30_000);
      mdns.query([{ name: MDNS_SERVICE_TYPE, type: 'SRV' }]);

      logger.info('mDNS discovery started', { selfNodeId, federationPort });
    },

    async stop(): Promise<void> {
      mdnsInstance?.destroy();
      mdnsInstance = null;
      peers.clear();
    },

    listPeers(): MdnsPeerEntry[] {
      return Array.from(peers.values());
    },
  };
}
