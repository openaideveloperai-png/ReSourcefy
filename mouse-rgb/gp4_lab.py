#!/usr/bin/env python3
"""
GP4 mouse lab: study how the Gammec GP4 (USB 18f8:0f99) works, on Windows.

WHAT THIS PROGRAM DOES
  * Talks ONLY to USB devices from vendor 0x18f8 (your mouse). Nothing else.
  * No internet. No installs. Writes one file: gp4_lab_log.txt (next to this script).
  * Options 1 and 2 only READ from the mouse. They can't change anything.
  * Option 3 sends the known A704F "volume scroll" test, then always switches
    scrolling back to normal.
  * Option 4 (expert) sends experimental commands one at a time, only when
    you press Enter, and records what happens.

UNDO ANYTHING: unplug the mouse and plug it back in.

NEEDS: Python 3 and the "hidapi" package:   py -m pip install hidapi
(Install "hidapi", NOT the package called "hid".)
"""
import json
import os
import sys
import time

VENDOR = 0x18F8
HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "gp4_lab_log.txt")
PROGRESS_PATH = os.path.join(HERE, "gp4_lab_progress.json")

try:
    import hid
except ImportError:
    print("The 'hidapi' package is missing. In Command Prompt run:\n    py -m pip install hidapi")
    input("Press Enter to close.")
    sys.exit(1)
if not hasattr(hid, "device"):
    print("You have the wrong package (called 'hid'). Run these two commands:\n"
          "    py -m pip uninstall hid\n    py -m pip install hidapi")
    input("Press Enter to close.")
    sys.exit(1)


# ---------------------------------------------------------------- logging
_log = open(LOG_PATH, "a", encoding="utf-8")


def say(*parts):
    text = " ".join(str(p) for p in parts)
    print(text)
    _log.write(time.strftime("%H:%M:%S ") + text + "\n")
    _log.flush()


def ask(prompt):
    answer = input(prompt)
    _log.write(time.strftime("%H:%M:%S ") + prompt + answer + "\n")
    _log.flush()
    return answer.strip()


def yes(prompt):
    while True:
        a = ask(prompt + " [y/n] ").lower()
        if a in ("y", "n"):
            return a == "y"


def hx(data):
    return " ".join(f"{b:02x}" for b in data)


# ---------------------------------------------------------------- report descriptor
USAGE_PAGES = {0x01: "Generic Desktop", 0x07: "Keyboard", 0x08: "LEDs", 0x09: "Buttons",
               0x0C: "Consumer (media keys)"}


def parse_descriptor(desc):
    """Return ({(kind, report_id): data_bits}, [readable lines])."""
    reports, lines, usages, stack = {}, [], [], []
    page = rid = rsize = rcount = 0
    depth, i = 0, 0
    while i < len(desc):
        b = desc[i]
        if b == 0xFE:                      # long item (rare), skip it
            i += 3 + (desc[i + 1] if i + 1 < len(desc) else 0)
            continue
        size = (0, 1, 2, 4)[b & 3]
        typ, tag = (b >> 2) & 3, (b >> 4) & 0xF
        val = int.from_bytes(bytes(desc[i + 1:i + 1 + size]), "little")
        i += 1 + size
        if typ == 1:                       # global items
            if tag == 0: page = val
            elif tag == 7: rsize = val
            elif tag == 8: rid = val
            elif tag == 9: rcount = val
            elif tag == 10: stack.append((page, rsize, rcount, rid))
            elif tag == 11 and stack: page, rsize, rcount, rid = stack.pop()
        elif typ == 2:                     # local items
            if tag == 0:
                usages.append(val if size == 4 else (page << 16) | val)
        elif typ == 0:                     # main items
            pad = "  " * depth
            if tag in (8, 9, 11):
                kind = {8: "input", 9: "output", 11: "feature"}[tag]
                reports[(kind, rid)] = reports.get((kind, rid), 0) + rsize * rcount
                const = " (padding)" if val & 1 else ""
                lines.append(f"{pad}{kind:7} report ID {rid:#04x}: {rcount} x {rsize} bits{const}"
                             f"  usages: {', '.join(f'{u:#x}' for u in usages[:4]) or '-'}")
            elif tag == 10:
                u = usages[0] if usages else (page << 16)
                name = USAGE_PAGES.get(u >> 16, "vendor-defined" if (u >> 16) >= 0xFF00 else "")
                lines.append(f"{pad}collection: usage page {u >> 16:#06x} usage {u & 0xFFFF:#04x} {name}")
                depth += 1
            elif tag == 12:
                depth = max(0, depth - 1)
            usages = []
    return reports, lines


