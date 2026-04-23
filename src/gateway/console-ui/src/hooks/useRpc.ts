import { useCallback, useEffect, useRef, useState } from 'react';

const BASE = window.location.origin;
const TOKEN = window.__AF_TOKEN__;

export async function rpc<T = unknown>(
  method: string,
  params?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export function useQuery<T>(
  fn: () => Promise<T>,
  // accepts either a dependency array or a polling interval in ms
  depsOrPollMs: unknown[] | number = [],
): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const deps = typeof depsOrPollMs === 'number' ? [] : depsOrPollMs;
  const pollMs = typeof depsOrPollMs === 'number' ? depsOrPollMs : 0;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    run();
    if (pollMs > 0) {
      const id = setInterval(run, pollMs);
      return () => clearInterval(id);
    }
  }, [...deps, run]);

  return { data, loading, error, refetch: run };
}
