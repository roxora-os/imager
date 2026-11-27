// Release downloads against a local server standing in for GitHub: a file
// that is one download, and an image a release carries in parts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadReleaseFile, type FetchFn, type ReleaseFile } from '../src/main/release-download';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'download-test-'));
const image = randomBytes(700000);
// Three parts, the last one smaller, as the release workflow cuts them.
const cuts = [image.subarray(0, 300000), image.subarray(300000, 600000), image.subarray(600000)];
const requests: string[] = [];
let server: Server;
const flaky = new Map<string, number>();
let cutDone = false;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.url ?? ''}${req.headers.range ? ` ${req.headers.range}` : ''}`);
    const m = /^\/(ok|slow|swapped|norange|flaky|cut)\/image\.img\.xz(?:\.part(\d))?$/.exec(req.url ?? '');
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let data = m[2] ? cuts[Number(m[2]) - 1] : image;
    // A part that is not the release's: the bytes of another part.
    if (m[1] === 'swapped' && m[2] === '2') data = cuts[0];
    if (!data) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // Two answers of 503 before the file comes.
    if (m[1] === 'flaky' && (flaky.get(req.url!) ?? 0) < 2) {
      flaky.set(req.url!, (flaky.get(req.url!) ?? 0) + 1);
      res.statusCode = 503;
      res.end();
      return;
    }
    const r = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (r && m[1] !== 'norange') {
      const from = Number(r[1]);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${from}-${data.length - 1}/${data.length}`);
      data = data.subarray(from);
    }
    res.setHeader('content-length', data.length);
    res.write(data.subarray(0, 1000));
    // The second part slow enough to be cancelled.
    if (m[1] === 'slow' && m[2] === '2') setTimeout(() => res.end(data.subarray(1000)), 2000);
    // The first answer of a whole file breaks off after 250000 bytes.
    else if (m[1] === 'cut' && !r && !cutDone) { cutDone = true; res.write(data.subarray(1000, 250000), () => setTimeout(() => res.destroy(), 300)); }
    else res.end(data.subarray(1000));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(work, { recursive: true, force: true }); });

const f = fetch as unknown as FetchFn;
const whole = (dir = 'ok'): ReleaseFile =>
  ({ file: 'image.img.xz', url: `${base}/${dir}/image.img.xz`, size: image.length, sha256: sha(image), sample: false });
const inParts = (dir = 'ok', count = 3): ReleaseFile => ({
  ...whole(dir), url: '',
  parts: cuts.slice(0, count).map((c, i) => ({
    file: `image.img.xz.part${i + 1}`, url: `${base}/${dir}/image.img.xz.part${i + 1}`, size: c.length, sha256: sha(c),
  })),
});
const cache = (name: string) => join(work, name);
const left = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe('a release file that is one download', () => {
  it('is downloaded, checked and kept under its name', async () => {
    const seen: number[] = [];
    const path = await downloadReleaseFile(whole(), cache('one'), (p) => { if (p.stage === 'download') seen.push(p.bytes); }, undefined, f);
    expect(path).toBe(join(cache('one'), 'image.img.xz'));
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(seen[seen.length - 1]).toBe(image.length);
    expect(left(cache('one'))).toEqual(['image.img.xz']);
  });

  it('is taken from the cache when it is there and still matches', async () => {
    requests.length = 0;
    const stages = new Set<string>();
    await downloadReleaseFile(whole(), cache('one'), (p) => stages.add(p.stage), undefined, f);
    expect(requests).toEqual([]);
    expect([...stages]).toEqual(['check']);
  });

  it('is refused when it is not the release file, and nothing is left', async () => {
    const wrong = { ...whole(), sha256: '0'.repeat(64) };
    await expect(downloadReleaseFile(wrong, cache('wrong'), () => {}, undefined, f)).rejects.toThrow(/does not match the release/);
    expect(left(cache('wrong'))).toEqual([]);
  });

  it('refuses sample entries', async () => {
    await expect(downloadReleaseFile({ ...whole(), sample: true }, cache('sample'), () => {}, undefined, f)).rejects.toThrow(/Sample entries/);
  });
});

