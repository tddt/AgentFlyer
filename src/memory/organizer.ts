import type { LLMProvider } from '../agent/llm/provider.js';
/**
 * MemoryOrganizer — periodically summarizes episodic memories into semantic ones.
 *
 * Trigger model: every N conversation turns (default 20), scan recent episodic
 * entries and use an LLM to produce a structured summary that is written back
 * as a new semantic-partition entry.  The original entries are marked superseded.
 */
import { createLogger } from '../core/logger.js';
import type { AgentId } from '../core/types.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:organizer');

const ORGANIZE_EVERY_N_TURNS = 20;
const EPISODIC_PARTITION_PREFIX = 'episodic';
const SEMANTIC_PARTITION = 'semantic';
const MAX_ENTRIES_TO_SUMMARIZE = 10;

export class MemoryOrganizer {
  private turnsSinceLastOrganize = 0;

  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LLMProvider,
    private readonly agentId: AgentId,
  ) {}

  /**
   * Call once per conversation turn.
   * Triggers organization every ORGANIZE_EVERY_N_TURNS turns.
   */
  async maybeOrganize(): Promise<void> {
    this.turnsSinceLastOrganize++;
    if (this.turnsSinceLastOrganize < ORGANIZE_EVERY_N_TURNS) return;
    this.turnsSinceLastOrganize = 0;

    await this.organize();
  }

  /** Force an organization pass regardless of turn count. */
  async organize(): Promise<void> {
    logger.debug('Running memory organization pass', { agentId: this.agentId });

    // Collect recent episodic entries for this agent
    const episodic = this.store
      .listRecent(EPISODIC_PARTITION_PREFIX, MAX_ENTRIES_TO_SUMMARIZE * 3)
      .filter((e) => e.agentId === this.agentId && !e.superseded)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, MAX_ENTRIES_TO_SUMMARIZE);

    if (episodic.length < 3) {
      logger.debug('Not enough episodic entries to organize', { count: episodic.length });
      return;
    }

    const source = episodic.map((e, i) => `[${i + 1}] ${e.content}`).join('\n\n');
    const prompt = [
      'You are a memory distiller. Summarize the following episodic memories into a single, ',
      'concise semantic knowledge entry (max 300 words). ',
      'Focus on patterns, preferences, and durable facts. Discard transient/ephemeral details.\n\n',
      source,
    ].join('');

    let summary = '';
    try {
      const stream = this.llm.run({
        model: '',
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        maxTokens: 400,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') summary += chunk.text;
      }
    } catch (err) {
      logger.warn('LLM call for memory organization failed', { error: String(err) });
      return;
    }

    if (!summary.trim()) return;

    // Write consolidated entry to semantic partition
    this.store.upsert({
      key: `org-${Date.now()}`,
      agentId: this.agentId,
      partition: SEMANTIC_PARTITION,
      content: summary.trim(),
      tags: ['organized', 'semantic-summary'],
      source: 'organizer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      importance: 0.7,
      superseded: false,
    });

    // Mark source episodic entries as superseded
    for (const e of episodic) {
      this.store.markSuperseded(e.id);
    }

    logger.info('Memory organization complete', {
      agentId: this.agentId,
      summarized: episodic.length,
    });
  }
}
