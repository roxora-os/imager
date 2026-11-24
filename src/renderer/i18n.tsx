// The page's language: shared/i18n.ts with the page's messages. The choice
// is kept in localStorage ("lang"); without one the system's languages
// decide. t() and msg() read the current language, so plain functions can
// use them too; the App subscribes with useI18n(), which re-renders the
// page when the language changes.
import { createContext, useContext, useMemo, useState } from 'react';
import { pickLang, translateMessage, translator, type Lang, type T } from '../shared/i18n';
import { MESSAGE_PATTERNS, MESSAGES } from './messages';

let current: Lang = 'en';
let tr: T = translator(MESSAGES, current);

/** The page's text in the current language: the key is the English text, {name} placeholders filled from `vars`. */
export const t: T = (key, vars) => tr(key, vars);
/** A message from the main process or the Maskrom worker (English), in the current language where a pattern knows it. */
export function msg(english: string): string {
  if (current === 'en') return english;
  const one = (x: string) => MESSAGES[x]?.[current] || translateMessage(x, MESSAGE_PATTERNS, current);
  const whole = one(english);
  if (whole !== english) return whole;
  // Else sentence by sentence: "This update.img is for RK3588, not RK3576. Nothing was written."
  const parts = english.split(/(?<=\.) (?=[A-Z])/);
  const done = parts.map(one);
  return done.some((x, i) => x !== parts[i]) ? done.join(current === 'zh-CN' ? '' : ' ') : english;
}
export const lang = (): Lang => current;

function stored(): string | null {
  try { return localStorage.getItem('lang'); } catch { return null; }
}

export function initialLang(): Lang {
  return pickLang(stored(), typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []);
}

function use(l: Lang) {
  current = l;
  tr = translator(MESSAGES, l);
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

interface I18n { lang: Lang; setLang(l: Lang): void }
const Ctx = createContext<I18n>({ lang: 'en', setLang: () => {} });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [l, setL] = useState<Lang>(() => { const x = initialLang(); use(x); return x; });
  use(l);
  const value = useMemo<I18n>(() => ({
    lang: l,
    setLang: (x) => {
      use(x);
      setL(x);
      try { localStorage.setItem('lang', x); } catch { /* no storage */ }
    },
  }), [l]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18n => useContext(Ctx);