# ---------------------------------------------------------------- device helpers
def list_collections():
    """Every HID collection of the mouse, sorted by interface."""
    found = [d for d in hid.enumerate(VENDOR, 0)]
    found.sort(key=lambda d: (d.get("interface_number", -1), d.get("usage_page", 0), d.get("usage", 0)))
    return found


def open_path(path):
    dev = hid.device()
    dev.open_path(path)
    return dev


def get_descriptor(dev):
    try:
        return list(dev.get_report_descriptor())
    except Exception:
        return None


def feature_reports(dev, desc):
    """{report_id: number of data bytes (without the ID byte)}. Uses read-only GET requests."""
    found = {}
    if desc:
        reports, _ = parse_descriptor(desc)
        ids = sorted(rid for (kind, rid) in reports if kind == "feature")
        for rid in ids:
            found[rid] = reports[("feature", rid)] // 8
        return found
    # No descriptor available: ask for each ID. Undeclared IDs are just refused.
    for rid in range(256):
        try:
            data = dev.get_feature_report(rid, 65)
            if data and len(data) > 1:
                found[rid] = len(data) - 1   # hidapi puts the report ID first
        except Exception:
            pass
    return found


def read_feature(dev, rid, length):
    try:
        return bytes(dev.get_feature_report(rid, length + 1))
    except Exception as e:
        return f"(read failed: {e})"


def send_feature(dev, data):
    """Returns None on success or an error message."""
    try:
        n = dev.send_feature_report(list(data))
        return None if n is None or n >= 0 else f"refused (code {n})"
    except Exception as e:
        return str(e)


def is_blocked(payload):
    # A704F scroll debug value 0d makes the wheel spam the z key. Never send it.
    for k in range(len(payload) - 2):
        if payload[k] == 0x11 and payload[k + 1] == 0x02 and payload[k + 2] == 0x0D:
            return True
    return False


def describe(d):
    return (f"interface {d.get('interface_number')}  usage page {d.get('usage_page', 0):#06x} "
            f"usage {d.get('usage', 0):#04x}")


# ---------------------------------------------------------------- 1. scan
def scan():
    cols = list_collections()
    if not cols:
        say("No mouse from vendor 0x18f8 found. Is it plugged in?")
        return []
    first = cols[0]
    say("\n=== SCAN (read-only) ===")
    say(f"Product: {first.get('manufacturer_string')!r} {first.get('product_string')!r}  "
        f"id {first['vendor_id']:04x}:{first['product_id']:04x}  "
        f"firmware/release {first.get('release_number', 0):#06x}")
    results = []
    for n, d in enumerate(cols, 1):
        say(f"\n[{n}] {describe(d)}")
        try:
            dev = open_path(d["path"])
        except Exception as e:
            say(f"    can't open: {e}")
            results.append((d, None, {}))
            continue
        desc = get_descriptor(dev)
        if desc:
            for line in parse_descriptor(desc)[1]:
                say("    " + line)
        else:
            say("    (descriptor not available; asking for feature reports one by one)")
        feats = feature_reports(dev, desc)
        for rid, length in feats.items():
            now = read_feature(dev, rid, length)
            shown = hx(now) if isinstance(now, bytes) else now
            say(f"    feature report {rid:#04x} ({length} data bytes), holds: {shown}")
        if not feats:
            say("    no feature reports")
        dev.close()
        results.append((d, desc, feats))
    say("\nScan done. Saved to gp4_lab_log.txt")
    return results


