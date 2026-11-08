#!/bin/bash
# Checks the USB bridge against fake_broker.py and a descriptor file that looks like a phone in
# fastboot mode, plus a pty standing in for an adb device. Run on the host after `build.sh host OUT`,
# or in the guest with the shipped files. ADB is optional: Ubuntu's adb, for its native backend.
# The libusb checks need python3 and libusb-1.0-0; lsusb is checked when usbutils is installed.
#   test.sh LIB CLI FASTBOOT [ADB]
set -euo pipefail
lib=$1 cli=$2 fastboot=$3 adb=${4:-}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
# The host has working uevents, so udev emulation is forced on as it is in the app.
export T3USB_ROOT=$work/root T3USB_SOCKET=t3usb-test-$$ T3USB_EMULATE_UDEV=1
broker=
trap '[ -n "$broker" ] && kill "$broker"; rm -rf "$work"' EXIT

# Device, configuration, then one interface with fastboot's class, subclass and protocol, and two bulk endpoints.
printf '\x12\x01\x00\x02\x00\x00\x00\x40\xd1\x18\xe0\x4e\x00\x01\x01\x02\x03\x01' >"$work/descriptors"
printf '\x09\x02\x20\x00\x01\x01\x00\x80\x32' >>"$work/descriptors"
printf '\x09\x04\x00\x00\x02\xff\x42\x03\x00' >>"$work/descriptors"
printf '\x07\x05\x81\x02\x00\x02\x00\x07\x05\x01\x02\x00\x02\x00' >>"$work/descriptors"

# The same with adb's interface class, subclass and protocol.
sed 's/\xff\x42\x03/\xff\x42\x01/' "$work/descriptors" >"$work/adb-descriptors"

python3 -I "$here/fake_broker.py" "$T3USB_SOCKET" "$T3USB_ROOT" "1/5=$work/descriptors" "1/6=pty:$work/adb-descriptors" \
  "1/7=late:pty:$work/descriptors" \
  >"$work/broker.log" 2>&1 &
broker=$!
for _ in $(seq 50); do grep -q ready "$work/broker.log" 2>/dev/null && break; sleep 0.1; done

fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if grep -q -- "$expected" <<<"$actual"; then echo "ok    $name"; else
    echo "FAIL  $name: expected '$expected' in:"
    echo "$actual" | sed 's/^/      /'
    fail=1
  fi
}

check "list" "001/005  18d1:4ee0  allowed     Fake Phone (serial FAKE15)" "$("$cli" list)"
check "list shows every device" "001/006" "$("$cli" list)"
check "selftest fd passing" "fd passing works" "$("$cli" selftest 2>&1 || true)"
check "probe reads the descriptor" "id 18d1:4ee0" "$("$cli" probe 1/5)"
check "probe of an unknown device" "not attached" "$("$cli" probe 1/9 2>&1 || true)"
check "sysfs listing is redirected" "1-5" "$(LD_PRELOAD=$lib ls /sys/bus/usb/devices)"
check "devfs node is visible" "005" "$(LD_PRELOAD=$lib ls /dev/bus/usb/001)"
check "fastboot finds the device" "FAKE15.*fastboot" "$(LD_PRELOAD=$lib "$fastboot" devices 2>&1)"
if [ -n "$adb" ]; then
  # A pty cannot claim an interface, so adb stops there. Getting that far means it found the
  # device, named it through /sys/dev/char and read its serial without crashing.
  log=$(ADB_TRACE=usb LD_PRELOAD=$lib timeout 4 "$adb" -P 5099 nodaemon server 2>&1; echo "exit $?")
  check "adb finds the device" "usb located new device /dev/bus/usb/001/006" "$log"
  check "adb reads its serial" "serial ok" "$(grep -q 'usb read .*serial failed' <<<"$log" || echo serial ok)"
  check "adb tries to claim it" "CLAIMINTERFACE" "$log"
  check "adb keeps running" "exit 124" "$log"
fi
# libusb loaded with RTLD_LOCAL, as pyusb loads it: enumeration, a device plugged in later, and an open.
probe=$(PROBE_SECONDS=4 LD_PRELOAD=$lib timeout 30 python3 -I "$here/libusb_probe.py" 1/6 2>&1; echo "exit $?")
check "libusb initialises" "init 0" "$probe"
check "libusb lists allowed devices" "device 1/5 18d1:4ee0" "$probe"
check "libusb hotplug sees a later device" "hotplug 1/7" "$probe"
check "libusb opens a device through the app" "open 1/6 0" "$probe"
check "libusb exits cleanly" "exit ok" "$probe"
if command -v lsusb >/dev/null; then
  # A copy, because Ubuntu's AppArmor profile for /usr/bin/lsusb refuses a preload from a home folder.
  cp "$(command -v lsusb)" "$work/lsusb"
  check "lsusb lists allowed devices" "Bus 001 Device 005: ID 18d1:4ee0" "$(LD_PRELOAD=$lib "$work/lsusb" 2>&1)"
fi
check "other character devices keep their sysfs links" "$(readlink /sys/dev/char/1:3)" "$(LD_PRELOAD=$lib readlink /sys/dev/char/1:3)"
# Android hides /proc/net, so the app learns about TCP listeners from the preload library.
LD_PRELOAD=$lib python3 -I -c 'import socket,time
for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::")):
    s = socket.socket(family); s.bind((host, 0)); s.listen(); print(s.getsockname()[1], flush=True)
u = socket.socket(socket.AF_UNIX); u.bind("\0t3usb-test-unix"); u.listen()
time.sleep(0.5)' >"$work/ports"
sleep 0.5
port4=$(sed -n 1p "$work/ports") port6=$(sed -n 2p "$work/ports")
check "listen on IPv4 is reported" "^listen	$port4	127.0.0.1	0	[0-9]*	[0-9]*$" "$(cat "$work/broker.log")"
check "listen on IPv6 is reported" "^listen	$port6	::	0	" "$(cat "$work/broker.log")"
check "unix sockets are not reported" "^2$" "$(grep -c '^listen' "$work/broker.log")"
check "other paths are untouched" "$(ls /etc | head -1)" "$(LD_PRELOAD=$lib ls /etc | head -1)"
kill "$broker"
broker=
check "app not running" "cannot reach the T3 app" "$("$cli" list 2>&1 || true)"
check "fastboot without the app" "cannot reach the T3 app" "$(LD_PRELOAD=$lib "$fastboot" devices 2>&1)"
exit $fail
