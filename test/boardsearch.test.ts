import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matches, squash, vendorCounts, visibleBoards } from '../src/shared/boardsearch';
import { groupByBoard, parseCatalog, vendorFallback } from '../src/shared/catalog';

const rock = { board: 'radxa-rock-4d', boardName: 'Radxa ROCK 4D', vendor: 'Radxa', soc: 'rk3576' };
const cm5 = { board: 'armsom-cm5-io', boardName: 'ArmSoM CM5-IO', vendor: 'ArmSoM', soc: 'rk3576' };
const r5 = { board: 'radxa-rock-5b', boardName: 'Radxa ROCK 5B', vendor: 'Radxa', soc: 'rk3588' };
const boards = [rock, cm5, r5];

describe('board search', () => {
  it('ignores case, spaces, hyphens and dots', () => {
    expect(squash('ROCK-4D. x')).toBe('rock4dx');
    for (const q of ['rock4d', 'rock 4d', 'ROCK-4D', 'Rock.4d', 'radxa-rock-4d']) expect(matches(rock, q), q).toBe(true);
    expect(matches(cm5, 'rock4d')).toBe(false);
  });

  it('matches vendor, name, id and SoC, words in any order', () => {
    expect(matches(rock, 'radxa 3576')).toBe(true);
    expect(matches(rock, '3576 radxa')).toBe(true);
    expect(matches(r5, 'radxa 3576')).toBe(false);
    expect(matches(cm5, 'cm5io')).toBe(true);
    expect(matches(cm5, 'armsom')).toBe(true);
    expect(matches(cm5, 'RK3576')).toBe(true);
    expect(matches(cm5, 'nothing')).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(matches(rock, '')).toBe(true);
    expect(matches(rock, '  -  ')).toBe(true);
  });

  it('counts boards per vendor, A to Z, and matches while searching', () => {
    expect(vendorCounts(boards)).toEqual([{ vendor: 'ArmSoM', count: 1 }, { vendor: 'Radxa', count: 2 }]);
    expect(vendorCounts(boards, '3588')).toEqual([{ vendor: 'ArmSoM', count: 0 }, { vendor: 'Radxa', count: 1 }]);
  });

  it('filters by vendor without a search, and searches across all vendors', () => {
    expect(visibleBoards(boards, null, '')).toHaveLength(3);
    expect(visibleBoards(boards, 'Radxa', '')).toEqual([rock, r5]);
    expect(visibleBoards(boards, 'Radxa', 'cm5')).toEqual([cm5]);
    expect(visibleBoards(boards, 'ArmSoM', 'zzz')).toEqual([]);
  });
});

describe('vendor in the catalog', () => {
  const sample = JSON.parse(readFileSync(new URL('../resources/sample-catalog.json', import.meta.url), 'utf8'));

  it('reads the vendor field', () => {
    const imgs = parseCatalog(sample).images;
    expect(imgs.map((i) => i.vendor)).toEqual(['Radxa', 'ArmSoM']);
    expect(groupByBoard(imgs).map((b) => b.vendor)).toEqual(['ArmSoM', 'Radxa']);
  });

  it('falls back to the first word of board_name for older catalogs', () => {
    const c = structuredClone(sample);
    for (const i of c.images) delete i.vendor;
    expect(parseCatalog(c).images.map((i) => i.vendor)).toEqual(['Radxa', 'ArmSoM']);
    expect(vendorFallback('  Pine64 Quartz64 A ')).toBe('Pine64');
    expect(vendorFallback('Single')).toBe('Single');
  });

  it('treats an empty vendor as missing', () => {
    const c = structuredClone(sample);
    c.images[0].vendor = ' ';
    expect(parseCatalog(c).images[0].vendor).toBe('Radxa');
  });
});

describe('SPI image in the catalog', () => {
  const sample = JSON.parse(readFileSync(new URL('../resources/sample-catalog.json', import.meta.url), 'utf8'));

  it('reads it when present and leaves it null otherwise', () => {
    const imgs = parseCatalog(sample).images;
    expect(imgs[0].spi).toEqual({
      file: 'roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img',
      url: 'https://github.com/roxora-os/build/releases/download/v2026.11.0/roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img',
      size: 16777216,
      sha256: '33831091f7cd2f9a070fcbff36243cbb4b6ae49f4c96a9607f214652e01f3561',
    });
    expect(imgs[1].spi).toBeNull();
  });

  it('drops a broken SPI entry but keeps the image', () => {
    const c = structuredClone(sample);
    c.images[0].spi.url = 'https://example.com/x-spi.img';
    const p = parseCatalog(c);
    expect(p.images).toHaveLength(2);
    expect(p.images[0].spi).toBeNull();
    expect(p.problems[0]).toMatch(/spi: url is not/);
  });
});
