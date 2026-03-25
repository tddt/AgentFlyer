import { marked } from 'marked';
import { useCallback, useMemo, useState } from 'react';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import type { DocContent } from '../types.js';

// Configure marked for safe, consistent rendering
marked.use({
  gfm: true,
  breaks: false,
});

export function DocsTab() {
  const { t } = useLocale();
  const [lang, setLang] = useState<'en' | 'zh'>('en');
  const docName = lang === 'en' ? 'README.md' : 'README_CN.md';

  // Intercept clicks on doc-internal file links (README.md / README_CN.md)
  // so they switch language instead of triggering browser navigation.
  const handleDocClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as Element).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (href === 'README_CN.md') {
      e.preventDefault();
      setLang('zh');
    } else if (href === 'README.md') {
      e.preventDefault();
      setLang('en');
    }
  }, []);

  const {
    data: docData,
    loading,
    error,
  } = useQuery<DocContent | null>(() => rpc<DocContent>('docs.get', { name: docName }), [lang]);

  const htmlContent = useMemo(() => {
    if (!docData?.content) return '';
    return marked.parse(docData.content) as string;
  }, [docData?.content]);

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-100">{t('docs.title')}</h1>
          <p className="text-[13px] text-slate-500 mt-0.5">{t('docs.subtitle')}</p>
        </div>
        {/* Language toggle */}
        <div className="flex items-center gap-1 mt-0.5">
          <button
            onClick={() => setLang('en')}
            className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors"
            style={
              lang === 'en'
                ? {
                    background: 'rgba(99,102,241,0.25)',
                    color: '#a5b4fc',
                    border: '1px solid rgba(99,102,241,0.4)',
                  }
                : {
                    background: 'transparent',
                    color: '#64748b',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }
            }
          >
            EN
          </button>
          <button
            onClick={() => setLang('zh')}
            className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors"
            style={
              lang === 'zh'
                ? {
                    background: 'rgba(99,102,241,0.25)',
                    color: '#a5b4fc',
                    border: '1px solid rgba(99,102,241,0.4)',
                  }
                : {
                    background: 'transparent',
                    color: '#64748b',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }
            }
          >
            中文
          </button>
        </div>
      </div>

      <div
        className="rounded-2xl"
        style={{
          border: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(255,255,255,0.015)',
        }}
      >
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 px-5 py-5">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
            {t('docs.loading')}
          </div>
        )}

        {error && <div className="px-5 py-4 text-sm text-red-400">{error}</div>}

        {docData && (
          <>
            <div
              className="px-5 py-3 flex items-center gap-2"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
            >
              <svg
                className="text-slate-500 shrink-0"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14,2 14,8 20,8" />
              </svg>
              <span className="text-[13px] text-slate-400 font-mono">{docName}</span>
            </div>
            {/* eslint-disable-next-line react/no-danger -- content comes from trusted local file only */}
            <div
              className="doc-prose px-6 py-5 overflow-auto max-h-[calc(100vh-220px)]"
              onClick={handleDocClick}
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          </>
        )}
      </div>
    </div>
  );
}
