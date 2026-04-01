import * as http from 'node:http';
import type * as net from 'node:net';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { createLogger } from '../core/logger.js';
import type { IntentRouter } from './intent-router.js';
import type { LogBroadcaster } from './log-buffer.js';
import { routeRequest } from './router.js';
import type { RouterOptions } from './router.js';

const logger = createLogger('gateway:server');

export interface GatewayServerOptions {
  port: number;
  /** 'loopback' = 127.0.0.1 only, 'local' = 0.0.0.0, 'tailscale' = TS address */
  bind: 'loopback' | 'local' | 'tailscale';
  authToken: string;
  rpcContext: RouterOptions['rpcContext'];
  logBroadcaster: LogBroadcaster;
  /** Webhook endpoint handlers for webhook-based channels (Feishu, QQ, etc.). */
  webhookHandlers?: RouterOptions['webhookHandlers'];
  /** Optional E6 intent router for automatic agent selection. */
  intentRouter?: IntentRouter;
  /**
   * Optional WebSocket connection handler. When provided, the server handles
   * upgrade requests at `/ws/chat` and passes each accepted WS connection here.
   * The handler is responsible for auth (token is in the URL query string).
   */
  wsHandler?: (ws: WebSocket, req: http.IncomingMessage) => void;
}

function bindAddress(mode: GatewayServerOptions['bind']): string {
  if (mode === 'loopback') return '127.0.0.1';
  if (mode === 'local') return '0.0.0.0';
  // tailscale: look up *ts.net address or fall back
  return process.env.TAILSCALE_ADDR ?? '100.64.0.0';
}

export interface GatewayServer {
  start(): Promise<{ port: number; address: string }>;
  stop(): Promise<void>;
}

export function createGatewayServer(opts: GatewayServerOptions): GatewayServer {
  const routerOpts: RouterOptions = {
    authToken: opts.authToken,
    rpcContext: opts.rpcContext,
    logBroadcaster: opts.logBroadcaster,
    port: opts.port,
    webhookHandlers: opts.webhookHandlers,
    intentRouter: opts.intentRouter,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await routeRequest(req, res, routerOpts);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      logger.error('Unhandled request error', { url: req.url, error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  // Attach WebSocket upgrade handler when a wsHandler is provided.
  // RATIONALE: use noServer mode so the WS server doesn't bind its own port;
  // it piggybacks on the existing http.Server for a single-port setup.
  let wss: WebSocketServer | null = null;
  if (opts.wsHandler) {
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      if (url === '/ws/chat' || url.startsWith('/ws/chat?')) {
        wss!.handleUpgrade(req, socket, head, (ws) => {
          opts.wsHandler!(ws, req);
        });
      } else {
        // Reject unrecognised upgrade paths cleanly.
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        const addr = bindAddress(opts.bind);
        server.listen(opts.port, addr, () => {
          const bound = server.address() as net.AddressInfo;
          logger.info('Gateway server listening', { address: addr, port: bound.port });
          resolve({ port: bound.port, address: addr });
        });
        server.once('error', reject);
      });
    },

    stop() {
      return new Promise((resolve, reject) => {
        // Close the WS server first (stops accepting new connections).
        wss?.close();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          logger.info('Gateway server stopped');
          resolve();
        });
      });
    },
  };
}
