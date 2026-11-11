#!/bin/sh
# Build rkdeveloptool for WebAssembly into vendor/rkdeveloptool-wasm/.
#
# The same steps as edk2-webflash's .github/workflows/deploy.yml: the
# rkdeveloptool source and patches from jjm2473/rktool-webusb, libusb 1.0.29
# with its Emscripten patch, Emscripten 3.1.48, edk2-webflash's
# CMakeLists.wasm.txt (copied here as packaging/CMakeLists.wasm.txt).
# Needs emcc/emcmake on PATH (emsdk 3.1.48), cmake, curl, git, patch.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$ROOT/cache/wasm}
OUT=$ROOT/vendor/rkdeveloptool-wasm
# Pinned; edk2-webflash builds from the branch head, which was this commit
# when the imager was set up.
RKTOOL_REV=${RKTOOL_REV:-7879bdb910cdd63b7cae595b683dd672720b0490}
LIBUSB=1.0.29

command -v emcc >/dev/null || { echo "emcc not found: install emsdk 3.1.48" >&2; exit 1; }
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"
cd "$WORK"

git clone https://github.com/jjm2473/rktool-webusb.git rktool
(cd rktool && git checkout -q "$RKTOOL_REV" && git submodule update --init --depth=1 rkdeveloptool && git rev-parse HEAD > ../rktool.rev)

mkdir -p rktool/ref
curl -fsSL "https://github.com/libusb/libusb/releases/download/v$LIBUSB/libusb-$LIBUSB.tar.bz2" | tar -xj -C rktool/ref
(cd "rktool/ref/libusb-$LIBUSB" && for p in ../../patches/libusb/*.patch; do patch -p1 < "$p"; done)
(cd rktool/rkdeveloptool && for p in ../patches/rkdeveloptool/*.patch; do patch -p1 < "$p"; done)

mkdir -p "rktool/ref/libusb-$LIBUSB/build-wasm"
(
  cd "rktool/ref/libusb-$LIBUSB/build-wasm"
  emconfigure ../configure --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-udev
  # See edk2-webflash deploy.yml: keep -pthread out so emscripten/val.h's
  # pthread_equal assertion is not compiled in.
  find . -name Makefile -exec sed -i.bak 's/ -pthread/ -matomics/g' {} +
  emmake make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
)

mkdir -p wasm-build
cp "$ROOT/packaging/CMakeLists.wasm.txt" wasm-build/CMakeLists.txt
emcmake cmake -S wasm-build -B wasm-build/build \
  -DRKTOOL_ROOT="$WORK/rktool" \
  -DLIBUSB_STATIC_LIB="$WORK/rktool/ref/libusb-$LIBUSB/build-wasm/libusb/.libs/libusb-1.0.a" \
  -DLIBUSB_INCLUDE_DIR="$WORK/rktool/ref/libusb-$LIBUSB/libusb" \
  -DDIST_DIR="$OUT" -DCMAKE_BUILD_TYPE=Release
cmake --build wasm-build/build --parallel

{
  echo "rktool-webusb $(cat rktool.rev)"
  echo "libusb $LIBUSB"
  echo "emscripten $(emcc --version | head -1)"
} > "$OUT/SOURCE.txt"
ls -l "$OUT"
