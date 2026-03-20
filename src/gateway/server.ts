import * as http from 'node:http';
import * as net from 'node:net';
import { createLogger } from '../core/logger.js';
import { routeRequest } from './router.js';
import type { RouterOptions } from './router.js';
import type { LogBroadcaster } from './log-buffer.js';

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
}

function bindAddress(mode: GatewayServerOptions['bind']): string {
  if (mode === 'loopback') return '127.0.0.1';
  if (mode === 'local') return '0.0.0.0';
  // tailscale: look up *ts.net address or fall back
  return process.env['TAILSCALE_ADDR'] ?? '100.64.0.0';
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
        server.close((err) => {
          if (err) { reject(err); return; }
          logger.info('Gateway server stopped');
          resolve();
        });
      });
    },
  };
}
