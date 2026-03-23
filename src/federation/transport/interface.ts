/**
 * FederationTransport interface.
 *
 * Concrete implementations handle the actual network I/O (WebSocket, HTTP,
 * etc.). The FederationNode depends only on this interface, making transports
 * swappable without changing node logic.
 */
import type { FederationMessage } from '../protocol.js';

/** Called when a message arrives from a remote peer. */
export type MessageHandler = (msg: FederationMessage, fromPeerId: string) => void;

export interface FederationTransport {
  /** Attempt to open a persistent connection to a remote peer. */
  connect(host: string, port: number, peerNodeId?: string): Promise<boolean>;

  /** Send a message to a single connected peer (by nodeId). */
  send(peerId: string, msg: FederationMessage): Promise<void>;

  /** Send a message to all currently-connected peers. */
  broadcast(msg: FederationMessage): Promise<void>;

  /** Register a handler for incoming messages. May be called multiple times. */
  onMessage(handler: MessageHandler): void;

  /** Start the server side of the transport (e.g. open WS server port). */
  start(listenPort: number): Promise<void>;

  /** Gracefully close all connections and the server. */
  stop(): Promise<void>;

  /** Return the nodeIds of all currently-connected peers. */
  connectedPeers(): string[];
}
