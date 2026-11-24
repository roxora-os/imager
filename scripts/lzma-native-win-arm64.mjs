// lzma-native 8.0.6 on Windows links a liblzma.dll it ships for x64 and x86
// only; on arm64 its binding.gyp falls through to the x86 import library
// and the link fails. This adds an arm64 branch that uses a liblzma.dll
// built for arm64 (vcpkg's liblzma:arm64-windows), so lzma-native builds
// natively. Run in the repository before `node-gyp rebuild` in lzma-native.
//   node scripts/lzma-native-win-arm64.mjs C:/vcpkg/installed/arm64-windows/bin/liblzma.dll
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machines } from './lib/machine.mjs';

const dll = process.argv[2];
if (!dll || !machines(dll).includes('arm64')) { console.error(`${dll ?? '(none)'} is not an arm64 liblzma.dll`); process.exit(1); }
const root = 'node_modules/lzma-native';
mkdirSync(join(root, 'deps', 'bin_arm64'), { recursive: true });
copyFileSync(dll, join(root, 'deps', 'bin_arm64', 'liblzma.dll'));

const gyp = join(root, 'binding.gyp');
let s = readFileSync(gyp, 'utf8');
const libOld = `{
                "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_i686" ]
              }`;
const libNew = `{ "conditions": [ [ 'target_arch=="arm64"', {
                "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_arm64" ]
              }, {
                "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_i686" ]
              } ] ] }`;
const varOld = `{
              'variables': {
                "arch_lib_path" : 'bin_i686',
                "arch_lib_code" : 'ix86'
              }
            }`;
const varNew = `{ "conditions": [ [ 'target_arch=="arm64"', {
              'variables': { "arch_lib_path" : 'bin_arm64', "arch_lib_code" : 'arm64' }
            }, {
              'variables': { "arch_lib_path" : 'bin_i686', "arch_lib_code" : 'ix86' }
            } ] ] }`;
if (!s.includes(libOld) || !s.includes(varOld)) { console.error('lzma-native binding.gyp is not the one this patch is for'); process.exit(1); }
s = s.replace(libOld, libNew).replace(varOld, varNew);
writeFileSync(gyp, s);
console.log('lzma-native: arm64 branch added, liblzma.dll from', dll);
