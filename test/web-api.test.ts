import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { expectedHashes, loadWebCatalog, MIRROR_INDEX } from '../src/web/api';
import { parseCatalog } from '../src/shared/catalog';

const sample = JSON.parse(readFileSync(new URL('../resources/sample-catalog.json', import.meta.url), 'utf8'));
const real = () => { const c = structuredClone(sample); delete c._sample; return c; };
const CAT = 'https://roxora-os.github.io/catalog/v2026.11.0.json';
const index = { schema: 1, latest: 'v2026.11.0', releases: [{ tag: 'v2026.11.0', catalog: CAT }] };
const ghRelease = (digestOk: boolean) => [{
  tag_name: 'v2026.11.0', draft: false, prerelease: true,
  assets: real().images.flatMap((i: any) => [
    { name: i.file, browser_download_url: i.url, digest: `sha256:${digestOk ? i.sha256 : '0'.repeat(64)}` },
    ...(i.spi ? [{ name: i.spi.file, browser_download_url: i.spi.url, digest: `sha256:${i.spi.sha256}` }] : []),
  ]),
}];

function stubFetch(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => url.startsWith(k));
    if (!key || map[key] === 404) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('web catalog', () => {
  it('reads the mirrored catalogs and checks them against the API digests', async () => {
    stubFetch({ [MIRROR_INDEX]: index, [CAT]: real(), 'https://api.github.com/': ghRelease(true) });
    const r = await loadWebCatalog(false);
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect(r.images.map((i) => i.board)).toEqual(['radxa-rock-4d', 'armsom-cm5-io']);
      expect(r.problems).toEqual([]);
    }
  });

  it('drops images whose digest GitHub disagrees with', async () => {
    stubFetch({ [MIRROR_INDEX]: index, [CAT]: real(), 'https://api.github.com/': ghRelease(false) });
    const r = await loadWebCatalog(false);
    expect(r.state).toBe('none');
  });

  it('uses the mirror alone when the API is not reachable, and says so', async () => {
    stubFetch({ [MIRROR_INDEX]: index, [CAT]: real(), 'https://api.github.com/': 404 });
    const r = await loadWebCatalog(false);
    expect(r.state).toBe('ok');
    expect(r.problems[0]).toMatch(/mirror only/);
  });

  it('says there are no releases when the mirror lists none', async () => {
    stubFetch({ [MIRROR_INDEX]: { schema: 1, releases: [] }, 'https://api.github.com/': [] });
    expect((await loadWebCatalog(false)).state).toBe('none');
  });

  it('reports an unreachable mirror', async () => {
    stubFetch({});
    const r = await loadWebCatalog(false);
    expect(r.state).toBe('error');
  });

  it('never takes a sample catalog from the mirror', async () => {
    stubFetch({ [MIRROR_INDEX]: index, [CAT]: sample, 'https://api.github.com/': ghRelease(true) });
    expect((await loadWebCatalog(false)).state).toBe('none');
  });
});

describe('what a picked release file must be', () => {
  const [rock] = parseCatalog(real()).images;
  it('accepts the .img.xz or the extracted .img; the written bytes are the extracted image', () => {
    const e = expectedHashes(rock, 'image');
    expect(e.accept.map((a) => a.label)).toEqual([rock.file, rock.file.replace(/\.xz$/, '')]);
    expect(e.written).toBe(rock.extractSha256);
  });
  it('accepts the SPI image by its own checksum', () => {
    const e = expectedHashes(rock, 'spi');
    expect(e.accept).toEqual([{ sha256: rock.spi!.sha256, size: rock.spi!.size, label: rock.spi!.file }]);
    expect(e.written).toBe(rock.spi!.sha256);
  });
});
