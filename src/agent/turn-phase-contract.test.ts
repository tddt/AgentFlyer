import { describe, expect, it } from 'vitest';
import {
  deriveAgentTurnControlStateForPhase,
  deriveRunnerLeaseModeForAgentTurnPhase,
  fallbackAgentTurnPhaseForProcessStatus,
} from './turn-phase-contract.js';

describe('turn-phase-contract', () => {
  it('maps phase controlState and lease mode through one shared contract', () => {
    expect(deriveAgentTurnControlStateForPhase('pending')).toBe('queued');
    expect(deriveRunnerLeaseModeForAgentTurnPhase('pending')).toBe('idle');

    expect(deriveAgentTurnControlStateForPhase('running')).toBe('active');
    expect(deriveRunnerLeaseModeForAgentTurnPhase('running')).toBe('kernel');

    expect(deriveAgentTurnControlStateForPhase('waiting_tool')).toBe('active');
    expect(deriveRunnerLeaseModeForAgentTurnPhase('waiting_tool')).toBe('kernel');

    expect(deriveAgentTurnControlStateForPhase('suspended')).toBe('suspended');
    expect(deriveRunnerLeaseModeForAgentTurnPhase('suspended')).toBe('kernel');

    expect(deriveAgentTurnControlStateForPhase('done')).toBe('done');
    expect(deriveRunnerLeaseModeForAgentTurnPhase('done')).toBe('idle');
  });

  it('falls back from process status to a non-poisoning phase', () => {
    expect(fallbackAgentTurnPhaseForProcessStatus('ready')).toBe('pending');
    expect(fallbackAgentTurnPhaseForProcessStatus('running')).toBe('running');
    expect(fallbackAgentTurnPhaseForProcessStatus('waiting')).toBe('running');
    expect(fallbackAgentTurnPhaseForProcessStatus('suspended')).toBe('suspended');
    expect(fallbackAgentTurnPhaseForProcessStatus('done')).toBe('done');
    expect(fallbackAgentTurnPhaseForProcessStatus('error')).toBe('error');
  });
});
