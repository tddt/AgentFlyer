export interface McpDiagnosticHint {
  title: string;
  description: string;
}

export function getMcpDiagnosticHint(errorCode?: string): McpDiagnosticHint | null {
  switch (errorCode) {
    case 'UNKNOWN_TRANSPORT':
      return {
        title: 'Unsupported transport',
        description:
          'Switch this server to stdio or upgrade the runtime if you expect this transport to be supported.',
      };
    case 'STDIO_COMMAND_MISSING':
      return {
        title: 'Set the launch command',
        description:
          'Add the MCP server command in config so the gateway can start the child process.',
      };
    case 'STDIO_FRAME_INVALID':
      return {
        title: 'Verify MCP stdio framing',
        description:
          'The launched process is not speaking MCP stdio correctly. Run it manually and confirm it emits Content-Length framed JSON-RPC messages.',
      };
    case 'STDIO_PROCESS_EXIT':
      return {
        title: 'Inspect the child process',
        description:
          'The MCP subprocess exited during startup or request handling. Check command args, environment variables, and the server stderr output.',
      };
    case 'STDIO_REQUEST_TIMEOUT':
      return {
        title: 'Increase timeout or inspect startup',
        description:
          'The stdio server did not answer in time. Confirm initialize completes and raise timeoutMs if startup is expected to be slow.',
      };
    case 'SSE_URL_MISSING':
      return {
        title: 'Set the SSE URL',
        description:
          'Provide the SSE endpoint URL in config so the gateway can connect to the remote MCP stream.',
      };
    case 'SSE_CONNECT_HTTP':
      return {
        title: 'Check stream reachability',
        description:
          'The gateway could not open the SSE stream successfully. Verify the URL, auth requirements, and that the endpoint returns HTTP 200 with text/event-stream.',
      };
    case 'SSE_CONNECT_NO_BODY':
      return {
        title: 'Verify stream response body',
        description:
          'The SSE endpoint returned a response without an event stream body. Confirm the server keeps the stream open and sends events.',
      };
    case 'SSE_ENDPOINT_INVALID':
      return {
        title: 'Fix endpoint handshake event',
        description:
          'The remote server emitted an invalid endpoint event. Confirm it publishes a valid relative or absolute POST target for MCP messages.',
      };
    case 'SSE_REQUEST_HTTP':
      return {
        title: 'Check message POST endpoint',
        description:
          'The negotiated SSE message endpoint rejected a request. Verify the endpoint accepts MCP JSON-RPC POST traffic and required auth headers.',
      };
    case 'SSE_REQUEST_TIMEOUT':
      return {
        title: 'Request timed out',
        description:
          'The remote MCP server did not answer in time. Check upstream latency and increase timeoutMs if the operation is expected to be slow.',
      };
    case 'SSE_NOTIFY_HTTP':
      return {
        title: 'Initialized notify failed',
        description:
          'The remote server rejected the initialized notification. Verify the MCP SSE implementation accepts post-initialize notifications on the negotiated endpoint.',
      };
    case 'SSE_STREAM_CLOSED':
      return {
        title: 'Reconnect or inspect remote server',
        description:
          'The SSE stream closed unexpectedly. Check remote server logs, network proxies, and any idle timeout between the gateway and MCP host.',
      };
    default:
      return null;
  }
}
