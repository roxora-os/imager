// What the Maskrom destination says about the USB devices it sees.
import { describe, expect, it } from 'vitest';
import { maskromStatus, MASKROM_PIDS } from '../src/shared/maskrom-detect';
import { MASKROM_BOARDS } from '../src/maskrom/boards';

const rk3576 = { vendorId: 0x2207, productId: 0x350e, opens: null };

describe('the live Maskrom line', () => {
  it('knows the Maskrom USB ID of every board chip', () => {
    for (const b of MASKROM_BOARDS) expect(MASKROM_PIDS[b.soc], b.board).toBeTypeOf('number');
  });
  it('says nothing is there without a Rockchip device', () => {
    expect(maskromStatus([], 'rk3576')).toEqual({ kind: 'none' });
    expect(maskromStatus([{ vendorId: 0x046d, productId: 0xc52b, opens: true }], 'rk3576')).toEqual({ kind: 'none' });
  });
  it('finds an RK3576 in Maskrom mode', () => {
    expect(maskromStatus([rk3576], 'rk3576')).toEqual({ kind: 'ready' });
    expect(maskromStatus([{ ...rk3576, opens: true }], 'rk3576')).toEqual({ kind: 'ready' });
  });
  it('tells a missing WinUSB driver apart (Windows)', () => {
    expect(maskromStatus([{ ...rk3576, opens: false }], 'rk3576')).toEqual({ kind: 'no-driver' });
  });
  it('names another Rockchip chip by its USB ID, and several devices as such', () => {
    expect(maskromStatus([{ vendorId: 0x2207, productId: 0x350b, opens: null }], 'rk3576')).toEqual({ kind: 'other-soc', pid: '2207:350b' });
    expect(maskromStatus([rk3576, rk3576], 'rk3576')).toEqual({ kind: 'several', count: 2 });
  });
});
