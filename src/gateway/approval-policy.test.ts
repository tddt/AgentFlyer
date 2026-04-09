import { describe, expect, it } from 'vitest';
import {
  resolveMcpApprovalModeForSandbox,
  resolveSandboxApprovalHandler,
} from './approval-policy.js';

describe('gateway approval policy', () => {
  it('denies approval by default for readonly-output sandbox agents', async () => {
    const handler = resolveSandboxApprovalHandler('readonly-output');

    expect(handler).toBeTypeOf('function');
    await expect(handler?.('bash', { command: 'pwd' })).resolves.toBe(false);
  });

  it('keeps sandbox approval open for non-readonly agents', () => {
    expect(resolveSandboxApprovalHandler(undefined)).toBeUndefined();
    expect(resolveSandboxApprovalHandler('restricted')).toBeUndefined();
  });

  it('promotes inherited MCP approval to always for readonly-output sandbox agents', () => {
    expect(
      resolveMcpApprovalModeForSandbox({
        sandboxProfile: 'readonly-output',
        toolApprovalMode: 'inherit',
      }),
    ).toBe('always');
  });

  it('preserves explicit MCP approval modes across sandbox profiles', () => {
    expect(
      resolveMcpApprovalModeForSandbox({
        sandboxProfile: 'readonly-output',
        toolApprovalMode: 'never',
      }),
    ).toBe('never');
    expect(
      resolveMcpApprovalModeForSandbox({
        sandboxProfile: 'restricted',
        toolApprovalMode: 'inherit',
      }),
    ).toBe('inherit');
  });
});
