import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickLang, translateMessage, translator } from '../src/shared/i18n';
import { MESSAGE_PATTERNS, MESSAGES } from '../src/renderer/messages';
import { FLAVOR_NAMES } from '../src/shared/catalog';
import { INTERNAL_WORDS } from '../src/shared/targets';
import { MASKROM_BOARDS, STORAGES } from '../src/maskrom/boards';

const src = (f: string) => readFileSync(join(__dirname, '..', 'src', 'renderer', f), 'utf8');

describe('i18n', () => {
  it('follows the system language unless one was chosen', () => {
    expect(pickLang(null, ['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(pickLang(null, ['zh'])).toBe('zh-CN');
    expect(pickLang(null, ['zh-TW'])).toBe('en');
    expect(pickLang(null, ['de-DE', 'en-GB'])).toBe('en');
    expect(pickLang('en', ['zh-CN'])).toBe('en');
    expect(pickLang('fr', ['zh-CN'])).toBe('zh-CN');
  });

  it('has every key the page uses, in both languages', () => {
    const used = new Set<string>();
    for (const m of src('App.tsx').matchAll(/\bt\('([a-zA-Z0-9.-]+)'/g)) used.add(m[1]);
    // Keys built from a value: one per value the code can have.
    for (const f of Object.keys(FLAVOR_NAMES)) used.add(`flavor.${f}`);
    for (const k of Object.keys(INTERNAL_WORDS)) used.add(`internal.${k}`);
    for (const s of Object.keys(STORAGES)) { used.add(`storage.${s}`); used.add(`storage.${s}.note`); }
    for (const b of MASKROM_BOARDS) if (b.imageNote) used.add(`imageNote.${b.board}`);
    for (const th of ['system', 'light', 'dark']) used.add(`settings.theme.${th}`);
    for (const st of ['download', 'check', 'decompress', 'write', 'verify']) used.add(`progress.${st}`);
    for (const st of ['brew-update', 'brew-upgrade', 'install']) used.add(`update.stage.${st}`);
    const missing = [...used].filter((k) => !MESSAGES[k]);
    expect(missing).toEqual([]);
    for (const [k, v] of Object.entries(MESSAGES)) {
      expect(v.en, k).not.toBe('');
      expect(v['zh-CN'], k).not.toBe('');
      expect(`${v.en}${v['zh-CN']}`, k).not.toMatch(/[\u2013\u2014]/);
      // The same placeholders in both languages.
      const vars = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(v['zh-CN']), k).toEqual(vars(v.en));
    }
  });

  it('says in English what the modules the words come from say', () => {
    for (const [f, en] of Object.entries(FLAVOR_NAMES)) expect(MESSAGES[`flavor.${f}`].en).toBe(en);
    for (const [k, en] of Object.entries(INTERNAL_WORDS)) expect(MESSAGES[`internal.${k}`].en).toBe(en);
    for (const s of Object.values(STORAGES)) {
      expect(MESSAGES[`storage.${s.id}`].en).toBe(s.label);
      expect(MESSAGES[`storage.${s.id}.note`].en).toBe(s.note);
    }
    for (const b of MASKROM_BOARDS) if (b.imageNote) expect(MESSAGES[`imageNote.${b.board}`].en).toBe(b.imageNote);
  });

  it('fills placeholders and translates known messages', () => {
    const t = translator(MESSAGES, 'zh-CN');
    expect(t('image.leadPlain', { board: 'Radxa ROCK 4D' })).toBe('Radxa ROCK 4D 的映像。');
    expect(translator(MESSAGES, 'en')('internal.use', { device: '/dev/sdb' })).toBe('Use /dev/sdb');
    expect(translateMessage('No board in Maskrom mode was found.', MESSAGE_PATTERNS, 'zh-CN')).toBe('没有找到 Maskrom 模式的开发板。');
    expect(translateMessage('SD card slot, in use: mounted at /, /boot', MESSAGE_PATTERNS, 'zh-CN')).toBe('内置 SD 卡槽，正在使用：挂载在 /, /boot');
    expect(translateMessage('system disk: holds /', MESSAGE_PATTERNS, 'zh-CN')).toBe('系统磁盘：包含 /');
    expect(translateMessage('Something new.', MESSAGE_PATTERNS, 'zh-CN')).toBe('Something new.');
    expect(translateMessage('No board in Maskrom mode was found.', MESSAGE_PATTERNS, 'en')).toBe('No board in Maskrom mode was found.');
  });

  it('has no Chinese without a pattern and no pattern without Chinese', () => {
    for (const [re, out] of MESSAGE_PATTERNS) {
      expect(out['zh-CN'], String(re)).not.toBe('');
      expect(out['zh-CN'], String(re)).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