# ---------------------------------------------------------------- 2. watch
def watch():
    say("\n=== WATCH (read-only) ===")
    say("Press the DPI button, side buttons, roll the wheel, and watch the light.")
    say("Every message the mouse sends, and any change in its stored settings, is shown.")
    say("Press Ctrl+C to stop.\n")
    opened = []
    for d in list_collections():
        try:
            dev = open_path(d["path"])
            dev.set_nonblocking(1)
            feats = feature_reports(dev, get_descriptor(dev))
            last = {rid: read_feature(dev, rid, ln) for rid, ln in feats.items()}
            opened.append((d, dev, feats, last))
        except Exception:
            pass
    if not opened:
        say("Couldn't open any part of the mouse.")
        return
    t_poll = 0
    try:
        while True:
            for d, dev, feats, last in opened:
                try:
                    data = dev.read(64)
                except Exception:
                    data = None
                if data:
                    say(f"IN  [{describe(d)}]  {hx(data)}")
                if time.time() - t_poll > 0.5:
                    for rid, ln in feats.items():
                        now = read_feature(dev, rid, ln)
                        if now != last[rid]:
                            say(f"CHANGED feature {rid:#04x} [{describe(d)}]: {hx(now) if isinstance(now, bytes) else now}")
                            last[rid] = now
            if time.time() - t_poll > 0.5:
                t_poll = time.time()
            time.sleep(0.005)
    except KeyboardInterrupt:
        say("Stopped watching.")
    finally:
        for _, dev, _, _ in opened:
            dev.close()


# ---------------------------------------------------------------- 3. A704F test on every interface
def a704_payloads(rid, length):
    """The A704F command '07 11 SC 00..' laid out for this report."""
    def build(sc):
        # Report 7 already carries the 07. Any other report gets 07 as its first data byte.
        body = ([] if rid == 7 else [7]) + [0x11, sc, 0x00]
        body = (body + [0] * length)[:length]
        return bytes([rid] + body)
    return build(0x01), build(0x00)


def a704_test():
    say("\n=== A704F VOLUME TEST ON EVERY INTERFACE ===")
    say("This tries the volume-scroll command on each part of the mouse that accepts settings,")
    say("including the part Chrome hid. Scrolling is always switched back afterwards.")
    tested = 0
    for d in list_collections():
        try:
            dev = open_path(d["path"])
        except Exception:
            continue
        feats = feature_reports(dev, get_descriptor(dev))
        for rid, length in feats.items():
            if length < (3 if rid == 7 else 4):
                continue
            on, off = a704_payloads(rid, length)
            say(f"\n-- {describe(d)}, feature report {rid:#04x}")
            if not yes("Send the volume test here?"):
                continue
            tested += 1
            err = send_feature(dev, on)
            say(f"OUT {hx(on)}  {'OK' if not err else 'FAILED: ' + err}")
            try:
                if not err:
                    ask("Roll the wheel a few notches now, then press Enter. ")
                    worked = yes("Did the Windows volume change?")
                    say("RESULT:", "WORKED" if worked else "no effect")
            finally:
                err2 = send_feature(dev, off)
                say(f"OUT {hx(off)}  normal scrolling {'OK' if not err2 else 'FAILED: ' + err2}")
        dev.close()
    if not tested:
        say("No interface accepted settings (or you skipped them all).")


# ---------------------------------------------------------------- 4. careful probe
PROBE_HELP = """
Keys after each packet (type the letter, then Enter):
  Enter = send the next value      r = send this value again
  l     = the LIGHT changed!       o = something ELSE changed (pointer speed, buttons...)
  b     = go back one value        q = stop (progress is saved)
"""


