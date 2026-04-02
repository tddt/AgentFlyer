/**
 * WebSocket-based federation transport.
 *
 * Each FederationNode acts as both a WS server (accepting peer connections)
 * and a WS client (connecting to known peers). Messages are JSON-serialized
 * FederationMessage objects. The `ws` package is a runtime dependency; it is
 * imported dynamically so the rest of the codebase can load even when `ws`
 * is not installed.
 */
import { createLogger } from '../../core/logger.js';
import type { FederationMessage } from '../protocol.js';
import type { FederationTransport, MessageHandler } from './interface.js';

const logger = createLogger('federation:transport:ws');

// Dynamic import types — we use `ws` if available, fall back to a stub.
type WsLib = {
  WebSocketServer: new (opts: { port: number }) => {
    on(event: 'connection', handler: (ws: WsSocket, req: unknown) => void): void;
    close(cb?: () => void): void;
  };
  WebSocket: new (url: string) => WsSocket;
};

interface WsSocket {
  readyState: number;
  on(event: 'message', handler: (data: unknown) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'open', handler: () => void): void;
  send(data: string): void;
  close(): void;
}

// WS ready state constants
const WS_OPEN = 1;

async function loadWs(): Promise<WsLib | null> {
  try {
    return (await import('ws')) as unknown as WsLib;
  } catch {
    logger.warn('`ws` package not available — federation WS transport disabled');
    return null;
  }
}

export class WsFederationTransport implements FederationTransport {
  private handlers: MessageHandler[] = [];
  private connections = new Map<string, WsSocket>(); // peerId → socket
  private server: {
    on(e: string, h: (...a: unknown[]) => void): void;
    close(cb?: () => void): void;
  } | null = null;
  private ws: WsLib | null = null;

  constructor(private readonly selfNodeId: string) {}

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  private dispatch(msg: FederationMessage, fromPeerId: string): void {
    for (const h of this.handlers) h(msg, fromPeerId);
  }

  private attachSocketHandlers(socket: WsSocket, peerId: string): void {
    socket.on('message', (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw)) as FederationMessage;
        this.dispatch(msg, peerId);
      } catch (err) {
        logger.warn('Bad federation message', { peerId, error: String(err) });
      }
    });
    socket.on('close', () => {
      this.connections.delete(peerId);
      logger.info('Federation peer disconnected', { peerId });
    });
    socket.on('error', (err) => {
      logger.warn('Federation socket error', { peerId, error: String(err) });
    });
  }

  async start(listenPort: number): Promise<void> {
    this.ws = await loadWs();
    if (!this.ws) return;

    const wss = new this.ws.WebSocketServer({ port: listenPort });
    // Store server reference for cleanup
    this.server = wss as unknown as typeof this.server;

    wss.on('connection', (socket, _req) => {
      // We don't know the peerId until we receive an ANNOUNCE message.
      // Use a temporary placeholder; the ANNOUNCE handler in FederationNode
      // will call connect() to replace it with the real nodeId.
      const tempId = `unknown:${Date.now()}`;
      this.connections.set(tempId, socket);
      this.attachSocketHandlers(socket, tempId);
      logger.debug('Inbound federation connection', { tempId });
    });

    logger.info('Federation WS server listening', { port: listenPort });
  }

  async connect(host: string, port: number, peerNodeId?: string): Promise<boolean> {
    if (!this.ws) {
      this.ws = await loadWs();
      if (!this.ws) return false;
    }
    const wsImpl = this.ws;
    if (!wsImpl) {
      return false;
    }
    const id = peerNodeId ?? `${host}:${port}`;
    if (this.connections.has(id)) return true;

    return new Promise<boolean>((resolve) => {
      const socket = new wsImpl.WebSocket(`ws://${host}:${port}`);
      const timeout = setTimeout(() => {
        socket.close();
        resolve(false);
      }, 5000);

      socket.on('open', () => {
        clearTimeout(timeout);
        this.connections.set(id, socket);
        this.attachSocketHandlers(socket, id);
        logger.info('Connected to federation peer', { id, host, port });
        resolve(true);
      });
      socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        logger.warn('Failed to connect to federation peer', { id, error: String(err) });
        resolve(false);
      });
    });
  }

  async send(peerId: string, msg: FederationMessage): Promise<void> {
    const socket = this.connections.get(peerId);
    if (!socket || socket.readyState !== WS_OPEN) {
      logger.warn('Cannot send to peer — not connected', { peerId });
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  async broadcast(msg: FederationMessage): Promise<void> {
    const json = JSON.stringify(msg);
    for (const [peerId, socket] of this.connections) {
      if (socket.readyState === WS_OPEN) {
        socket.send(json);
      } else {
        this.connections.delete(peerId);
      }
    }
  }

  connectedPeers(): string[] {
    return Array.from(this.connections.keys()).filter(
      (id) => this.connections.get(id)?.readyState === WS_OPEN,
    );
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.close();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    logger.info('Federation WS transport stopped');
  }
}
