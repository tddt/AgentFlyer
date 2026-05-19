import { describe, expect, it } from 'vitest';
import type { ProcessId, SessionKey } from '../core/types.js';
import { deriveAgentTurnRunRecord, getAgentTurnCompletionOutcome } from './turn-run-state.js';

describe('turn-run-state lifecycle derivation', () => {
  it('keeps waiting snapshots active when persisted state is unavailable', () => {
    const record = deriveAgentTurnRunRecord(
      {
        pid: 'run-waiting' as ProcessId,
        status: 'waiting',
        createdAt: 1,
        updatedAt: 2,
        lastError: undefined,
        metadata: { agentId: 'agent-main' },
      },
      null,
    );

    expect(record.phase).toBe('running');
    expect(record.controlState).toBe('active');
  });

  it('lets ready process status override stale suspended state on resume', () => {
    const record = deriveAgentTurnRunRecord(
      {
        pid: 'run-restored' as ProcessId,
        status: 'ready',
        createdAt: 1,
        updatedAt: 2,
        lastError: undefined,
        metadata: { agentId: 'agent-main' },
      },
      {
        agentId: 'agent-main',
        threadKey: 'restore-thread',
        phase: 'suspended',
        controlState: 'suspended',
        result: undefined,
        error: undefined,
      },
    );

    expect(record.phase).toBe('suspended');
    expect(record.controlState).toBe('ready');
  });

  it('treats done controlState as authoritative for archived completion outcomes', () => {
    const outcome = getAgentTurnCompletionOutcome({
      processStatus: 'done',
      phase: 'running',
      controlState: 'done',
      result: {
        text: 'kernel hello',
        sessionKey: 'session:done-thread' as SessionKey,
        inputTokens: 1,
        outputTokens: 2,
      },
    });

    expect(outcome).toEqual({
      ok: true,
      result: {
        text: 'kernel hello',
        sessionKey: 'session:done-thread' as SessionKey,
        inputTokens: 1,
        outputTokens: 2,
      },
    });
  });
});
