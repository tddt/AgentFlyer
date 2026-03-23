export { createGatewayServer, type GatewayServer, type GatewayServerOptions } from './server.js';
export {
  startGateway,
  isGatewayRunning,
  GATEWAY_VERSION,
  type GatewayInstance,
  type GatewayState,
} from './lifecycle.js';
export { validateToken, generateToken } from './auth.js';
export { dispatchRpc, type RpcRequest, type RpcResponse, type RpcContext } from './rpc.js';
export { HookRegistry, type LifecycleEvent, type HookHandler } from './hooks.js';
