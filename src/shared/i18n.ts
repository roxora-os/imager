// A small translation helper: no dependencies, no React.
//
// A dictionary maps a key to its text in each language, side by side, so a
// missing translation shows in review and in test/i18n.test.ts. Text may
// hold {name} placeholders. The language follows the system (the browser's
// navigator.languages, which Electron fills from the OS) unless the user
// chose one, which the page keeps in localStorage.

export type Lang = 'en' | 'zh-CN';
export const LANGS: Lang[] = ['en', 'zh-CN'];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', 'zh-CN': '简体中文' };

export type Dict = Record<string, Record<Lang, string>>;

/** The language to use: the stored choice if valid, else the first system language we have. */
export function pickLang(stored: string | null | undefined, system: readonly string[]): Lang {
  if (stored && (LANGS as string[]).includes(stored)) return stored as Lang;
  for (const l of system) {
    const low = l.toLowerCase();
    if (low.startsWith('zh')) return low.includes('tw') || low.includes('hk') || low.includes('hant') ? 'en' : 'zh-CN';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

export function format(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type T = (key: string, vars?: Record<string, string | number>) => string;

export function translator(dict: Dict, lang: Lang): T {
  return (key, vars) => {
    const e = dict[key];
    if (!e) return format(key, vars);
    return format(e[lang] || e.en, vars);
  };
}

/**
 * Messages that come from code shared with the command line or the board
 * (English sentences), shown in the page's language where a pattern knows
 * them; anything unknown stays as it came.
 */
export function translateMessage(msg: string, patterns: Array<[RegExp, Record<Lang, string>]>, lang: Lang): string {
  if (lang === 'en') return msg;
  for (const [re, out] of patterns) {
    const m = re.exec(msg);
    if (m) return out[lang].replace(/\$(\d)/g, (_x, n: string) => m[Number(n)] ?? '');
  }
  return msg;
}
