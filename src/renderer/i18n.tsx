// The page's language: shared/i18n.ts with the page's messages, in a React
// context. The choice is kept in localStorage ("lang"); without one the
// system's languages decide.
import { createContext, useContext, useMemo, useState } from 'react';
import { pickLang, translateMessage, translator, type Lang, type T } from '../shared/i18n';
import { MESSAGE_PATTERNS, MESSAGES } from './messages';

interface I18n { lang: Lang; t: T; setLang(l: Lang): void; msg(english: string): string }

function stored(): string | null {
  try { return localStorage.getItem('lang'); } catch { return null; }
}

export function initialLang(): Lang {
  return pickLang(stored(), typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []);
}

const Ctx = createContext<I18n>({ lang: 'en', t: translator(MESSAGES, 'en'), setLang: () => {}, msg: (m) => m });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const value = useMemo<I18n>(() => ({
    lang,
    t: translator(MESSAGES, lang),
    setLang: (l) => {
      setLangState(l);
      try { localStorage.setItem('lang', l); } catch { /* no storage */ }
      document.documentElement.lang = l;
    },
    msg: (m) => translateMessage(m, MESSAGE_PATTERNS, lang),
  }), [lang]);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18n => useContext(Ctx);
