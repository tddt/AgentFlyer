import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'default' | 'primary' | 'danger' | 'ghost'
type Size = 'sm' | 'md'

const baseClass =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 disabled:opacity-50 disabled:pointer-events-none'

const variantClass: Record<Variant, string> = {
  primary:
    'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-md shadow-indigo-500/25 hover:shadow-indigo-500/35 focus-visible:ring-indigo-500',
  danger:
    'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-md shadow-red-500/20 hover:shadow-red-500/30 focus-visible:ring-red-400',
  default:
    'bg-slate-800 hover:bg-slate-700 text-slate-200 ring-1 ring-white/[0.08] hover:ring-white/[0.12] focus-visible:ring-slate-400',
  ghost:
    'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] focus-visible:ring-slate-400',
}

const sizeClass: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-4 py-2',
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

export function Button({ variant = 'default', size = 'md', className = '', ...rest }: Props) {
  return (
    <button
      {...rest}
      className={`${baseClass} ${variantClass[variant]} ${sizeClass[size]} ${className}`}
    />
  )
}
