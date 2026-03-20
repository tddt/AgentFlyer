import { useCallback, useEffect, useRef, useState } from 'react'

const BASE = `http://127.0.0.1:${window.__AF_PORT__}`
const TOKEN = window.__AF_TOKEN__

export async function rpc<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ id: 1, method, params }),
    signal,
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const json = (await res.json()) as { result?: T; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

export function useQuery<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(() => {
    setLoading(true)
    setError(null)
    fnRef
      .current()
      .then((d) => {
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run() }, [...deps, run])

  return { data, loading, error, refetch: run }
}
