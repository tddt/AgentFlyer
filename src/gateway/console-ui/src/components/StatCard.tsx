const ACCENT_META: Record<string, { bar: string; glow: string }> = {
  'text-indigo-400': { bar: '#6366f1', glow: 'rgba(99,102,241,0.07)' },
  'text-emerald-400': { bar: '#10b981', glow: 'rgba(16,185,129,0.07)' },
  'text-blue-400': { bar: '#3b82f6', glow: 'rgba(59,130,246,0.07)' },
  'text-violet-400': { bar: '#8b5cf6', glow: 'rgba(139,92,246,0.07)' },
  'text-amber-400': { bar: '#f59e0b', glow: 'rgba(245,158,11,0.07)' },
  'text-slate-300': { bar: '#94a3b8', glow: 'rgba(148,163,184,0.05)' },
  // theme-aware accent aliases
  accent: { bar: 'var(--af-accent)', glow: 'var(--af-accent-soft)' },
};

interface Props {
  label: string;
  value: string | number;
  accent?: string;
  /** When true, uses CSS-variable accent colors instead of fixed Tailwind class */
  useThemeAccent?: boolean;
}

export function StatCard({ label, value, accent = 'text-indigo-400', useThemeAccent = false }: Props) {
  if (useThemeAccent) {
    return (
      <div
        className="relative rounded-xl p-5 flex flex-col gap-2.5 overflow-hidden transition-all duration-200"
        style={{
          background: 'var(--af-card-bg)',
          boxShadow: '0 0 0 1px var(--af-card-ring)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 1px var(--af-card-ring-hover)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 1px var(--af-card-ring)'; }}
      >
        <span
          className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl"
          style={{ background: 'var(--af-accent)', opacity: 0.75 }}
        />
        <span style={{ color: 'var(--af-text-muted)' }} className="text-[10.5px] font-semibold uppercase tracking-[0.1em]">
          {label}
        </span>
        <span style={{ color: 'var(--af-accent)' }} className="text-[26px] font-bold tabular-nums leading-none">{value}</span>
      </div>
    );
  }
  const meta = ACCENT_META[accent] ?? ACCENT_META['text-indigo-400'];
  return (
    <div
      className="relative rounded-xl ring-1 ring-white/[0.07] p-5 flex flex-col gap-2.5 overflow-hidden
        hover:ring-white/[0.11] transition-all duration-200"
      style={{ background: `linear-gradient(145deg, ${meta.glow} 0%, rgba(14,17,28,0.95) 100%)` }}
    >
      <span
        className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl"
        style={{ background: meta.bar, opacity: 0.65 }}
      />
      <span className="text-[10.5px] font-semibold text-slate-500 uppercase tracking-[0.1em]">
        {label}
      </span>
      <span className={`text-[26px] font-bold tabular-nums leading-none ${accent}`}>{value}</span>
    </div>
  );
}
