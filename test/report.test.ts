// "Report a problem": what is removed before anything leaves the computer,
// and the GitHub link staying under its length limit (shared/report.ts).
import { describe, expect, it } from 'vitest';
import { factsFrom, fullLog, ISSUES_NEW, issueUrl, MAX_URL, scrub, type ReportFacts } from '../src/shared/report';

const linux = { home: '/home/ann', user: 'ann' };
const windows = { home: 'C:\\Users\\Ann', user: 'Ann' };

describe('scrubbing', () => {
  it('replaces the home folder and the user name', () => {
    expect(scrub('cache /home/ann/.config/Roxora Imager/images, user ann', linux)).toBe('cache ~/.config/Roxora Imager/images, user <user>');
    expect(scrub('C:\\Users\\Ann\\AppData\\Roaming and c:/users/ann/Downloads', windows)).toBe('~\\AppData\\Roaming and ~/Downloads');
  });
  it('drops e-mail and IP addresses but keeps version numbers', () => {
    expect(scrub('mail ann@example.com from 192.168.1.20 and fe80:0:0:0:1:2:3:4', linux)).toBe('mail <email> from <ip> and <ip>');
    expect(scrub('Windows 10.0.22631.2428, driver v1.0.0.135, Roxora 2026.11.6', linux)).toBe('Windows 10.0.22631.2428, driver v1.0.0.135, Roxora 2026.11.6');
  });
  it('drops serial numbers, the app\'s file tokens and secrets', () => {
    expect(scrub('SerialNumber: 0123ABCD serial=XYZ "serialNumber":"9f"', linux)).toBe('SerialNumber: <serial> serial=<serial> "serialNumber":"<serial>"');
    expect(scrub('GET app://local/file/AbC-123_x ok', linux)).toBe('GET app://local/file/<token> ok');
    expect(scrub('password=hunter2 token: abc ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa', linux)).toBe('password=<removed> token: <removed> <removed>');
  });
  it('leaves short or generic user names alone, and works without a home folder (web)', () => {
    expect(scrub('user root in /root', { home: '/root', user: 'root' })).toBe('user root in ~');
    expect(scrub('/home/ann ann@example.com', { home: '', user: '' })).toBe('/home/ann <email>');
  });
});

const facts = (log: string[]): ReportFacts => ({
  version: '0.1.10', commit: 'abc1234', os: 'Linux 6.8.0', arch: 'arm64', board: 'Radxa ROCK 4D',
  image: 'roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz', destination: 'SD card in the board, over Maskrom',
  step: 'Write SD card in the board', error: 'The board was disconnected.', detail: 'Writing failed (rkdeveloptool exit 1).', log,
});

describe('the issue link', () => {
  it('goes to roxora-os/imager, with title and body scrubbed and the last 50 lines', () => {
    const log = Array.from({ length: 80 }, (_x, i) => `line ${i} /home/ann/x`);
    const url = new URL(issueUrl(facts(log), linux));
    expect(`${url.origin}${url.pathname}`).toBe(ISSUES_NEW);
    expect(ISSUES_NEW).toBe('https://github.com/roxora-os/imager/issues/new');
    expect(url.searchParams.get('title')).toBe('The board was disconnected. (Radxa ROCK 4D, Linux 6.8.0)');
    const body = url.searchParams.get('body')!;
    expect(body).toContain('Roxora Imager 0.1.10 (abc1234)');
    expect(body).toContain('Step that failed: Write SD card in the board');
    expect(body).toContain('Log (last 50 lines)');
    expect(body).toContain('line 79 ~/x');
    expect(body).not.toContain('line 29 ');
    expect(body).not.toContain('/home/ann');
    expect(body).toContain('Save full log');
  });
  it('cuts the log until the link fits', () => {
    const log = Array.from({ length: 50 }, (_x, i) => `${i} ${'x'.repeat(400)}`);
    const url = issueUrl(facts(log), linux);
    expect(url.length).toBeLessThanOrEqual(MAX_URL);
    expect(new URL(url).searchParams.get('body')).toMatch(/Log \(last \d+ lines\)/);
  });
  it('has no log section for a write without a log', () => {
    const body = new URL(issueUrl(facts([]), linux)).searchParams.get('body')!;
    expect(body).not.toContain('## Log');
  });
  it('saves the whole log for the attachment', () => {
    const log = Array.from({ length: 300 }, (_x, i) => `line ${i} ann@example.com`);
    const text = fullLog(facts(log), linux);
    expect(text).toContain('Log (all lines)');
    expect(text).toContain('line 0 <email>');
    expect(text).toContain('line 299 <email>');
    expect(text).not.toContain('Please attach');
  });
  it('takes only strings from the page', () => {
    const f = factsFrom({ board: 'Radxa ROCK 4D', image: 7, log: ['a', 2], extra: 'x' }, { version: '1', commit: 'c', os: 'o', arch: 'a' });
    expect(f).toEqual({ version: '1', commit: 'c', os: 'o', arch: 'a', board: 'Radxa ROCK 4D', image: null, destination: null,
      step: null, error: null, detail: null, log: ['a', '2'] });
  });
});
