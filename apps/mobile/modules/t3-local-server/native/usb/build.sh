#!/bin/bash
# Builds the USB bridge for the Ubuntu arm64 guest (glibc, not bionic) into jniLibs, so it ships in
# the APK and GuestRuntime copies it into the rootfs. The sysroot comes from pinned Ubuntu 24.04 debs.
#   build.sh            cross-compile with the NDK's clang
#   build.sh host OUT   build for this machine into OUT, for test-host.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cflags=(-std=c11 -O2 -Wall -Wextra -Werror -Wno-format-truncation -fPIC -fvisibility=hidden -U_FORTIFY_SOURCE)

if [ "${1:-}" = host ]; then
  out=$2
  mkdir -p "$out"
  cc "${cflags[@]}" -shared -o "$out/libt3usb.so" "$here/t3usb_preload.c" -ldl -lpthread
  cc "${cflags[@]}" -o "$out/t3-usb" "$here/t3usb_cli.c"
  exit 0
fi

ndk=${ANDROID_NDK_HOME:-$(ls -d "${ANDROID_HOME:?set ANDROID_HOME}"/ndk/* | sort -V | tail -1)}
bin=$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin
cache=${T3USB_SYSROOT_CACHE:-${TMPDIR:-/tmp}/t3usb-sysroot}
pool=http://ports.ubuntu.com/ubuntu-ports/pool/main
debs=(
  "g/glibc/libc6_2.39-0ubuntu8_arm64.deb 04d7cb73e608b41713b63ef915577f7f5d75e95b1b33174e82e05687fdb6cfaf"
  "g/glibc/libc6-dev_2.39-0ubuntu8_arm64.deb cf8d2af040044ea5f9205a7a7a3eceabe9bc182fd780a1dac8e849f8eccee1f1"
  "l/linux/linux-libc-dev_6.8.0-31.31_arm64.deb 7fd438efa44a794b438e7dde7ac280166fb8d4b1cf7846393ce019714d8bb3e3"
)
sysroot=$cache/sysroot
if [ ! -e "$sysroot/.complete" ]; then
  mkdir -p "$cache/debs"
  rm -rf "$sysroot"
  for entry in "${debs[@]}"; do
    read -r path sum <<<"$entry"
    deb=$cache/debs/$(basename "$path")
    [ -f "$deb" ] || curl -fsSL -o "$deb" "$pool/$path"
    echo "$sum  $deb" | sha256sum -c --quiet
    dpkg-deb -x "$deb" "$sysroot"
  done
  ln -sfn usr/lib "$sysroot/lib" # usrmerge, as base-files would set up
  touch "$sysroot/.complete"
fi

target=(--target=aarch64-linux-gnu --sysroot="$sysroot" -mno-outline-atomics -fuse-ld=lld -nostdlib)
lib=$sysroot/usr/lib/aarch64-linux-gnu
out=$here/../../android/src/main/jniLibs/arm64-v8a
"$bin/clang" "${cflags[@]}" "${target[@]}" -shared -Wl,-soname,libt3usb.so -o "$out/libt3usb.so" \
  "$lib/crti.o" "$here/t3usb_preload.c" -lc "$lib/crtn.o"
# An executable named like a library, so Android unpacks it with the others.
"$bin/clang" "${cflags[@]}" "${target[@]}" -pie -o "$out/libt3usb_cli.so" \
  "$lib/Scrt1.o" "$lib/crti.o" "$here/t3usb_cli.c" -lc "$lib/crtn.o" \
  -Wl,--dynamic-linker=/lib/ld-linux-aarch64.so.1
"$bin/llvm-strip" "$out/libt3usb.so" "$out/libt3usb_cli.so"
ls -l "$out/libt3usb.so" "$out/libt3usb_cli.so"
