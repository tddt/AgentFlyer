/**
 * Simple in-process metrics store.
 * Provides labelled counters and histograms consumable as Prometheus text format.
 *
 * RATIONALE: avoids a heavy otel-sdk dependency for the MVP; the collector
 * endpoint is exposed on GET /metrics and can be scraped by Prometheus / Grafana.
 */

type Labels = Record<string, string>;
type BucketKey = string; // JSON-serialised label set

interface CounterEntry {
  help: string;
  labels: Map<BucketKey, { labelValues: Labels; value: number }>;
}

interface HistogramEntry {
  help: string;
  buckets: number[]; // upper bounds (seconds)
  data: Map<BucketKey, { labelValues: Labels; sum: number; count: number; le: number[] }>;
}

// ── Global registry ───────────────────────────────────────────────────────────

const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();

function labelKey(labels: Labels): BucketKey {
  return JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  );
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function registerCounter(name: string, help: string): void {
  if (!counters.has(name)) {
    counters.set(name, { help, labels: new Map() });
  }
}

export function incCounter(name: string, labels: Labels = {}, amount = 1): void {
  const entry = counters.get(name);
  if (!entry) return;
  const key = labelKey(labels);
  const existing = entry.labels.get(key);
  if (existing) {
    existing.value += amount;
  } else {
    entry.labels.set(key, { labelValues: labels, value: amount });
  }
}

export function registerHistogram(
  name: string,
  help: string,
  buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): void {
  if (!histograms.has(name)) {
    histograms.set(name, { help, buckets, data: new Map() });
  }
}

export function observeHistogram(name: string, labels: Labels = {}, valueSeconds: number): void {
  const entry = histograms.get(name);
  if (!entry) return;
  const key = labelKey(labels);
  let row = entry.data.get(key);
  if (!row) {
    row = { labelValues: labels, sum: 0, count: 0, le: entry.buckets.map(() => 0) };
    entry.data.set(key, row);
  }
  row.sum += valueSeconds;
  row.count += 1;
  for (let i = 0; i < entry.buckets.length; i++) {
    if (valueSeconds <= (entry.buckets[i] ?? Infinity)) {
      (row.le[i] as number) += 1;
    }
  }
}

// ── Prometheus text format serialiser ────────────────────────────────────────

function labelsStr(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export function renderPrometheus(): string {
  const lines: string[] = [];

  for (const [name, entry] of counters) {
    lines.push(`# HELP ${name} ${entry.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const { labelValues, value } of entry.labels.values()) {
      lines.push(`${name}${labelsStr(labelValues)} ${value}`);
    }
    if (entry.labels.size === 0) {
      lines.push(`${name} 0`);
    }
  }

  for (const [name, entry] of histograms) {
    lines.push(`# HELP ${name} ${entry.help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const { labelValues, sum, count, le } of entry.data.values()) {
      const base = labelsStr(labelValues);
      const labelsWithoutBrace = Object.entries(labelValues)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      for (let i = 0; i < entry.buckets.length; i++) {
        const leLabel = labelsWithoutBrace
          ? `{${labelsWithoutBrace},le="${entry.buckets[i]}"}`
          : `{le="${entry.buckets[i]}"}`;
        lines.push(`${name}_bucket${leLabel} ${le[i] ?? 0}`);
      }
      const infLabel = labelsWithoutBrace
        ? `{${labelsWithoutBrace},le="+Inf"}`
        : `{le="+Inf"}`;
      lines.push(`${name}_bucket${infLabel} ${count}`);
      lines.push(`${name}_sum${base} ${sum}`);
      lines.push(`${name}_count${base} ${count}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── Default metric registrations ──────────────────────────────────────────────

registerCounter(
  'agentflyer_agent_runs_total',
  'Total agent turn runs by status (ok | error | suspended)',
);
registerCounter(
  'agentflyer_llm_tokens_total',
  'Total LLM tokens consumed by model and type (input | output)',
);
registerCounter(
  'agentflyer_tool_calls_total',
  'Total tool invocations by tool name and status (ok | error | denied)',
);
registerHistogram(
  'agentflyer_response_duration_seconds',
  'Agent turn end-to-end response time in seconds',
  [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
);
