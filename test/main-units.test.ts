import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

vi.mock('electron', () => ({ webContents: {}, protocol: {} }));

const { allowedDevice, chooseDevice, originOf } = await import('../src/main/usb');
const { parseRange } = await import('../src/main/protocol');
const { commandLine, quote, runHelper } = await import('../src/main/elevate');

describe('WebUSB policy', () => {
  const policy = { origins: ['app://local'], vendorIds: [0x2207] };
  it('reads the origin of the app scheme (URL.origin says "null" there)', () => {
    expect(originOf('app://local/')).toBe('app://local');
    expect(originOf('app://local/index.html')).toBe('app://local');
    expect(originOf('https://example.com/x')).toBe('https://example.com');
    expect(originOf(undefined)).toBe('');
  });
  it('grants Rockchip devices to the app only', () => {
    expect(allowedDevice(policy, 'app://local', { vendorId: 0x2207 })).toBe(true);
    expect(allowedDevice(policy, 'app://local/', { vendorId: 0x2207 })).toBe(true);
    expect(allowedDevice(policy, 'app://local', { vendorId: 0x1234 })).toBe(false);
    expect(allowedDevice(policy, 'https://evil.example', { vendorId: 0x2207 })).toBe(false);
    expect(allowedDevice(policy, 'app://local', undefined)).toBe(false);
  });
  it('picks the only Rockchip device without asking, asks when there are several', async () => {
    const ask = vi.fn(async () => 'b');
    const dev = (deviceId: string, vendorId: number) => ({ deviceId, vendorId, productId: 0x350e });
    expect(await chooseDevice([dev('m', 0x046d), dev('a', 0x2207)], policy, ask)).toBe('a');
    expect(ask).not.toHaveBeenCalled();
    expect(await chooseDevice([dev('a', 0x2207), dev('b', 0x2207)], policy, ask)).toBe('b');
    expect(await chooseDevice([dev('m', 0x046d)], policy, ask)).toBe('');
  });
});

describe('Range requests', () => {
  it('parses the forms the worker and browsers send', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange('bytes=1000-1001', 1000)).toBeNull();
    expect(parseRange('bytes=5-1', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
  });
});

describe('starting the writer', () => {
  it('quotes arguments for sh', () => {
    expect(quote("/tmp/it's here", 'linux')).toBe("'/tmp/it'\\''s here'");
    expect(commandLine({ exec: '/opt/Roxora Imager/writer', env: {} }, ['--device', '/dev/sdb'], 'linux'))
      .toBe("'/opt/Roxora Imager/writer' '--device' '/dev/sdb'");
  });
  it('quotes for cmd and refuses what cmd cannot take', () => {
    expect(quote('\\\\.\\PhysicalDrive1', 'win32')).toBe('"\\\\.\\PhysicalDrive1"');
    expect(() => quote('50%', 'win32')).toThrow();
  });

  // A stand-in helper: connects, says hello with the token, reports, finishes.
  function fakeElevate(script: string) {
    return (cmd: string) => new Promise<void>((resolve, reject) => {
      const args = cmd.match(/'[^']*'/g)!.map((a) => a.slice(1, -1));
      const p = spawn(process.execPath, ['-e', script, '--', ...args.slice(1)], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
    });
  }
  const launch = () => ({ exec: '/x/writer', env: {} });

  it('passes progress and the outcome over the socket', async () => {
    const script = `
      const a = process.argv; const get = (k) => a[a.indexOf('--' + k) + 1];
      const s = require('net').connect(get('socket'), () => {
        s.write(JSON.stringify({ type: 'hello', token: get('token') }) + '\\n');
        s.write(JSON.stringify({ type: 'progress', stage: 'write', percent: 50, bytes: 5, speed: 1 }) + '\\n');
        s.end(JSON.stringify({ type: 'done', ok: true, sha256: 'abc' }) + '\\n');
      });`;
    const seen: unknown[] = [];
    const out = await runHelper({
      launch, args: (socket, token) => ['--socket', socket, '--token', token],
      onMessage: (m) => seen.push(m), elevate: fakeElevate(script),
    });
    expect(out).toEqual({ type: 'done', ok: true, sha256: 'abc' });
    expect(seen[0]).toMatchObject({ type: 'progress', percent: 50 });
  });

  it('ignores a client without the token', async () => {
    const script = `
      const a = process.argv; const get = (k) => a[a.indexOf('--' + k) + 1];
      const s = require('net').connect(get('socket'), () => {
        s.write(JSON.stringify({ type: 'hello', token: 'wrong' }) + '\\n');
        s.write(JSON.stringify({ type: 'done', ok: true, sha256: 'forged' }) + '\\n');
      });
      s.on('close', () => process.exit(0)); s.on('error', () => process.exit(0));`;
    const out = await runHelper({ launch, args: (socket, token) => ['--socket', socket, '--token', token], onMessage: () => {}, elevate: fakeElevate(script) });
    expect(out.ok).toBe(false);
  });

  it('says plainly when administrator rights were refused', async () => {
    const out = await runHelper({ launch, args: () => [], onMessage: () => {},
      elevate: async () => { throw new Error('User did not grant permission.'); } });
    expect(out).toEqual({ type: 'done', ok: false, reason: 'Administrator rights were not granted. Nothing was written.' });
  });
  void connect;
});

describe('sudo-prompt on Node.js without util.isObject', () => {
  it('checks its arguments without the functions Node.js 23 removed', async () => {
    const util = (await import('node:util')).default as unknown as Record<string, unknown>;
    const saved = { isObject: util.isObject, isFunction: util.isFunction };
    // As in Electron's Node.js, where "Node.util.isObject is not a function".
    delete util.isObject;
    delete util.isFunction;
    try {
      const { loadSudoPrompt } = await import('../src/main/elevate');
      const sudo = await loadSudoPrompt();
      // A command starting with "sudo" is refused right after the argument
      // checks, before any password prompt.
      const err = await new Promise<Error | undefined>((resolve) => {
        sudo.exec('sudo true', { name: 'Roxora Imager', env: { A: '1' } }, resolve);
      });
      expect(String(err)).toMatch(/should not be prefixed with "sudo"/);
    } finally {
      Object.assign(util, saved);
    }
  });
});
