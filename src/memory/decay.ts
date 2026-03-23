/**
 * Time-decay scoring for memory entries.
 *
 * Uses exponential decay: score = baseScore × e^(-λ × age_days)
 * where λ = ln(2) / halfLifeDays (half-life formula)
 */
export function decayScore(
  baseScore: number,
  updatedAt: number,
  now: number,
  halfLifeDays: number,
): number {
  const ageDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
  const lambda = Math.LN2 / halfLifeDays;
  return baseScore * Math.exp(-lambda * ageDays);
}

/** Estimate effective age in days */
export function ageInDays(updatedAt: number, now = Date.now()): number {
  return (now - updatedAt) / (1000 * 60 * 60 * 24);
}

/** Multi-dimensional forgetting score — higher = more likely to be archived */
export interface ForgettingScore {
  /** Age-based decay (0–1, higher = older) */
  age: number;
  /** Days since last access (0–1, higher = longer gap) */
  accessGap: number;
  /** Whether this entry has been superseded by a newer version (0 or 1) */
  superseded: number;
  /** Inverse of user-assigned importance (0–1) */
  userImportance: number;
  /** Combined weighted score (0–1, higher = more forgettable) */
  combined: number;
}

export interface ForgettingContext {
  /** Task-relevant keywords to boost retention of matching entries */
  relevantKeywords?: string[];
}

/**
 * Compute a multi-factor forgetting score for a memory entry.
 * All component scores are in [0,1]; combined is a weighted average.
 */
export function computeForgettingScore(
  entry: {
    updatedAt: number;
    accessedAt: number;
    importance: number;
    superseded: boolean;
    content: string;
  },
  now = Date.now(),
  context?: ForgettingContext,
): ForgettingScore {
  const halfLife30 = 30;
  const halfLife90 = 90;

  const ageRaw = ageInDays(entry.updatedAt, now);
  const age = 1 - Math.exp((-Math.LN2 * ageRaw) / halfLife30);

  const accessGapDays = (now - entry.accessedAt) / (1000 * 60 * 60 * 24);
  const accessGap = 1 - Math.exp((-Math.LN2 * accessGapDays) / halfLife90);

  const supersededScore = entry.superseded ? 1 : 0;
  const userImportanceScore = 1 - Math.max(0, Math.min(1, entry.importance));

  // Task relevance: reduce forgetting score if content matches keywords
  let relevanceBoost = 0;
  if (context?.relevantKeywords?.length) {
    const lower = entry.content.toLowerCase();
    const hits = context.relevantKeywords.filter((k) => lower.includes(k.toLowerCase())).length;
    relevanceBoost = Math.min(0.4, hits * 0.1);
  }

  // Weighted combination: superseded is highest weight
  const combined = Math.max(
    0,
    0.25 * age +
      0.2 * accessGap +
      0.35 * supersededScore +
      0.2 * userImportanceScore -
      relevanceBoost,
  );

  return {
    age,
    accessGap,
    superseded: supersededScore,
    userImportance: userImportanceScore,
    combined: Math.min(1, combined),
  };
}

/** Return true if an entry should be archived (moved to cold storage) */
export function shouldArchive(score: ForgettingScore, threshold = 0.75): boolean {
  return score.combined >= threshold;
}
