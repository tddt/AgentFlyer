import { describe, expect, it } from 'vitest';
import { getMcpDiagnosticHint } from './mcp-diagnostic-hints.js';

describe('getMcpDiagnosticHint', () => {
  it('returns actionable hint text for known MCP transport errors', () => {
    expect(getMcpDiagnosticHint('STDIO_FRAME_INVALID')).toEqual({
      title: 'Verify MCP stdio framing',
      description:
        'The launched process is not speaking MCP stdio correctly. Run it manually and confirm it emits Content-Length framed JSON-RPC messages.',
    });

    expect(getMcpDiagnosticHint('SSE_CONNECT_HTTP')).toEqual({
      title: 'Check stream reachability',
      description:
        'The gateway could not open the SSE stream successfully. Verify the URL, auth requirements, and that the endpoint returns HTTP 200 with text/event-stream.',
    });
  });

  it('returns null for unknown or missing MCP error codes', () => {
    expect(getMcpDiagnosticHint()).toBeNull();
    expect(getMcpDiagnosticHint('OTHER_ERROR')).toBeNull();
  });
});
