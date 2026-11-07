"""Stands in for the app's USB broker in tests: serves descriptor files as if they were usbfs fds.

Usage: fake_broker.py SOCKET_NAME ROOT BUS/DEV=[pty:]DESCRIPTOR_FILE...
Writes the fake sysfs/devfs tree under ROOT like UsbBridge.kt does, then serves until killed.
With pty:, the fd is a pty that reads the descriptors, so it is a character device like usbfs.
"""

import os
import socket
import sys
import threading
import tty

name, root, *specs = sys.argv[1:]
devices = {}
for spec in specs:
    address, path = spec.split("=", 1)
    bus, dev = (int(part) for part in address.split("/"))
    devices[(bus, dev)] = path
    sysfs = os.path.join(root, f"sys/bus/usb/devices/{bus}-{dev}")
    os.makedirs(sysfs, exist_ok=True)
    for field, value in (("busnum", bus), ("devnum", dev), ("serial", f"FAKE{bus}{dev}"), ("bConfigurationValue", 1)):
        with open(os.path.join(sysfs, field), "w") as handle:
            handle.write(f"{value}\n")
    node = os.path.join(root, f"dev/bus/usb/{bus:03d}")
    os.makedirs(node, exist_ok=True)
    open(os.path.join(node, f"{dev:03d}"), "w").close()


masters = []


def serve(connection):
    with connection:
        request = connection.makefile("r").readline().rstrip("\n").split("\t")
        if request[0] == "open":
            path = devices.get((int(request[1]), int(request[2])))
            if path is None:
                connection.sendall(b"error\tnot attached\n")
                return
            if path.startswith("pty:"):
                master, fd = os.openpty()
                tty.setraw(fd)
                os.write(master, open(path[4:], "rb").read())
                masters.append(master)
                rdev = os.fstat(fd).st_rdev
                link = os.path.join(root, f"sys/dev/char/{os.major(rdev)}:{os.minor(rdev)}")
                os.makedirs(os.path.dirname(link), exist_ok=True)
                if not os.path.lexists(link):
                    os.symlink(f"../../bus/usb/devices/{request[1]}-{request[2]}", link)
            else:
                fd = os.open(path, os.O_RDONLY)
            socket.send_fds(connection, [b"ok\n"], [fd])
            os.close(fd)
        elif request[0] == "list":
            for bus, dev in devices:
                connection.sendall(f"device\t{bus}\t{dev}\t6353\t20192\t1\tFake\tPhone\tFAKE{bus}{dev}\n".encode())
            connection.sendall(b"end\n")
        elif request[0] == "watch":
            for bus, dev in devices:
                connection.sendall(f"add\t{bus}\t{dev}\n".encode())
            connection.sendall(b"ready\n")
            connection.recv(1)
        elif request[0] == "selftest":
            read, write = os.pipe()
            os.write(write, b"fd passing works\n")
            os.close(write)
            socket.send_fds(connection, [b"ok\n"], [read])
            os.close(read)


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind("\0" + name)
server.listen()
print("ready", flush=True)
while True:
    connection, _ = server.accept()
    threading.Thread(target=serve, args=(connection,), daemon=True).start()
