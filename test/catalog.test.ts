import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  catalogAssets, checkAgainstRelease, compareImages, flavorWords, groupByBoard, isLts, parseCatalog, splitByRelease, type GithubRelease,
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

  it('reads a beta catalog (version YYYY.MM.N-beta.N)', () => {
    const c = real();
    const from = c.release.version;
    const to = `${from}-beta.1`;
    c.release.version = to;
    c.release.tag = `v${to}`;
    c.release.prerelease = true;
    for (const i of c.images) {
      i.file = i.file.replace(from, to);
      i.url = `https://github.com/roxora-os/build/releases/download/v${to}/${i.file}`;
      if (i.spi) {
        i.spi.file = i.spi.file.replace(from, to);
        i.spi.url = `https://github.com/roxora-os/build/releases/download/v${to}/${i.spi.file}`;
      }
    }
    const p = parseCatalog(c);
    expect(p.problems).toEqual([]);
    expect(p.images.length).toBe(c.images.length);
    expect(p.images[0].releaseInfo.version).toBe(to);
  });

  it('refuses a version that is neither a release nor a beta', () => {
    const c = real();
    c.release.version = '2026.11.0-rc1';
    expect(parseCatalog(c).problems.join(' ')).toMatch(/not YYYY.MM.N or YYYY.MM.N-beta.N/);
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

  it('reads an image without a flavor as a command line image', () => {
    expect(parseCatalog(real()).images.map((i) => i.flavor)).toEqual(['cli', 'cli']);
  });

  it('reads a desktop image, whose file name carries its flavor', () => {
    const c = real();
    const file = 'roxora-radxa-rock-4d-noble-edge-gnome-minimal-2026.11.0.img.xz';
    c.images[0].flavor = 'gnome-minimal';
    c.images[0].file = file;
    c.images[0].url = `https://github.com/roxora-os/build/releases/download/v2026.11.0/${file}`;
    delete c.images[0].spi;
    c.images[1].flavor = 'cli';
    const p = parseCatalog(c);
    expect(p.problems).toEqual([]);
    expect(p.images.map((i) => i.flavor)).toEqual(['gnome-minimal', 'cli']);
    expect(p.images[0].id).toBe(`v2026.11.0/${file}`);
  });

  it('drops a desktop image under a command line file name', () => {
    const c = real();
    c.images[0].flavor = 'gnome';
    const p = parseCatalog(c);
    expect(p.images).toHaveLength(1);
    expect(p.problems[0]).toMatch(/file name should be roxora-radxa-rock-4d-noble-edge-gnome-2026.11.0.img.xz/);
  });

  // An image a release carries in parts: "parts" in place of "url".
  const inParts = (sizes = [300000000, 112345678]) => {
    const c = real();
    const i = c.images[0];
    delete i.url;
    i.parts = sizes.map((size, n) => ({
      file: `${i.file}.part${n + 1}`,
      url: `https://github.com/roxora-os/build/releases/download/v2026.11.0/${i.file}.part${n + 1}`,
      size,
      sha256: String(n + 1).repeat(64),
    }));
    return c;
  };

  it('reads an image in parts: no url, the parts in order', () => {
    const p = parseCatalog(inParts());
    expect(p.problems).toEqual([]);
    expect(p.images[0].url).toBe('');
    expect(p.images[0].size).toBe(412345678);
    expect(p.images[0].parts.map((x) => [x.file, x.size])).toEqual([
      ['roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz.part1', 300000000],
      ['roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz.part2', 112345678],
    ]);
    expect(p.images[1].parts).toEqual([]);
  });

  it('drops an image whose parts do not add up, are misnamed, or come from elsewhere', () => {
    expect(parseCatalog(inParts([300000000, 1])).problems[0]).toMatch(/parts add up to 300000001 bytes, not the image's 412345678/);
    const named = inParts();
    named.images[0].parts[1].file = named.images[0].parts[0].file;
    expect(parseCatalog(named).problems[0]).toMatch(/part 2: file name should be .*\.img\.xz\.part2/);
    const elsewhere = inParts();
    elsewhere.images[0].parts[0].url = 'https://example.com/x.part1';
    expect(parseCatalog(elsewhere).problems[0]).toMatch(/part 1: url is not https:\/\/github.com\/roxora-os\/build\//);
    for (const c of [inParts([300000000, 1]), named, elsewhere]) {
      expect(parseCatalog(c).images.map((i) => i.board)).toEqual(['armsom-cm5-io']);
    }
  });

  it('reads parts named .001, .002 as well, but not the two forms mixed', () => {
    const c = inParts();
    for (const [n, part] of c.images[0].parts.entries()) {
      part.file = `${c.images[0].file}.${String(n + 1).padStart(3, '0')}`;
      part.url = `https://github.com/roxora-os/build/releases/download/v2026.11.0/${part.file}`;
    }
    const p = parseCatalog(c);
    expect(p.problems).toEqual([]);
    expect(p.images[0].parts.map((x) => x.file)).toEqual([
      'roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz.001',
      'roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz.002',
    ]);
    const mixed = inParts();
    const second = mixed.images[0].parts[1];
    second.file = `${mixed.images[0].file}.002`;
    second.url = `https://github.com/roxora-os/build/releases/download/v2026.11.0/${second.file}`;
    expect(parseCatalog(mixed).problems[0]).toMatch(/part 2: file name should be .*\.img\.xz\.part2/);
  });

  it('drops an image with one part, with url beside parts, or with neither', () => {
    expect(parseCatalog(inParts([412345678])).problems[0]).toMatch(/"parts" is not a list of 2 to 9 parts/);
    const both = inParts();
    both.images[0].url = 'https://github.com/roxora-os/build/releases/download/v2026.11.0/roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz';
    expect(parseCatalog(both).problems[0]).toMatch(/has both "url" and "parts"/);
    const neither = real();
    delete neither.images[0].url;
    expect(parseCatalog(neither).problems[0]).toMatch(/"url" is missing/);
    for (const c of [inParts([412345678]), both, neither]) expect(parseCatalog(c).images).toHaveLength(1);
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
      if (i.spi) {
        i.spi.file = i.spi.file.replace('2026.11.0', '2026.12.1');
        i.spi.url = `https://github.com/roxora-os/build/releases/download/v2026.12.1/${i.spi.file}`;
      }
    }
    const b = parseCatalog(c2).images;
    expect(parseCatalog(c2).problems).toEqual([]);
    const boards = groupByBoard([...a, ...b]);
    expect(boards.map((x) => x.boardName)).toEqual(['ArmSoM CM5-IO', 'Radxa ROCK 4D']);
    expect(boards[0].images.map((i) => i.releaseInfo.version)).toEqual(['2026.12.1', '2026.11.0']);
  });

  it('puts the newest Ubuntu LTS first within a release, then newer Ubuntu', () => {
    const base = parseCatalog(real()).images.find((i) => i.board === 'radxa-rock-4d')!;
    const mk = (release: string, ubuntuVersion: string, branch = 'edge') =>
      ({ ...base, id: `${release}-${branch}`, release, ubuntuVersion, branch });
    const boards = groupByBoard([mk('noble', '24.04'), mk('stonking', '26.10'),
      mk('resolute', '26.04', 'vendor'), mk('resolute', '26.04')]);
    expect(boards[0].images.map((i) => i.id)).toEqual(
      ['resolute-edge', 'resolute-vendor', 'noble-edge', 'stonking-edge']);
  });

  it('puts the command line image before the desktop ones', () => {
    const base = parseCatalog(real()).images.find((i) => i.board === 'radxa-rock-4d')!;
    const mk = (release: string, ubuntuVersion: string, flavor: string) =>
      ({ ...base, id: `${release}-${flavor}`, release, ubuntuVersion, flavor });
    const boards = groupByBoard([mk('noble', '24.04', 'cli'), mk('resolute', '26.04', 'gnome'),
      mk('resolute', '26.04', 'kde'), mk('resolute', '26.04', 'gnome-minimal'), mk('resolute', '26.04', 'cli')]);
    expect(boards[0].images.map((i) => i.id)).toEqual(
      ['resolute-cli', 'resolute-gnome-minimal', 'resolute-gnome', 'resolute-kde', 'noble-cli']);
    expect(['cli', 'gnome-minimal', 'gnome', 'kde'].map(flavorWords)).toEqual(
      ['Command line', 'GNOME desktop, minimal', 'GNOME desktop', 'kde']);
  });

  it('sorts images by a column (Image step headers)', () => {
    const base = parseCatalog(real()).images.find((i) => i.board === 'radxa-rock-4d')!;
    const mk = (id: string, o: Partial<typeof base>) => ({ ...base, id, ...o });
    const imgs = [
      mk('a', { ubuntuVersion: '24.04', flavor: 'gnome', branch: 'edge', kernel: '7.3.4', size: 300 }),
      mk('b', { ubuntuVersion: '26.04', flavor: 'cli', branch: 'vendor', kernel: '6.1.115', size: 100 }),
      mk('c', { ubuntuVersion: '26.10', flavor: 'gnome-minimal', branch: 'edge', kernel: '7.3.10', size: 200 }),
    ];
    const by = (k: Parameters<typeof compareImages>[2]) => [...imgs].sort((x, y) => compareImages(x, y, k)).map((i) => i.id);
    expect(by('ubuntu')).toEqual(['a', 'b', 'c']);
    expect(by('desktop')).toEqual(['b', 'c', 'a']);
    expect(by('kernel')).toEqual(['a', 'c', 'b']);
    expect(by('size')).toEqual(['b', 'c', 'a']);
  });

  it('knows which Ubuntu versions are LTS', () => {
    expect(['24.04', '26.04', '26.10', '25.04', '28.04.1'].map(isLts)).toEqual([true, true, false, false, true]);
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
      { name: 'roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img', browser_download_url: 'x',
        digest: 'sha256:33831091f7cd2f9a070fcbff36243cbb4b6ae49f4c96a9607f214652e01f3561' },
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
    expect(p.images[0].spi?.file).toBe('roxora-radxa-rock-4d-noble-edge-2026.11.0-spi.img');
    expect(p.problems[0]).toMatch(/differs from the digest/);
  });

  it('drops an SPI image whose digest differs, keeps the disk image', () => {
    const assets = gh.assets.map((a) => (a.name.endsWith('-spi.img') ? { ...a, digest: 'sha256:' + '1'.repeat(64) } : a));
    const p = checkAgainstRelease(parseCatalog(real()), { ...gh, assets });
    expect(p.images[0].board).toBe('radxa-rock-4d');
    expect(p.images[0].spi).toBeNull();
    expect(p.problems.some((x) => /-spi.img: catalog sha256 differs/.test(x))).toBe(true);
  });

  it('wants every part of an image in parts attached, with its digest', () => {
    const c = real();
    const i = c.images[0];
    delete i.url;
    i.parts = [300000000, 112345678].map((size, n) => ({
      file: `${i.file}.part${n + 1}`,
      url: `https://github.com/roxora-os/build/releases/download/v2026.11.0/${i.file}.part${n + 1}`,
      size,
      sha256: String(n + 1).repeat(64),
    }));
    const part = (n: number, digest = `sha256:${String(n).repeat(64)}`) =>
      ({ name: `${i.file}.part${n}`, browser_download_url: 'x', digest });
    // The whole file is not in the release; its parts are.
    const others = gh.assets.filter((a) => a.name !== i.file);
    const ok = checkAgainstRelease(parseCatalog(c), { ...gh, assets: [...others, part(1), part(2)] });
    expect(ok.images.map((x) => x.board)).toEqual(['radxa-rock-4d']);
    expect(ok.images[0].parts).toHaveLength(2);
    const missing = checkAgainstRelease(parseCatalog(c), { ...gh, assets: [...others, part(1)] });
    expect(missing.images).toEqual([]);
    expect(missing.problems.some((x) => /\.part2: not attached to release/.test(x))).toBe(true);
    const changed = checkAgainstRelease(parseCatalog(c), { ...gh, assets: [...others, part(1), part(2, `sha256:${'9'.repeat(64)}`)] });
    expect(changed.images).toEqual([]);
    expect(changed.problems.some((x) => /\.part2: catalog sha256 differs/.test(x))).toBe(true);
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

describe('splitByRelease', () => {
  const base = parseCatalog(real()).images[0];
  const mk = (version: string, prerelease = false, id = version) => ({
    ...base, id, releaseInfo: { ...base.releaseInfo, tag: `v${version}`, version, prerelease },
  });

  it('shows the newest normal release and folds away the rest, newest first', () => {
    const s = splitByRelease([mk('2026.11.3'), mk('2026.11.5'), mk('2026.11.5', false, 'b'), mk('2026.11.4')]);
    expect(s.current?.release.version).toBe('2026.11.5');
    expect(s.current?.images.map((i) => i.id)).toEqual(['2026.11.5', 'b']);
    expect(s.others.map((r) => r.release.version)).toEqual(['2026.11.4', '2026.11.3']);
  });

  it('keeps a newer beta among the folded releases', () => {
    const s = splitByRelease([mk('2026.11.5'), mk('2026.12.1-beta.1', true)]);
    expect(s.current?.release.version).toBe('2026.11.5');
    expect(s.others.map((r) => r.release.version)).toEqual(['2026.12.1-beta.1']);
  });

  it('shows the newest beta when there is no normal release', () => {
    const s = splitByRelease([mk('2026.11.1-beta.1', true), mk('2026.11.1-beta.2', true)]);
    expect(s.current?.release.version).toBe('2026.11.1-beta.2');
    expect(s.others).toHaveLength(1);
  });

  it('orders betas by number and a release after its betas', () => {
    const s = splitByRelease([mk('2026.12.1-beta.2', true), mk('2026.12.1-beta.10', true), mk('2026.12.1'), mk('2026.11.5')]);
    expect(s.current?.release.version).toBe('2026.12.1');
    expect(s.others.map((r) => r.release.version)).toEqual(['2026.12.1-beta.10', '2026.12.1-beta.2', '2026.11.5']);
  });

  it('has nothing to show without images', () => {
    expect(splitByRelease([])).toEqual({ current: null, others: [] });
  });
});
