import { describe, expect, it } from 'vitest';
import { ageInDays, computeForgettingScore, decayScore, shouldArchive } from '../../../src/memory/decay.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('decayScore', () => {
  it('returns baseScore when age is 0', () => {
    const now = Date.now();
    const result = decayScore(1, now, now, 30);
    expect(result).toBeCloseTo(1, 5);
  });

  it('returns ~0.5 × baseScore after one half-life', () => {
    const now = Date.now();
    const updatedAt = now - 30 * MS_PER_DAY;
    const result = decayScore(1, updatedAt, now, 30);
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.25 × baseScore after two half-lives', () => {
    const now = Date.now();
    const updatedAt = now - 60 * MS_PER_DAY;
    const result = decayScore(1, updatedAt, now, 30);
    expect(result).toBeCloseTo(0.25, 2);
  });

  it('scales linearly with baseScore', () => {
    const now = Date.now();
    const updatedAt = now - 15 * MS_PER_DAY;
    const score2 = decayScore(2, updatedAt, now, 30);
    const score1 = decayScore(1, updatedAt, now, 30);
    expect(score2).toBeCloseTo(2 * score1, 5);
  });

  it('uses the configured halfLifeDays correctly', () => {
    const now = Date.now();
    const updatedAt = now - 7 * MS_PER_DAY;
    const r7 = decayScore(1, updatedAt, now, 7);
    const r30 = decayScore(1, updatedAt, now, 30);
    // With a shorter half-life, the score decays faster → r7 < r30
    expect(r7).toBeLessThan(r30);
    expect(r7).toBeCloseTo(0.5, 2);
  });
});

describe('ageInDays', () => {
  it('returns 0 when updatedAt equals now', () => {
    const now = Date.now();
    expect(ageInDays(now, now)).toBe(0);
  });

  it('returns approximately 1 for a 24-hour-old entry', () => {
    const now = Date.now();
    expect(ageInDays(now - MS_PER_DAY, now)).toBeCloseTo(1, 5);
  });

  it('returns approximately 7 for a week-old entry', () => {
    const now = Date.now();
    expect(ageInDays(now - 7 * MS_PER_DAY, now)).toBeCloseTo(7, 5);
  });

  it('uses Date.now() by default', () => {
    const ts = Date.now() - MS_PER_DAY;
    const result = ageInDays(ts);
    expect(result).toBeGreaterThan(0.99);
    expect(result).toBeLessThan(1.01);
  });
});

describe('computeForgettingScore', () => {
  function freshEntry(overrides = {}) {
    const now = Date.now();
    return {
      updatedAt: now,
      accessedAt: now,
      importance: 0.5,
      superseded: false,
      content: 'some memory content',
      ...overrides,
    };
  }

  it('returns ForgettingScore with all fields in [0,1]', () => {
    const score = computeForgettingScore(freshEntry());
    for (const [k, v] of Object.entries(score)) {
      expect(v, `field ${k}`).toBeGreaterThanOrEqual(0);
      expect(v, `field ${k}`).toBeLessThanOrEqual(1);
    }
  });

  it('fresh entry with high importance has low combined score', () => {
    const score = computeForgettingScore(freshEntry({ importance: 1 }));
    expect(score.combined).toBeLessThan(0.3);
  });

  it('superseded entry has higher score than non-superseded', () => {
    const now = Date.now();
    const stale = computeForgettingScore(freshEntry({ superseded: true }));
    const fresh = computeForgettingScore(freshEntry({ superseded: false }));
    expect(stale.combined).toBeGreaterThan(fresh.combined);
    expect(stale.superseded).toBe(1);
  });

  it('old entry (30 days) has higher age score than new entry', () => {
    const now = Date.now();
    const oldScore = computeForgettingScore(freshEntry({ updatedAt: now - 30 * MS_PER_DAY }));
    const newScore = computeForgettingScore(freshEntry({ updatedAt: now }));
    expect(oldScore.age).toBeGreaterThan(newScore.age);
  });

  it('zero importance → userImportance score near 1', () => {
    const score = computeForgettingScore(freshEntry({ importance: 0 }));
    expect(score.userImportance).toBeCloseTo(1, 5);
  });

  it('full importance → userImportance score near 0', () => {
    const score = computeForgettingScore(freshEntry({ importance: 1 }));
    expect(score.userImportance).toBeCloseTo(0, 5);
  });

  it('relevantKeywords reduce the combined forgetting score', () => {
    const entry = freshEntry({
      content: 'machine learning neural networks',
      superseded: true,
    });
    const withKeywords = computeForgettingScore(entry, undefined, {
      relevantKeywords: ['machine', 'neural', 'learning'],
    });
    const withoutKeywords = computeForgettingScore(entry);
    expect(withKeywords.combined).toBeLessThan(withoutKeywords.combined);
  });

  it('non-matching keywords have no effect', () => {
    const entry = freshEntry({ content: 'irrelevant content' });
    const withKeywords = computeForgettingScore(entry, undefined, {
      relevantKeywords: ['quantum', 'physics'],
    });
    const withoutKeywords = computeForgettingScore(entry);
    expect(withKeywords.combined).toBeCloseTo(withoutKeywords.combined, 10);
  });
});

describe('shouldArchive', () => {
  it('returns true when combined score >= default threshold (0.75)', () => {
    const highScore = { age: 1, accessGap: 1, superseded: 1, userImportance: 1, combined: 0.8 };
    expect(shouldArchive(highScore)).toBe(true);
  });

  it('returns false when combined score < default threshold', () => {
    const lowScore = { age: 0.1, accessGap: 0.1, superseded: 0, userImportance: 0.1, combined: 0.3 };
    expect(shouldArchive(lowScore)).toBe(false);
  });

  it('uses a custom threshold', () => {
    const score = { age: 0.5, accessGap: 0.5, superseded: 0, userImportance: 0.5, combined: 0.6 };
    expect(shouldArchive(score, 0.5)).toBe(true);
    expect(shouldArchive(score, 0.7)).toBe(false);
  });
});