def choose_target():
    options = []
    for d in list_collections():
        try:
            dev = open_path(d["path"])
        except Exception:
            continue
        for rid, length in feature_reports(dev, get_descriptor(dev)).items():
            options.append((d, rid, length))
        dev.close()
    if not options:
        say("No part of the mouse accepts settings.")
        return None
    for n, (d, rid, length) in enumerate(options, 1):
        say(f"  {n}) {describe(d)}, feature report {rid:#04x}, {length} data bytes")
    pick = ask("Which one? ")
    if not pick.isdigit() or not 1 <= int(pick) <= len(options):
        return None
    return options[int(pick) - 1]


def probe():
    say("\n=== CAREFUL PROBE (expert) ===")
    say("This sends commands nobody has documented for your mouse, one at a time.")
    say("Most likely result: nothing happens. Possible: the light, pointer speed or a button")
    say("changes until you unplug and replug the mouse. Keep your keyboard handy: this")
    say("program works without the mouse. A permanent change is unlikely but can't be ruled out.")
    if ask('Type "I UNDERSTAND" to continue: ') != "I UNDERSTAND":
        say("Cancelled.")
        return
    target = choose_target()
    if not target:
        return
    d, rid, length = target
    body_len = length

    state = {}
    if os.path.exists(PROGRESS_PATH):
        try:
            state = json.load(open(PROGRESS_PATH))
        except Exception:
            state = {}
    default_tpl = state.get("template") or " ".join(["00"] * body_len)
    say(f"\nTemplate = the {body_len} bytes sent after the report ID. One position is changed each step.")
    tpl_txt = ask(f"Template [{default_tpl}]: ") or default_tpl
    try:
        tpl = [int(x, 16) for x in tpl_txt.split()]
        assert len(tpl) == body_len and all(0 <= v <= 255 for v in tpl)
    except Exception:
        say(f"Need exactly {body_len} hex bytes like: {default_tpl}")
        return
    pos = int(ask(f"Which position to change, 1-{body_len} [{state.get('pos', 1)}]: ") or state.get("pos", 1)) - 1
    start = int(ask(f"Start value in hex [{state.get('next', 0):02x}]: ") or f"{state.get('next', 0):02x}", 16)
    stop = int(ask("End value in hex [ff]: ") or "ff", 16)
    if not (0 <= pos < body_len and 0 <= start <= stop <= 255):
        say("Values out of range.")
        return

    dev = open_path(d["path"])
    say(PROBE_HELP)
    value = start
    findings = []
    try:
        while value <= stop:
            body = list(tpl)
            body[pos] = value
            pkt = bytes([rid] + body)
            if is_blocked(pkt):
                say(f"SKIP {hx(pkt)} (blocked: z-key spam)")
                value += 1
                continue
            err = send_feature(dev, pkt)
            if err:
                say(f"OUT {hx(pkt)}  FAILED: {err}")
                if "disconnect" in err.lower() or "device" in err.lower():
                    findings.append(f"{hx(pkt)}  mouse disconnected or reset")
            back = read_feature(dev, rid, length)
            same = isinstance(back, bytes) and back[-body_len:] == bytes(body)
            note = "" if same else "   <-- READ-BACK DIFFERENT, interesting!"
            say(f"OUT {hx(pkt)}   READ {hx(back) if isinstance(back, bytes) else back}{note}")
            if note:
                findings.append(f"{hx(pkt)}  read-back: {hx(back) if isinstance(back, bytes) else back}")
            json.dump({"template": tpl_txt, "pos": pos + 1, "next": value + 1}, open(PROGRESS_PATH, "w"))
            key = ask("> ").lower()
            if key == "q":
                break
            if key == "r":
                continue
            if key == "b":
                value = max(start, value - 1)
                continue
            if key in ("l", "o"):
                what = ask("Describe what changed: ")
                findings.append(f"{hx(pkt)}  {'LIGHT' if key == 'l' else 'OTHER'}: {what}")
                say("Recorded. Tip: unplug and replug the mouse to reset it, then press Enter to continue.")
                ask("")
                try:
                    dev.close()
                except Exception:
                    pass
                dev = reopen(d)
                if dev is None:
                    break
            value += 1
    except KeyboardInterrupt:
        say("Stopped.")
    finally:
        try:
            dev.close()
        except Exception:
            pass
    say("\nFINDINGS:" if findings else "\nNo findings this run.")
    for f in findings:
        say("  " + f)


