#!/usr/bin/env python3
"""
GP4 mouse test for Linux (for example an Ubuntu "Try Ubuntu" live USB).
No extra packages needed. Run with:   sudo python3 gp4_linux_test.py

It only ever sends the scroll-wheel volume test (07 11 01 ...) and the
"normal scrolling" command (07 11 00 ...). It never touches DPI or buttons.
Unplugging the mouse undoes everything.

Why this exists: Windows and Chrome only let us send report 7 with exactly
8 bytes. The Linux A704F tool sends something odd instead: a 16-byte buffer
starting with 0x21 (a copied USB setup header) followed by the real command.
Linux allows that, so this script tries both ways on every interface.
"""
import fcntl
import glob
import os
import re
import sys
import time

VID, PID = 0x18F8, 0x0F99


def ioc(direction, nr, size):
    # _IOC(dir, 'H', nr, size) from <linux/hidraw.h>
    return (direction << 30) | (size << 16) | (ord("H") << 8) | nr


def set_feature(fd, buf):
    fcntl.ioctl(fd, ioc(3, 0x06, len(buf)), bytearray(buf))


def get_feature(fd, report_id, size):
    buf = bytearray(size)
    buf[0] = report_id
    n = fcntl.ioctl(fd, ioc(3, 0x07, size), buf, True)
    return bytes(buf[: n if isinstance(n, int) and n > 0 else size])


def find_devices():
    found = []
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            uevent = open(os.path.join(node, "device", "uevent")).read()
        except OSError:
            continue
        m = re.search(r"HID_ID=\w+:0*([0-9A-Fa-f]+):0*([0-9A-Fa-f]+)", uevent)
        if not m or int(m.group(1), 16) != VID or int(m.group(2), 16) != PID:
            continue
        path = os.path.realpath(os.path.join(node, "device"))
        iface = re.search(r":\d+\.(\d+)/", path)
        found.append(("/dev/" + os.path.basename(node), iface.group(1) if iface else "?"))
    return found


def standard(cmd):
    # What Windows/Chrome send: report ID 07 + 7 data bytes.
    return bytes([0x07] + cmd + [0] * (7 - len(cmd)))


def linux_tool_style(cmd):
    # Exactly what the A704F Linux tool sends (hidhelper.cpp, sendRawMouseReport).
    return bytes([0x21, 0x09, 0x07, 0x03, 0x01, 0x00, 0x08, 0x00, 0x07] + cmd + [0] * (7 - len(cmd)))


def ask(q):
    while True:
        a = input(q + " [y/n] ").strip().lower()
        if a in ("y", "n"):
            return a == "y"


def main():
    if os.geteuid() != 0:
        print("Please run with sudo:  sudo python3 gp4_linux_test.py")
        sys.exit(1)
    devs = find_devices()
    if not devs:
        print("No 18f8:0f99 mouse found. Is it plugged in?")
        sys.exit(1)
    print("Found:", ", ".join(f"{p} (interface {i})" for p, i in devs))
    results = []
    for path, iface in devs:
        for style_name, build in (("standard 8-byte", standard), ("Linux-tool 16-byte", linux_tool_style)):
            print(f"\n=== {path}, interface {iface}, {style_name} packet ===")
            try:
                fd = os.open(path, os.O_RDWR)
            except OSError as e:
                print("  could not open:", e)
                continue
            try:
                pkt = build([0x11, 0x01, 0x00])
                print("  sending", pkt.hex(" "))
                set_feature(fd, pkt)
            except OSError as e:
                print("  rejected:", e)
                os.close(fd)
                results.append((path, iface, style_name, "rejected"))
                continue
            try:
                print("  read back:", get_feature(fd, 0x07, 8).hex(" "))
            except OSError as e:
                print("  read back failed:", e)
            print("  Now roll the scroll wheel a few notches (in any window).")
            worked = ask("  Did the system volume change?")
            results.append((path, iface, style_name, "WORKED" if worked else "no effect"))
            # Always put scrolling back, using both styles to be safe.
            for b in (standard, linux_tool_style):
                try:
                    set_feature(fd, b([0x11, 0x00, 0x00]))
                except OSError:
                    pass
            os.close(fd)
            time.sleep(0.3)
    print("\n===== SUMMARY (copy everything below and share it) =====")
    for r in results:
        print(f"{r[0]}  interface {r[1]}  {r[2]}: {r[3]}")


if __name__ == "__main__":
    main()
