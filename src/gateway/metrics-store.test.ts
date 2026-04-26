import { afterEach, describe, expect, it } from 'vitest';
import {
  incCounter,
  observeHistogram,
  registerCounter,
  registerHistogram,
  renderPrometheus,
} from './metrics-store.js';

// metrics-store uses module-level maps — reset between tests by
// registering fresh names to avoid cross-test contamination.

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}_test_${++seq}`;
}

afterEach(() => {
  // The store has no public reset; use unique names to avoid bleed-over.
});

describe('registerCounter + incCounter', () => {
  it('records a counter increment', () => {
    const name = uid('http_requests');
    registerCounter(name, 'Total HTTP requests');
    incCounter(name, { method: 'GET', status: '200' });
    const output = renderPrometheus();
    expect(output).toContain(`# HELP ${name} Total HTTP requests`);
    expect(output).toContain(`# TYPE ${name} counter`);
    expect(output).toContain('method="GET"');
  });

  it('accumulates increments on the same label set', () => {
    const name = uid('rpc_calls');
    registerCounter(name, 'RPC calls');
    incCounter(name, { op: 'chat' }, 3);
    incCounter(name, { op: 'chat' }, 2);
    const output = renderPrometheus();
    expect(output).toContain(`${name}{op="chat"} 5`);
  });

  it('emits zero when no labels recorded', () => {
    const name = uid('uptime');
    registerCounter(name, 'Uptime counter');
    const output = renderPrometheus();
    expect(output).toContain(`${name} 0`);
  });

  it('silently ignores incCounter for unknown metric', () => {
    expect(() => incCounter('nonexistent_counter_xyz')).not.toThrow();
  });

  it('does not re-register if counter already exists', () => {
    const name = uid('idempotent');
    registerCounter(name, 'First help text');
    registerCounter(name, 'Should be ignored');
    incCounter(name, {}, 1);
    const output = renderPrometheus();
    expect(output).toContain('First help text');
  });
});

describe('registerHistogram + observeHistogram', () => {
  it('records histogram observations', () => {
    const name = uid('request_duration');
    registerHistogram(name, 'Request latency');
    observeHistogram(name, { route: '/api' }, 0.05);
    const output = renderPrometheus();
    expect(output).toContain(`# HELP ${name} Request latency`);
    expect(output).toContain(`# TYPE ${name} histogram`);
    expect(output).toContain(`${name}_count`);
    expect(output).toContain(`${name}_sum`);
  });

  it('correctly classifies values into le buckets', () => {
    const name = uid('latency_buckets');
    registerHistogram(name, 'Latency', [0.01, 0.1, 1]);
    observeHistogram(name, {}, 0.05); // should fall in 0.1 and 1 buckets
    const output = renderPrometheus();
    expect(output).toContain(`{le="0.1"} 1`);
    expect(output).toContain(`{le="+Inf"} 1`);
    expect(output).toContain(`{le="0.01"} 0`);
  });

  it('silently ignores observeHistogram for unknown metric', () => {
    expect(() => observeHistogram('nonexistent_histogram_xyz', {}, 1.0)).not.toThrow();
  });

  it('does not re-register if histogram already exists', () => {
    const name = uid('idem_histogram');
    registerHistogram(name, 'First help');
    registerHistogram(name, 'Should be ignored');
    const output = renderPrometheus();
    expect(output).toContain('First help');
  });
});
