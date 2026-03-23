import { createPortal } from 'react-dom';
import type { ToastItem } from '../hooks/useToast.js';

const variantStyle: Record<string, string> = {
  success: 'ring-1 ring-emerald-500/30 text-emerald-100',
  error: 'ring-1 ring-red-500/30 text-red-100',
  info: 'ring-1 ring-white/[0.08] text-slate-100',
};

const variantBg: Record<string, string> = {
  success: 'rgba(6,40,28,0.96)',
  error: 'rgba(40,8,8,0.96)',
  info: 'rgba(15,18,30,0.96)',
};

const variantAccent: Record<string, string> = {
  success: '#10b981',
  error: '#ef4444',
  info: '#6366f1',
};

function ToastIcon({ variant }: { variant: string }) {
  if (variant === 'success')
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#10b981"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20,6 9,17 4,12" />
      </svg>
    );
  if (variant === 'error')
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ef4444"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#6366f1"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

interface Props {
  toasts: ToastItem[];
}

export function Toast({ toasts }: Props) {
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`
            flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium
            shadow-2xl pointer-events-auto af-slide-right
            ${variantStyle[t.variant] ?? variantStyle.info}
          `}
          style={{
            background: variantBg[t.variant] ?? variantBg.info,
            backdropFilter: 'blur(16px) saturate(180%)',
            borderLeft: `3px solid ${variantAccent[t.variant] ?? variantAccent.info}`,
          }}
        >
          <ToastIcon variant={t.variant} />
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
