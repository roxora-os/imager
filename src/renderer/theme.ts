// Theme: localStorage.theme is "light", "dark" or absent (follow the system).
export type Theme = 'system' | 'light' | 'dark';

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t);
  } catch { /* no storage */ }
  const dark = t === 'dark' || (t === 'system' && media().matches);
  document.documentElement.classList.toggle('pf-v6-theme-dark', dark);
}

export function followSystem(): void {
  media().addEventListener('change', () => { if (readTheme() === 'system') applyTheme('system'); });
}
