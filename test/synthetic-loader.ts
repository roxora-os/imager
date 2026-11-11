// A loader in Rockchip's "LDR " format built from random bytes, laid out as
// rkbin's RK3576MINIALL.ini lays out the real one. rkdeveloptool reads it
// like the real thing, so tests need no Rockchip blob.
import { randomBytes } from 'node:crypto';
import { mergeLoader, parseIni } from '../src/maskrom/loader-merge';

export const SYNTHETIC_INI = `[CHIP_NAME]
NAME=RK3576
[VERSION]
MAJOR=1
MINOR=100
[CODE471_OPTION]
NUM=1
Path1=bin/ddr_test.bin
Sleep=1
[CODE472_OPTION]
NUM=1
Path1=bin/usbplug_test.bin
[LOADER_OPTION]
NUM=3
LOADER1=FlashBoost
LOADER2=FlashData
LOADER3=FlashBoot
FlashBoost=bin/boost_test.bin
FlashData=bin/ddr_test.bin
FlashBoot=bin/spl_test.bin
[LOADER1_PARAM]
LOAD_ADDR=0x3FFC0000
FLAG=0x0
[LOADER2_PARAM]
LOAD_ADDR=0x3FF81000
FLAG=0x0
[OUTPUT]
PATH=test_loader.bin
[SYSTEM]
NEWIDB=true
ALIGN=8
[FLAG]
471_RC4_OFF=true
[BOOT1_PARAM]
WORD_2=0x100
`;

export function syntheticLoader(): Uint8Array {
  const blobs = new Map<string, Uint8Array>([
    ['bin/ddr_test.bin', new Uint8Array(randomBytes(80_000))],
    ['bin/usbplug_test.bin', new Uint8Array(randomBytes(260_000))],
    ['bin/boost_test.bin', new Uint8Array(randomBytes(2_600))],
    ['bin/spl_test.bin', new Uint8Array(randomBytes(260_000))],
  ]);
  return mergeLoader(parseIni(SYNTHETIC_INI), blobs, [2026, 1, 1, 0, 0, 0]);
}
