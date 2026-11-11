import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  catalogAssets, checkAgainstRelease, groupByBoard, parseCatalog, type GithubRelease,
} from '../src/shared/catalog';

const sample = JSON.parse(readFileSync(new URL('../resources/sample-catalog.json', import.meta.url), 'utf8'));

function real(): any {
  const c = structuredClone(sample);
  delete c._sample;
  return c;
}

describe('parseCatalog', () => {
  it('reads the sample catalog and marks every image as sample', () => {
    const p = parseCatalog(sample);
    expect(p.problems).toEqual([]);
    expect(p.sample).toBe(true);
    expect(p.images).toHaveLength(2);
    expect(p.images.every((i) => i.sample)).toBe(true);
    expect(p.images[0].id).toBe('v2026.11.0/roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz');
    expect(p.images[0].extractSize).toBe(2466250752);
  });

  it('treats a catalog without _sample as real', () => {
    const p = parseCatalog(real());
    expect(p.sample).toBe(false);
    expect(p.images.some((i) => i.sample)).toBe(false);
  });

  it('can be told a catalog is a sample even without the marker', () => {
    expect(parseCatalog(real(), { sample: true }).images.every((i) => i.sample)).toBe(true);
  });

  it('ignores fields it does not know', () => {
    const c = real();
    c.extra = { x: 1 };
    c.images[0].new_field = 'y';
    const p = parseCatalog(c);
    expect(p.problems).toEqual([]);
    expect(p.images).toHaveLength(2);
  });

  it('refuses a newer schema as a whole', () => {
    const c = real();
    c.schema = 2;
    const p = parseCatalog(c);
    expect(p.images).toEqual([]);
    expect(p.problems[0]).toMatch(/format 2/);
  });

  it('refuses something that is not a catalog', () => {
    expect(parseCatalog(null).problems).toEqual(['catalog is not a JSON object']);
    expect(parseCatalog([]).problems).toEqual(['catalog is not a JSON object']);
    expect(parseCatalog({ schema: 1 }).problems).toEqual(['catalog: "release" is missing']);
  });

  it('drops an image whose url points outside the release', () => {
    const c = real();
    c.images[0].url = 'https://example.com/roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz';
    const p = parseCatalog(c);
    expect(p.images.map((i) => i.board)).toEqual(['armsom-cm5-io']);
    expect(p.problems[0]).toMatch(/url is not https:\/\/github.com\/roxora-os\/build\/releases\/download\/v2026.11.0\//);
  });

  it('drops an image with a bad checksum or size', () => {
    const c = real();
    c.images[0].sha256 = 'ABC';
    c.images[1].size = -1;
    const p = parseCatalog(c);
    expect(p.images).toEqual([]);
    expect(p.problems).toHaveLength(2);
  });

  it('drops an image whose file name does not follow the contract', () => {
    const c = real();
    c.images[0].file = 'rock4d.img.xz';
    c.images[0].url = 'https://github.com/roxora-os/build/releases/download/v2026.11.0/rock4d.img.xz';
    const p = parseCatalog(c);
    expect(p.images).toHaveLength(1);
    expect(p.problems[0]).toMatch(/file name should be roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz/);
  });

  it('rejects names that could escape a path', () => {
    const c = real();
    c.images[0].board = '../etc';
    expect(parseCatalog(c).images).toHaveLength(1);
  });

  it('checks that tag and version agree', () => {
    const c = real();
    c.release.tag = 'v2026.12.0';
    const p = parseCatalog(c);
    expect(p.release).toBeNull();
    expect(p.problems[0]).toMatch(/does not match version/);
  });

  it('drops duplicate images', () => {
    const c = real();
    c.images.push(structuredClone(c.images[0]));
    const p = parseCatalog(c);
    expect(p.images).toHaveLength(2);
    expect(p.problems[0]).toMatch(/listed twice/);
  });
});

describe('groupByBoard', () => {
  it('groups by board, sorted by name, newest release first', () => {
    const a = parseCatalog(real()).images;
    const c2 = real();
    c2.release.tag = 'v2026.12.1';
    c2.release.version = '2026.12.1';
    for (const i of c2.images) {
      i.file = i.file.replace('2026.11.0', '2026.12.1');
      i.url = `https://github.com/roxora-os/build/releases/download/v2026.12.1/${i.file}`;
    }
    const b = parseCatalog(c2).images;
    expect(parseCatalog(c2).problems).toEqual([]);
    const boards = groupByBoard([...a, ...b]);
    expect(boards.map((x) => x.boardName)).toEqual(['ArmSoM CM5-IO', 'Radxa ROCK 4D']);
    expect(boards[0].images.map((i) => i.releaseInfo.version)).toEqual(['2026.12.1', '2026.11.0']);
  });

  it('returns nothing for no images', () => {
    expect(groupByBoard([])).toEqual([]);
  });
});

describe('GitHub releases', () => {
  const gh: GithubRelease = {
    tag_name: 'v2026.11.0', draft: false, prerelease: true,
    assets: [
      { name: 'roxora-catalog.json', browser_download_url: 'https://github.com/roxora-os/build/releases/download/v2026.11.0/roxora-catalog.json' },
      { name: 'roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz', browser_download_url: 'x',
        digest: 'sha256:472e91ddb5b305155b1de916c8e5237643ac9c648b43d9f7062a3d1128cf82f2' },
      { name: 'roxora-armsom-cm5-io-noble-edge-2026.11.0.img.xz', browser_download_url: 'x',
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    ],
  };

  it('finds catalog assets and skips drafts and releases without one', () => {
    expect(catalogAssets([])).toEqual([]);
    expect(catalogAssets([
      gh,
      { ...gh, tag_name: 'v2026.10.0', draft: true },
      { tag_name: 'v2026.09.0', draft: false, prerelease: false, assets: [] },
    ])).toEqual([{ tag: 'v2026.11.0', url: gh.assets[0].browser_download_url }]);
  });

  it('drops images whose sha256 differs from the GitHub digest', () => {
    const p = checkAgainstRelease(parseCatalog(real()), gh);
    expect(p.images.map((i) => i.board)).toEqual(['radxa-rock-4d']);
    expect(p.problems[0]).toMatch(/differs from the digest/);
  });

  it('drops images that are not attached to the release', () => {
    const p = checkAgainstRelease(parseCatalog(real()), { ...gh, assets: [gh.assets[0]] });
    expect(p.images).toEqual([]);
  });

  it('refuses a catalog that names another release', () => {
    const p = checkAgainstRelease(parseCatalog(real()), { ...gh, tag_name: 'v2026.11.1' });
    expect(p.images).toEqual([]);
    expect(p.problems.at(-1)).toMatch(/belongs to v2026.11.0/);
  });

  it('takes the pre-release flag from GitHub', () => {
    const noDigest = { ...gh, prerelease: false, assets: gh.assets.map((a) => ({ ...a, digest: null })) };
    const p = checkAgainstRelease(parseCatalog(real()), noDigest);
    expect(p.images).toHaveLength(2);
    expect(p.images[0].releaseInfo.prerelease).toBe(false);
  });
});
