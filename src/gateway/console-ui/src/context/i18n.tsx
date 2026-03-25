import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { en } from '../locales/en.js';
import { zh } from '../locales/zh.js';

export type Locale = 'en' | 'zh';

const LOCALE_KEY = 'af-locale';
const TRANSLATIONS: Record<Locale, Record<string, string>> = { en, zh };

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => undefined,
  t: (k) => k,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_KEY) : null;
    return stored === 'en' || stored === 'zh' ? stored : 'en';
  });

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(LOCALE_KEY, l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const dict = TRANSLATIONS[locale];
      const fallback = TRANSLATIONS.en;
      const str = dict[key] ?? fallback[key] ?? key;
      return interpolate(str, vars);
    },
    [locale],
  );

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