describe('an image in parts', () => {
  it('is downloaded part after part into one file, with the progress over the whole image', async () => {
    requests.length = 0;
    const seen: { bytes: number; total: number }[] = [];
    const path = await downloadReleaseFile(inParts(), cache('parts'), (p) => { if (p.stage === 'download') seen.push(p); }, undefined, f);
    expect(requests).toEqual(['/ok/image.img.xz.part1', '/ok/image.img.xz.part2', '/ok/image.img.xz.part3']);
    expect(path).toBe(join(cache('parts'), 'image.img.xz'));
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(seen.every((p) => p.total === image.length)).toBe(true);
    // The count goes on from part to part and never starts again.
    expect(seen.every((p, i) => i === 0 || p.bytes > seen[i - 1].bytes)).toBe(true);
    expect(seen[seen.length - 1].bytes).toBe(image.length);
    // Only the joined file stays in the cache.
    expect(left(cache('parts'))).toEqual(['image.img.xz']);
  });

  it('is taken from the cache once joined', async () => {
    requests.length = 0;
    await downloadReleaseFile(inParts(), cache('parts'), () => {}, undefined, f);
    expect(requests).toEqual([]);
  });

  it('replaces a joined file in the cache that no longer matches', async () => {
    const dir = cache('stale');
    await downloadReleaseFile(inParts(), dir, () => {}, undefined, f);
    const broken = Buffer.from(image);
    broken[5] ^= 0xff;
    writeFileSync(join(dir, 'image.img.xz'), broken);
    const path = await downloadReleaseFile(inParts(), dir, () => {}, undefined, f);
    expect(readFileSync(path).equals(image)).toBe(true);
  });

  it('stops at a part that is not the release part, naming it, and leaves nothing', async () => {
    requests.length = 0;
    await expect(downloadReleaseFile(inParts('swapped'), cache('swapped'), () => {}, undefined, f))
      .rejects.toThrow(/part 2 of 3 does not match the release/);
    // The third part is not asked for.
    expect(requests).toEqual(['/swapped/image.img.xz.part1', '/swapped/image.img.xz.part2']);
    expect(left(cache('swapped'))).toEqual([]);
  });

  it('refuses parts that are each right but do not join to the image', async () => {
    const short = { ...inParts('ok', 2) };
    await expect(downloadReleaseFile(short, cache('short'), () => {}, undefined, f)).rejects.toThrow(/The download does not match the release/);
    expect(left(cache('short'))).toEqual([]);
  });

  it('fails plainly when a part is not in the release', async () => {
    const img = inParts();
    img.parts![2] = { ...img.parts![2], url: `${base}/ok/image.img.xz.part7` };
    requests.length = 0;
    await expect(downloadReleaseFile(img, cache('missing'), () => {}, undefined, f, { backoffMs: 1 })).rejects.toThrow(/HTTP 404 for part 3 of 3/);
    // Not tried again: a 404 stays a 404. The two good parts are kept for later.
    expect(requests.filter((u) => u.includes('part7'))).toHaveLength(1);
    expect(left(cache('missing'))).toEqual(['image.img.xz.part']);
  });

  it('can be cancelled in a later part, keeps what it has, and goes on from there', async () => {
    const stop = new AbortController();
    const run = downloadReleaseFile(inParts('slow'), cache('cancel'), (p) => {
      // Past the first part: cancel while the second is coming in.
      if (p.stage === 'download' && p.bytes > cuts[0].length) stop.abort();
    }, stop.signal, f);
    await expect(run).rejects.toThrow();
    expect(stop.signal.aborted).toBe(true);
    expect(left(cache('cancel'))).toEqual(['image.img.xz.part']);
    const kept = readFileSync(join(cache('cancel'), 'image.img.xz.part')).length;
    expect(kept).toBeGreaterThanOrEqual(cuts[0].length);
    requests.length = 0;
    const path = await downloadReleaseFile(inParts(), cache('cancel'), () => {}, undefined, f);
    expect(readFileSync(path).equals(image)).toBe(true);
    // Part 1 is not fetched again; part 2 goes on where it stopped.
    const into = kept - cuts[0].length;
    expect(requests).toEqual([`/ok/image.img.xz.part2${into ? ` bytes=${into}-` : ''}`, '/ok/image.img.xz.part3']);
    expect(left(cache('cancel'))).toEqual(['image.img.xz']);
  });
});

describe('going on after a failure', () => {
  it('tries a broken-off download again with a Range request', async () => {
    requests.length = 0;
    const path = await downloadReleaseFile(whole('cut'), cache('cut'), () => {}, undefined, f, { backoffMs: 1 });
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(requests[0]).toBe('/cut/image.img.xz');
    // Normally it goes on with a Range request; when nothing of the first answer
    // had reached the disk before it broke off, it asks for the whole file again.
    expect(requests[1]).toMatch(/^\/cut\/image\.img\.xz( bytes=\d+-)?$/);
    expect(requests).toHaveLength(2);
  });

  it('waits out a few server errors before giving up', async () => {
    requests.length = 0;
    const path = await downloadReleaseFile(whole('flaky'), cache('flaky'), () => {}, undefined, f, { backoffMs: 1 });
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(requests).toEqual(['/flaky/image.img.xz', '/flaky/image.img.xz', '/flaky/image.img.xz']);
    flaky.clear();
    await expect(downloadReleaseFile(whole('flaky'), cache('flaky-none'), () => {}, undefined, f, { retries: 1, backoffMs: 1 })).rejects.toThrow(/HTTP 503/);
  });

  it('starts the part again when the server ignores Range', async () => {
    const dir = cache('norange');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'image.img.xz.part'), image.subarray(0, 123456));
    requests.length = 0;
    const path = await downloadReleaseFile(whole('norange'), dir, () => {}, undefined, f);
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(requests).toEqual(['/norange/image.img.xz bytes=123456-']);
  });

  it('downloads from nothing once when what it went on from was another file', async () => {
    const dir = cache('foreign');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'image.img.xz.part'), randomBytes(5000));
    requests.length = 0;
    const path = await downloadReleaseFile(whole(), dir, () => {}, undefined, f);
    expect(readFileSync(path).equals(image)).toBe(true);
    expect(requests).toEqual(['/ok/image.img.xz bytes=5000-', '/ok/image.img.xz']);
  });
});
