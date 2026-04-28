import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const baseClass =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none';

// Tailwind JIT doesn't see CSS-variable-based classes, so we apply theme colors via inline styles.
type VariantStyle = { className: string; style: CSSProperties };

const variantMeta: Record<Variant, VariantStyle> = {
  primary: {
    className: 'shadow-md active:opacity-90',
    style: {
      background: 'var(--af-btn-primary-bg)',
      color: 'var(--af-btn-primary-text)',
      boxShadow: '0 4px 14px var(--af-btn-primary-shadow)',
    },
  },
  danger: {
    className: 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-md shadow-red-500/20 hover:shadow-red-500/30 focus-visible:ring-red-400',
    style: {},
  },
  default: {
    className: 'ring-1 transition-colors',
    style: {
      background: 'var(--af-btn-default-bg)',
      color: 'var(--af-btn-default-text)',
      boxShadow: '0 0 0 1px var(--af-btn-default-ring)',
    },
  },
  ghost: {
    className: 'transition-colors',
    style: {
      color: 'var(--af-text-muted)',
    },
  },
};

const sizeClass: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-4 py-2',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({ variant = 'default', size = 'md', className = '', style: styleProp, ...rest }: Props) {
  const meta = variantMeta[variant];
  return (
    <button
      {...rest}
      style={{ ...meta.style, ...styleProp }}
      className={`${baseClass} ${meta.className} ${sizeClass[size]} ${className}`}
    />
  );
}