def reopen(d):
    for _ in range(20):
        for c in list_collections():
            if (c.get("interface_number"), c.get("usage_page"), c.get("usage")) == \
               (d.get("interface_number"), d.get("usage_page"), d.get("usage")):
                try:
                    return open_path(c["path"])
                except Exception:
                    pass
        time.sleep(0.5)
    say("Couldn't find the mouse again. Plug it in and start the probe again (progress is saved).")
    return None


# ---------------------------------------------------------------- control part helpers
def open_control():
    """Open the part of the mouse that takes settings (interface 1, usage page 0xff01, report 7)."""
    for d in list_collections():
        if d.get("usage_page") == 0xFF01:
            try:
                return open_path(d["path"])
            except Exception as e:
                say(f"Can't open the mouse's settings part: {e}")
                return None
    say("Couldn't find the mouse's settings part. Is it plugged in?")
    return None


def cmd(dev, body, label):
    """Send one A704F command: 07 + up to 7 bytes. Returns True if the mouse accepted it."""
    pkt = bytes(([7] + list(body) + [0] * 7)[:8])
    if is_blocked(pkt):
        say(f"SKIP {hx(pkt)} (blocked)")
        return False
    err = send_feature(dev, pkt)
    say(f"OUT {hx(pkt)}  {label}  {'OK' if not err else 'FAILED: ' + err}")
    return not err


# ---------------------------------------------------------------- 5. lighting
LIGHT_MODES = [("1", 0x10, "Breathing, slow (6 s)"), ("2", 0x11, "Breathing, slower (5 s)"),
               ("3", 0x12, "Breathing, medium (4 s)"), ("4", 0x13, "Breathing, fast (3 s)"),
               ("5", 0x14, "Breathing, faster (2 s)"), ("6", 0x15, "Breathing, very fast (1 s)"),
               ("s", 0x16, "Static (light stays on)"), ("o", 0x17, "Off")]
# Wheel-triggered effects: they happen when you ROLL the wheel. 0d (z-key spam) is never used.
FLASHES = [("f", 0x09, "Flash"), ("r", 0x10, "Flash red"), ("u", 0x12, "Flash blue"),
           ("m", 0x13, "Flash magenta"), ("k", 0x11, "Blink off and on"), ("t", 0x08, "Toggle light on/off")]


def lighting():
    dev = open_control()
    if not dev:
        return
    try:
        while True:
            print("\n  LIGHTING (changes last until you unplug the mouse)")
            for key, _, name in LIGHT_MODES:
                print(f"   {key}) {name}")
            print("   -- wheel effects: you roll the wheel to trigger them --")
            for key, _, name in FLASHES:
                print(f"   {key}) {name}")
            print("   z) Freeze on a colour (restart the cycle, wait, then switch to static)")
            print("   b) Back to the main menu")
            choice = ask("Choose: ").lower()
            if choice in ("b", ""):
                break
            mode = next((m for m in LIGHT_MODES if m[0] == choice), None)
            flash = next((f for f in FLASHES if f[0] == choice), None)
            if mode:
                cmd(dev, [0x13, 0x7F, mode[1]], mode[2])
            elif flash:
                if cmd(dev, [0x11, 0x02, flash[1]], f"wheel = {flash[2]}"):
                    try:
                        ask("Roll the wheel now and watch the light. Press Enter when done. ")
                    finally:
                        cmd(dev, [0x11, 0x00, 0x00], "normal scrolling")
            elif choice == "z":
                freeze(dev)
    finally:
        dev.close()


