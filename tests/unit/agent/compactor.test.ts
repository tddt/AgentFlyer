import { describe, expect, it } from 'vitest';
import {
  countTokensPrecise,
  estimateMessagesTokens,
  estimateTokens,
  remainingTokens,
} from '../../../src/agent/compactor/token-count.js';
import { buildSystemPrompt } from '../../../src/agent/prompt/builder.js';
import {
  layer0Identity,
  layer1Workspace,
  layer2Skills,
  layer3Memory,
  layer4Task,
} from '../../../src/agent/prompt/layers.js';
import type { Message } from '../../../src/core/types.js';

// ─── Token counting ──────────────────────────────────────────────────────────
describe('estimateTokens', () => {
  it('returns ceiling of length / 4', () => {
    expect(estimateTokens('abcd')).toBe(1); // 4 chars = 1 token
    expect(estimateTokens('abcde')).toBe(2); // 5 chars = ceil(1.25) = 2 tokens
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long strings', () => {
    const s = 'a'.repeat(400);
    expect(estimateTokens(s)).toBe(100);
  });
});

describe('estimateMessagesTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('sums token estimates + 4 overhead per message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'abcd' }, // 1 token + 4 = 5
      { role: 'assistant', content: 'xy' }, // ceil(0.5) = 1 token + 4 = 5
    ];
    // total: 5 + 5 = 10
    expect(estimateMessagesTokens(messages)).toBe(10);
  });

  it('handles array content by JSON-stringifying', () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const est = estimateMessagesTokens(messages);
    expect(est).toBeGreaterThan(0);
  });
});

describe('countTokensPrecise', () => {
  it('returns a positive integer', async () => {
    const n = await countTokensPrecise('Hello world from AgentFlyer!');
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it('returns more tokens for longer text', async () => {
    const short = await countTokensPrecise('hi');
    const long = await countTokensPrecise('hello world how are you today');
    expect(long).toBeGreaterThan(short);
  });
});

describe('remainingTokens', () => {
  it('returns contextWindow - used', () => {
    expect(remainingTokens(1000, 8000)).toBe(7000);
  });

  it('clamps to 0 when over limit', () => {
    expect(remainingTokens(10000, 8000)).toBe(0);
  });
});

// ─── Prompt builder ──────────────────────────────────────────────────────────
describe('buildSystemPrompt', () => {
  it('joins non-empty layers sorted by id', () => {
    const layers = [
      layer0Identity('TestAgent', 'test-id'),
      layer1Workspace('# Workspace docs'),
      layer4Task('Summarise this text.'),
    ];
    const result = buildSystemPrompt(layers);
    expect(result.systemPrompt).toContain('TestAgent');
    expect(result.systemPrompt).toContain('Workspace docs');
    expect(result.systemPrompt).toContain('Summarise this text');
    // layers should appear in ascending id order
    const idxIdentity = result.systemPrompt.indexOf('TestAgent');
    const idxWorkspace = result.systemPrompt.indexOf('Workspace docs');
    const idxTask = result.systemPrompt.indexOf('Summarise');
    expect(idxIdentity).toBeLessThan(idxWorkspace);
    expect(idxWorkspace).toBeLessThan(idxTask);
  });

  it('excludes empty content layers', () => {
    const layers = [
      layer0Identity('A', 'a'),
      layer2Skills(''), // empty — should be excluded
      layer4Task('task text'),
    ];
    const result = buildSystemPrompt(layers);
    expect(result.layers).toHaveLength(2); // only non-empty
  });

  it('trims trimable layers when over budget', () => {
    const bigContent = 'word '.repeat(3000); // ~3000 words → ~750 tokens estimate
    const layers = [
      layer0Identity('Agent', 'id'), // trimable=false
      layer3Memory(bigContent), // trimable=true, large
      layer4Task('small task'), // trimable=true
    ];
    // Very tight budget to force trimming
    const result = buildSystemPrompt(layers, 100);
    // identity layer must survive (not trimable)
    expect(result.systemPrompt).toContain('Agent');
    // trimmable big layer should be removed
    expect(result.layers.length).toBeLessThan(3);
  });

  it('never trims layer 0 (identity)', () => {
    const layers = [layer0Identity('KeepMe', 'id'), layer3Memory('a '.repeat(5000))];
    const result = buildSystemPrompt(layers, 10); // impossibly tight
    expect(result.systemPrompt).toContain('KeepMe');
  });

  it('returns estimatedTokens in result', () => {
    const layers = [layer0Identity('A', 'a'), layer4Task('task')];
    const result = buildSystemPrompt(layers);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

// ─── Layer factories ─────────────────────────────────────────────────────────
describe('prompt layer factories', () => {
  it('layer0Identity has id=0 and trimable=false', () => {
    const l = layer0Identity('Bot', 'bot-1');
    expect(l.id).toBe(0);
    expect(l.trimable).toBe(false);
    expect(l.content).toContain('Bot');
    expect(l.content).toContain('bot-1');
  });

  it('layer1Workspace has id=1', () => {
    const l = layer1Workspace('doc content');
    expect(l.id).toBe(1);
    expect(l.content).toBe('doc content');
  });

  it('layer2Skills has id=2 and trimable=true', () => {
    const l = layer2Skills('skills text');
    expect(l.id).toBe(2);
    expect(l.trimable).toBe(true);
  });

  it('layer3Memory has id=3 and trimable=true', () => {
    const l = layer3Memory('memory content');
    expect(l.id).toBe(3);
    expect(l.trimable).toBe(true);
  });

  it('layer4Task has id=4', () => {
    const l = layer4Task('do something');
    expect(l.id).toBe(4);
    expect(l.content).toContain('do something');
  });
});
