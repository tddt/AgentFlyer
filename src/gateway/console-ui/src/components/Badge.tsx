import type { ReactNode } from 'react'

const variantMap: Record<string, string> = {
  green:  'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  blue:   'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30',
  yellow: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  red:    'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  purple: 'bg-purple-500/15 text-purple-300 ring-1 ring-purple-500/30',
  gray:   'bg-slate-700/50 text-slate-400 ring-1 ring-slate-600/40',
}

interface Props {
  variant?: keyof typeof variantMap
  children: ReactNode
}

export function Badge({ variant = 'gray', children }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${variantMap[variant]}`}
    >
      {children}
    </span>
  )
}