def freeze(dev):
    speed = ask("Breathing speed 1-6 (1 = slowest) [1]: ") or "1"
    wait = ask("Seconds to wait before freezing, e.g. 2.5 [2]: ") or "2"
    try:
        code = 0x0F + int(speed)
        seconds = float(wait)
        assert 0x10 <= code <= 0x15 and 0 <= seconds <= 60
    except Exception:
        say("Please type a speed from 1 to 6 and a number of seconds.")
        return
    if cmd(dev, [0x13, 0x7F, code], "restart breathing"):
        time.sleep(seconds)
        cmd(dev, [0x13, 0x7F, 0x16], "static (freeze)")
        say("If the light always freezes on the same colour, static is a fixed colour on this mouse.")


# ---------------------------------------------------------------- 6. read-back experiment
def readback_experiment():
    say("\n=== WHY DID THE CHROME PAGE FAIL? ===")
    say("The Chrome page read the mouse's memory 60 ms after each command. This program doesn't.")
    say("This sends the volume command twice: once WITH that read-back, once WITHOUT.")
    say("Scrolling is switched back to normal after each test.")
    dev = open_control()
    if not dev:
        return
    results = {}
    try:
        for name, read_back in (("WITH read-back", True), ("WITHOUT read-back", False)):
            say(f"\n-- Test {name}")
            ask("Press Enter to send. ")
            if not cmd(dev, [0x11, 0x01, 0x00], "volume scrolling"):
                continue
            if read_back:
                time.sleep(0.06)
                back = read_feature(dev, 7, 7)
                say(f"READ {hx(back) if isinstance(back, bytes) else back}")
            try:
                ask("Roll the wheel a few notches, then press Enter. ")
                results[name] = yes("Did the Windows volume change?")
            finally:
                cmd(dev, [0x11, 0x00, 0x00], "normal scrolling")
                time.sleep(0.3)
    finally:
        dev.close()
    w, wo = results.get("WITH read-back"), results.get("WITHOUT read-back")
    say("\nRESULT: with read-back =", "worked" if w else "no effect", "| without =", "worked" if wo else "no effect")
    if wo and not w:
        say("=> Reading right after sending cancels the command. The Chrome lighting page")
        say("   (gp4-rgb.html) doesn't read back, so it should work. Option 5 here works too.")
    elif w and wo:
        say("=> Read-back isn't the problem. Chrome itself is the difference. Use option 5 here.")
    elif not w and not wo:
        say("=> Neither worked this time. Unplug and replug the mouse, then try option 3 again.")


# ---------------------------------------------------------------- 7. guided lighting search
# A704F commands that are NOT lighting. They change DPI, buttons, scrolling, fire speed or
# press keys, so the search never sends them.
SKIP_CMDS = {0x09, 0x10, 0x11, 0x12, 0x15, 0x17}


