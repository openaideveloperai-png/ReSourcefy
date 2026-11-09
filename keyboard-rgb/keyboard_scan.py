#!/usr/bin/env python3
"""
Keyboard scan: READ-ONLY look at a USB keyboard, including the parts Chrome hides.

  * Default: Holtek keyboards (vendor 0x04d9), e.g. Xinmeng "Mechanical Keyboard" 04d9:1836.
    Another vendor:  py keyboard_scan.py 258a
  * This program contains NO code that sends anything to the keyboard. It only reads
    descriptions and stored values, and listens. It can't change or break the keyboard.
  * No internet. Writes one file: keyboard_scan_log.txt (next to this script).

NEEDS: Python 3 and the "hidapi" package:   py -m pip install hidapi
"""
import os
import sys
import time

try:
    import hid
except ImportError:
    print("The 'hidapi' package is missing. In Command Prompt run:\n    py -m pip install hidapi")
    input("Press Enter to close.")
    sys.exit(1)
if not hasattr(hid, "device"):
    print("Wrong package installed (called 'hid'). Run:\n    py -m pip uninstall hid\n    py -m pip install hidapi")
    input("Press Enter to close.")
    sys.exit(1)

VENDOR = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x04D9
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "keyboard_scan_log.txt")
_log = open(LOG_PATH, "a", encoding="utf-8")


def say(*parts):
    text = " ".join(str(p) for p in parts)
    print(text)
    _log.write(time.strftime("%H:%M:%S ") + text + "\n")
    _log.flush()


def hx(data):
    return " ".join(f"{b:02x}" for b in data)


PAGES = {0x01: "Generic Desktop", 0x07: "Keyboard keys", 0x08: "LEDs (Caps/Num lock)",
         0x09: "Buttons", 0x0C: "Consumer (media keys)"}
NAMES = {(0x01, 0x06): "KEYBOARD (typing)", (0x01, 0x02): "mouse", (0x01, 0x80): "system control (power/sleep)",
         (0x0C, 0x01): "media keys"}


def parse_descriptor(desc):
    """Return ({(kind, report_id): data_bits}, [readable lines])."""
    reports, lines, usages, stack = {}, [], [], []
    page = rid = rsize = rcount = 0
    depth, i = 0, 0
    while i < len(desc):
        b = desc[i]
        if b == 0xFE:
            i += 3 + (desc[i + 1] if i + 1 < len(desc) else 0)
            continue
        size = (0, 1, 2, 4)[b & 3]
        typ, tag = (b >> 2) & 3, (b >> 4) & 0xF
        val = int.from_bytes(bytes(desc[i + 1:i + 1 + size]), "little")
        i += 1 + size
        if typ == 1:
            if tag == 0: page = val
            elif tag == 7: rsize = val
            elif tag == 8: rid = val
            elif tag == 9: rcount = val
            elif tag == 10: stack.append((page, rsize, rcount, rid))
            elif tag == 11 and stack: page, rsize, rcount, rid = stack.pop()
        elif typ == 2:
            if tag == 0:
                usages.append(val if size == 4 else (page << 16) | val)
        elif typ == 0:
            pad = "  " * depth
            if tag in (8, 9, 11):
                kind = {8: "input", 9: "output", 11: "feature"}[tag]
                reports[(kind, rid)] = reports.get((kind, rid), 0) + rsize * rcount
                lines.append(f"{pad}{kind:7} report ID {rid:#04x}: {rcount} x {rsize} bits"
                             f"{' (padding)' if val & 1 else ''}  page {page:#06x}")
            elif tag == 10:
                u = usages[0] if usages else (page << 16)
                name = NAMES.get((u >> 16, u & 0xFFFF)) or PAGES.get(u >> 16) or \
                    ("VENDOR-DEFINED (settings channel?)" if (u >> 16) >= 0xFF00 else "")
                lines.append(f"{pad}collection: page {u >> 16:#06x} usage {u & 0xFFFF:#04x}  {name}")
                depth += 1
            elif tag == 12:
                depth = max(0, depth - 1)
            usages = []
    return reports, lines


def collections():
    found = list(hid.enumerate(VENDOR, 0))
    found.sort(key=lambda d: (d.get("product_id", 0), d.get("interface_number", -1), d.get("usage_page", 0)))
    return found


def describe(d):
    page, usage = d.get("usage_page", 0), d.get("usage", 0)
    name = NAMES.get((page, usage)) or ("VENDOR-DEFINED" if page >= 0xFF00 else PAGES.get(page, ""))
    return f"{d['product_id']:04x} interface {d.get('interface_number')}  page {page:#06x} usage {usage:#04x} {name}"


def scan():
    cols = collections()
    if not cols:
        say(f"No device from vendor {VENDOR:#06x} found. Is the keyboard plugged in?")
        return
    say(f"\n=== SCAN (read-only), vendor {VENDOR:#06x} ===")
    seen = set()
    for d in cols:
        key = d["product_id"]
        if key not in seen:
            seen.add(key)
            say(f"\nDevice {d['vendor_id']:04x}:{d['product_id']:04x}  {d.get('manufacturer_string')!r} "
                f"{d.get('product_string')!r}  firmware/release {d.get('release_number', 0):#06x}")
        say(f"\n  [{describe(d)}]")
        try:
            dev = hid.device()
            dev.open_path(d["path"])
        except Exception as e:
            say(f"    can't open: {e}")
            continue
        try:
            try:
                desc = list(dev.get_report_descriptor())
            except Exception:
                desc = None
            if desc:
                reports, lines = parse_descriptor(desc)
                for line in lines:
                    say("    " + line)
                feats = {rid: bits // 8 for (kind, rid), bits in reports.items() if kind == "feature"}
            else:
                say("    (description not available)")
                feats = {}
            for rid, length in feats.items():
                try:
                    data = dev.get_feature_report(rid, length + 1)
                    say(f"    feature {rid:#04x} holds: {hx(data)}")
                except Exception as e:
                    say(f"    feature {rid:#04x} read failed: {e}")
            if desc and not feats:
                say("    no feature reports (no settings channel here)")
        finally:
            dev.close()
    say("\nScan done. Saved to keyboard_scan_log.txt")


def watch():
    say("\n=== WATCH (read-only) ===")
    say("Change the lights with the Fn key combinations. Anything the keyboard sends is shown.")
    say("Normal typing on the main keyboard part is hidden by Windows. Press Ctrl+C to stop.\n")
    opened = []
    for d in collections():
        try:
            dev = hid.device()
            dev.open_path(d["path"])
            dev.set_nonblocking(1)
            opened.append((d, dev))
        except Exception:
            pass
    try:
        while True:
            for d, dev in opened:
                try:
                    data = dev.read(64)
                except Exception:
                    data = None
                if data:
                    say(f"IN [{describe(d)}]  {hx(data)}")
            time.sleep(0.005)
    except KeyboardInterrupt:
        say("Stopped watching.")
    finally:
        for _, dev in opened:
            dev.close()


def main():
    say(f"\n===== Keyboard scan started {time.strftime('%Y-%m-%d')} =====")
    while True:
        print("\n  1) Scan the keyboard   (read-only)\n  2) Watch the keyboard  (read-only)\n  q) Quit\n")
        try:
            choice = input("Choose: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break
        if choice == "1":
            scan()
        elif choice == "2":
            watch()
        elif choice == "q":
            break
    say(f"Log saved to {LOG_PATH}")


if __name__ == "__main__":
    main()
