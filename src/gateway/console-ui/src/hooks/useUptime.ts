import { useEffect, useRef, useState } from 'react';

/**
 * Returns a live HH:MM:SS string.
 * @param serverUptime — uptime in seconds reported by the server (recorded at `fetchedAt`)
 * @param fetchedAt   — Date.now() timestamp when `serverUptime` was obtained
 */
export function useUptime(serverUptime: number | null, fetchedAt: number | null): string {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<{ base: number; at: number } | null>(null);

  useEffect(() => {
    if (serverUptime === null || fetchedAt === null) return;
    startRef.current = { base: serverUptime, at: fetchedAt };
    setElapsed(0);
    const id = setInterval(() => {
      const ref = startRef.current;
      if (!ref) return;
      setElapsed(Math.floor((Date.now() - ref.at) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [serverUptime, fetchedAt]);

  if (serverUptime === null || fetchedAt === null) return '—';
  const total = Math.floor(serverUptime) + elapsed;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
