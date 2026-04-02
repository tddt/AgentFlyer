import { useState } from 'react';
import { useLocale } from '../context/i18n.js';

interface Props {
  text: string;
  className?: string;
}

export function CopyButton({ text, className = '' }: Props) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const handleClick = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={handleClick}
      title={t('common.copy')}
      className={`text-[11px] px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 ring-1 ring-white/[0.07] transition-all duration-150 ${className}`}
    >
      {copied ? `✓ ${t('common.copied')}` : t('common.copy')}
    </button>
  );
}
