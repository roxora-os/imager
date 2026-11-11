import { describe, expect, it } from 'vitest';
import { checkDue, compareVersions, newerRelease, UPDATE_INTERVAL } from '../src/shared/update';

describe('update check', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('2026.11.10', '2026.11.2')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });
  it('checks at most once a day, and never when turned off', () => {
    const now = 10 * UPDATE_INTERVAL;
    expect(checkDue(true, 0, now)).toBe(true);
    expect(checkDue(true, now - 1000, now)).toBe(false);
    expect(checkDue(true, now - UPDATE_INTERVAL, now)).toBe(true);
    expect(checkDue(false, 0, now)).toBe(false);
    expect(checkDue(true, now + 5000, now)).toBe(true); // clock went back
  });
  it('offers only a newer, published release', () => {
    const r = { tag_name: 'v0.2.0', html_url: 'https://github.com/roxora-os/imager/releases/tag/v0.2.0' };
    expect(newerRelease('0.1.0', r)).toEqual({ version: '0.2.0', url: r.html_url });
    expect(newerRelease('0.2.0', r)).toBeNull();
    expect(newerRelease('0.1.0', { ...r, draft: true })).toBeNull();
    expect(newerRelease('0.1.0', { ...r, prerelease: true })).toBeNull();
    expect(newerRelease('0.1.0', null)).toBeNull();
  });
});
