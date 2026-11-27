// The page in English and Simplified Chinese: every text App.tsx passes to
// t() has a Chinese entry, the language follows the system unless chosen,
// and messages from the main process are shown in Chinese where known.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickLang, translateMessage, translator } from '../src/shared/i18n';
import { I18nProvider, msg } from '../src/renderer/i18n';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { MESSAGE_PATTERNS, MESSAGES } from '../src/renderer/messages';
import { STORAGES } from '../src/maskrom/boards';
import { MASKROM_BOARDS } from '../src/maskrom/boards';
import { FLAVOR_NAMES } from '../src/shared/catalog';
import { INTERNAL_WORDS } from '../src/shared/targets';

const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

/** The string literals in the first argument of every t(...) call (ternaries included). */
function keysUsed(src: string): string[] {
  const out: string[] = [];
  const re = /\bt\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + 2;
    let depth = 0;
    let arg = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        arg += src.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) break;
      arg += c;
    }
    for (const lit of arg.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
      const text = (lit[1] ?? lit[2]).replace(/\\(.)/g, '$1');
      if (/[A-Za-z]/.test(text) && !/^(sd|spi|file|update|release|emmc|ci|stable|prerelease|none)$/.test(text)) out.push(text);
    }
  }
  return [...new Set(out)];
}

describe('i18n', () => {
  it('follows the system language unless one was chosen', () => {
    expect(pickLang(null, ['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(pickLang(null, ['zh'])).toBe('zh-CN');
    expect(pickLang(null, ['zh-TW'])).toBe('en');
    expect(pickLang(null, ['de-DE', 'en-GB'])).toBe('en');
    expect(pickLang('en', ['zh-CN'])).toBe('en');
    expect(pickLang('fr', ['zh-CN'])).toBe('zh-CN');
  });

  it('has Chinese for every text the page passes to t()', () => {
    const used = keysUsed(app);
    expect(used.length).toBeGreaterThan(250);
    expect(used.filter((k) => !MESSAGES[k])).toEqual([]);
  });

  it('has Chinese for the texts the page builds from other modules', () => {
    const keys = [
      ...Object.values(STORAGES).flatMap((s) => [s.label, s.note]),
      ...MASKROM_BOARDS.flatMap((b) => (b.imageNote ? [b.imageNote] : [])),
      ...Object.values(FLAVOR_NAMES), ...Object.values(INTERNAL_WORDS),
      'Stable', 'Prerelease', 'CI', 'System', 'Light', 'Dark', 'Ubuntu', 'Desktop', 'Kernel', 'Size',
    ];
    expect(keys.filter((k) => !MESSAGES[k])).toEqual([]);
  });

  it('every entry has both languages, the same placeholders, and no dashes', () => {
    for (const [k, v] of Object.entries(MESSAGES)) {
      expect(v['zh-CN'], k).not.toBe('');
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      expect(ph(v['zh-CN']), k).toEqual(ph(v.en));
      expect(`${v.en}${v['zh-CN']}`, k).not.toMatch(/[–—]/);
    }
  });

  it('fills placeholders and translates known messages', () => {
    const t = translator(MESSAGES, 'zh-CN');
    expect(t('Write {device}', { device: '/dev/sdb' })).toBe('写入 /dev/sdb');
    expect(t('Something new.')).toBe('Something new.');
    expect(translateMessage('The board did not switch to eMMC. Nothing was written.', MESSAGE_PATTERNS, 'zh-CN')).toBe('开发板没有切换到 eMMC。没有写入任何内容。');
    expect(translateMessage('This update.img is for RK3588, not RK3576.', MESSAGE_PATTERNS, 'zh-CN')).toBe('这个 update.img 是给 RK3588 的，不是 RK3576。');
    expect(translateMessage('Something new.', MESSAGE_PATTERNS, 'zh-CN')).toBe('Something new.');
  });

  it('shows a main-process message sentence by sentence when it is not known whole', () => {
    // The provider sets the language from the stored choice.
    const store: Record<string, string> = { lang: 'zh-CN' };
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => store[k] ?? null, setItem: () => {} }, configurable: true });
    renderToString(createElement(I18nProvider, null, null));
    expect(msg('This update.img is for RK3588, not RK3576. Nothing was written.')).toBe('这个 update.img 是给 RK3588 的，不是 RK3576。没有写入任何内容。');
    expect(msg('No board in Maskrom mode was found.')).toBe('没有找到 Maskrom 模式的开发板。');
    expect(msg('The board was disconnected. It did not come back after the loader was sent.')).toBe('开发板已断开。发送引导组件后它没有重新连接上。');
    expect(msg('The board was disconnected. The eMMC is only partly written: run the same write again.')).toBe('开发板已断开。eMMC 只写入了一部分：请重新执行同样的写入。');
    expect(msg('Something new. And more.')).toBe('Something new. And more.');
  });
});