def wait_control(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        for d in list_collections():
            if d.get("usage_page") == 0xFF01:
                try:
                    return open_path(d["path"])
                except Exception:
                    pass
        time.sleep(0.5)
    say("Couldn't find the mouse. Plug it in and start option 7 again.")
    return None


def run_sequence(dev, packets, interval):
    """Send packets one by one. Ctrl+C stops. Returns (index of last sent, stopped by user)."""
    last = -1
    try:
        for i, (body, label) in enumerate(packets):
            cmd(dev, body, f"[{i + 1}/{len(packets)}] {label}")
            last = i
            time.sleep(interval)
    except KeyboardInterrupt:
        say("Stopped by you.")
        return last, True
    return last, False


def confirm(dev, packets, last):
    """Replay the last few packets one at a time to find the one that changed the light."""
    cands = packets[max(0, last - 3):last + 1]
    say("The change was caused by one of these: " + ", ".join(lbl for _, lbl in cands))
    say("Now we test them one at a time.")
    for body, label in reversed(cands):
        ask("Unplug the mouse, plug it back in, wait until the light looks normal, then press Enter. ")
        try:
            dev.close()
        except Exception:
            pass
        dev = wait_control()
        if not dev:
            return None
        cmd(dev, body, f"test {label}")
        if yes("Did the light change now?"):
            what = ask("What did it do? ")
            say(f"FOUND: {hx(bytes([7] + body))}  ->  {what}")
            return dev
    say("None of them did it on its own. Note what you saw and send the log.")
    return dev


def light_search():
    say("\n=== GUIDED SEARCH FOR THE LIGHTING COMMAND ===")
    say("Your mouse obeys the A704F scroll command but ignores its lighting command.")
    say("This sends lighting-style commands one per second and you watch the light.")
    say("THE MOMENT THE LIGHT CHANGES IN ANY WAY (off, colour, speed, freezes), PRESS Ctrl+C.")
    say("It never sends DPI, button, fire-speed or key commands. Unplug/replug undoes everything.")
    stage_a = [([0x13, b, 0x17], f"13 {b:02x} 17") for b in range(256) if b != 0x7F]
    cmds = [c for c in range(0x00, 0x30) if c not in SKIP_CMDS and c != 0x13]
    stage_b = []
    for c in cmds:
        stage_b += [([c, 0x7F, 0x17], f"{c:02x} 7f 17"), ([c, 0x17], f"{c:02x} 17")]
    stages = [("A", "the A704F lighting command (13) with a different second byte, about 4 minutes", stage_a, False),
              ("B", "other command numbers with an 'off' value, about 1.5 minutes (unknown commands)", stage_b, True)]
    dev = None
    try:
        for name, desc, packets, unknown in stages:
            say(f"\n-- Stage {name}: {desc}")
            if unknown:
                say("These command numbers aren't documented, so they could do something unexpected.")
                say("Any effect lasts only until you unplug the mouse.")
            if not yes(f"Run stage {name}?"):
                continue
            ask("Unplug and replug the mouse so the light is normal, then press Enter. ")
            dev = wait_control()
            if not dev:
                return
            last, stopped = run_sequence(dev, packets, 1.0)
            cmd(dev, [0x11, 0x00, 0x00], "normal scrolling (safety)")
            if stopped and last >= 0:
                dev = confirm(dev, packets, last)
                if not dev:
                    return
                cmd(dev, [0x11, 0x00, 0x00], "normal scrolling (safety)")
            elif not stopped:
                say(f"Stage {name} finished. Did the light ever change? If not, that's useful to know too.")
        say("\nSearch done. Send gp4_lab_log.txt so the results can be analysed.")
    finally:
        if dev:
            try:
                dev.close()
            except Exception:
                pass


# ---------------------------------------------------------------- menu
def main():
    say(f"\n===== GP4 mouse lab started {time.strftime('%Y-%m-%d')} =====")
    while True:
        print("""
  1) Scan the mouse                 (safe, read-only)
  2) Watch the mouse live           (safe, read-only)
  3) A704F volume test, all parts   (low risk, always restores scrolling)
  4) Careful probe                  (expert, experimental commands)
  5) Lighting controls              (the A704F lighting commands)
  6) Why did Chrome fail? test      (low risk, always restores scrolling)
  7) Search for the lighting command (guided, you watch the light)
  q) Quit
""")
        try:
            choice = ask("Choose: ").lower()
        except (EOFError, KeyboardInterrupt):
            break
        try:
            if choice == "1": scan()
            elif choice == "2": watch()
            elif choice == "3": a704_test()
            elif choice == "4": probe()
            elif choice == "5": lighting()
            elif choice == "6": readback_experiment()
            elif choice == "7": light_search()
            elif choice == "q": break
        except KeyboardInterrupt:
            say("Stopped.")
        except EOFError:
            break
        except Exception as e:
            say(f"Something went wrong: {e}")
    say(f"Log saved to {LOG_PATH}")


if __name__ == "__main__":
    main()
