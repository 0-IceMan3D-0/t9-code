"""Lists devices through libusb loaded the way pyusb loads it (ctypes, RTLD_LOCAL), and waits for hotplug.

Usage: libusb_probe.py [OPEN_BUS/DEV]   prints "init 0", one "device B/D VID:PID" per device,
"hotplug B/D" for each device the hotplug callback reports, and "open B/D <code>" if asked.
"""

import ctypes
import ctypes.util
import os
import sys
import time

usb = ctypes.CDLL(ctypes.util.find_library("usb-1.0") or "libusb-1.0.so.0")
context = ctypes.c_void_p()
print("init", usb.libusb_init(ctypes.byref(context)), flush=True)

listing = ctypes.POINTER(ctypes.c_void_p)()
count = usb.libusb_get_device_list(context, ctypes.byref(listing))
descriptor = (ctypes.c_uint8 * 18)()
devices = {}
for index in range(max(count, 0)):
    device = listing[index]
    usb.libusb_get_device_descriptor(ctypes.c_void_p(device), descriptor)
    bus = usb.libusb_get_bus_number(ctypes.c_void_p(device))
    address = usb.libusb_get_device_address(ctypes.c_void_p(device))
    devices[f"{bus}/{address}"] = device
    vendor = descriptor[8] | descriptor[9] << 8
    product = descriptor[10] | descriptor[11] << 8
    print(f"device {bus}/{address} {vendor:04x}:{product:04x}", flush=True)

CALLBACK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p)


def arrived(_context, device, _event, _data):
    print(f"hotplug {usb.libusb_get_bus_number(ctypes.c_void_p(device))}/"
          f"{usb.libusb_get_device_address(ctypes.c_void_p(device))}", flush=True)
    return 0


callback = CALLBACK(arrived)
handle = ctypes.c_int()
# Arrived, enumerate existing devices, any vendor, product and class.
print("hotplug register", usb.libusb_hotplug_register_callback(
    context, 1, 1, -1, -1, -1, callback, None, ctypes.byref(handle)), flush=True)
deadline = time.time() + float(os.environ.get("PROBE_SECONDS", "1"))
timeout = (ctypes.c_long * 2)(0, 200000)
while time.time() < deadline:
    usb.libusb_handle_events_timeout(context, timeout)

if len(sys.argv) > 1 and sys.argv[1] in devices:
    opened = ctypes.c_void_p()
    print("open", sys.argv[1], usb.libusb_open(ctypes.c_void_p(devices[sys.argv[1]]), ctypes.byref(opened)), flush=True)
    if opened:
        usb.libusb_close(opened)
usb.libusb_free_device_list(listing, 1)
usb.libusb_exit(context)
print("exit ok", flush=True)
