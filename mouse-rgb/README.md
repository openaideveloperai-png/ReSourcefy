# Gammec GP4 mouse lighting (WebHID)

Files in this folder:

| File | What it is |
| --- | --- |
| `gp4-diagnostic.html` | **Start here.** Checks whether your mouse understands the commands. |
| `gp4-rgb.html` | Lighting controls. Only useful if the diagnostic's volume test works. |
| `gp4_linux_test.py` | Fallback test you can run from a Linux live USB (explained below). |
| `gp4_lab.py` + `run_gp4_lab.bat` | Windows program to study the mouse yourself (see "GP4 mouse lab"). |

Nothing in these files changes DPI or button bindings. Every change goes away when you unplug the mouse.

## The short version

Your mouse **accepts** the commands but, so far, **doesn't act on them**. A web page can only fix that if the mouse is actually listening. The diagnostic page tells you which case you're in, in about two minutes.

One important finding: the Windows software for the A704F sends **exactly the same USB message** that your browser already sends: feature report 7, 8 bytes, to the second interface (the one with reports 2 and 6). You can see this in the Linux tool's source (`src/hidhelper.cpp`), which copies the Windows software's USB setup header `21 09 07 03 01 00 08 00`. It decodes as "SET_REPORT, Feature, report ID 7, interface 1, 8 bytes". So Chrome isn't sending the wrong thing. The most likely explanation is that the GP4's firmware (product ID 0x0f99, a generic ID also listed as "Maxxter Optical gaming mouse") is not the A704F firmware (product ID 0x1286).

## Step by step

1. Download `gp4-diagnostic.html` and `gp4-rgb.html` to your computer (for example your Desktop).
2. Right-click `gp4-diagnostic.html`, choose **Open with**, then pick **Google Chrome** or **Microsoft Edge**.
3. Unplug the mouse, plug it back in, then click **Connect mouse**. In the list Chrome shows, click **USB OPTICAL MOUSE**, then **Connect**.
4. Click **Read feature report 7** (step 2 on the page). This only reads.
5. Press the DPI button and the side buttons (step 3). Lines starting with `IN` may appear in the log.
6. Click **Turn on volume scrolling** (step 4). Roll the wheel over the page. Click **Yes** or **No**. Scrolling switches back on its own.
7. If the result says it works, try step 5 on the page, then open `gp4-rgb.html` the same way.
8. Either way, click **Copy log** and save or share the text.

If something goes wrong (the wheel stops scrolling, for example), click **Restore normal scrolling**, or simply **unplug and replug the mouse**.

## Why the writes might be accepted but ignored, and how to test each theory

Reading back what you wrote proves nothing: this kind of chip just stores the last 8 bytes it received. The real test is whether the mouse *does* something.

| Theory | How likely | How to test |
| --- | --- | --- |
| **The GP4 firmware uses different commands from the A704F** | Most likely | The volume test fails on Windows *and* in the Linux script. The only way to learn the real commands is to capture the original software (see "USB capture" below). |
| **The flash commands only fire when you roll the wheel** | Likely, for the `11 02 xx` commands | SPECS.md lists "normal scrolling", "control volume" and "spam z key" among the same values, which only make sense as *wheel actions*. In your earlier test you restored scrolling right away, so you never rolled the wheel in that mode. The pages now give you a countdown to roll during. This doesn't explain why `13 7f 17` (LED off) did nothing. |
| **The browser talks to a different interface than the original software** | Unlikely | Your report-7 entry also carries reports 2 and 6, which are on interface 1 in SPECS.md, and interface 1 is where the Windows software sends (`wIndex 01`). Step 3 of the diagnostic confirms it: `IN report 06` lines when you press DPI mean you're on that interface. |
| **Windows or Chrome changes the report type** | Very unlikely | Chrome's `sendFeatureReport` becomes a Windows feature-report call, which becomes a USB SET_REPORT (Feature). You can prove it with a USB capture of the diagnostic page: the packet should read `21 09 07 03 01 00 08 00` followed by `07 11 01 00 00 00 00 00`. |
| **The mouse needs a different report ID or a wValue the browser can't send** | Possible but unlikely | Chrome (and Windows) only allow report IDs the mouse declares, which is only 7. The Linux tool's odd 16-byte packet with ID 0x21 can only be sent from Linux. `gp4_linux_test.py` tries exactly that packet. |

## Fallback 1: Linux live USB test (about 20 minutes, changes nothing on your PC)

Linux can send the same "odd" packet the working Linux tool uses, which Windows and Chrome can't.

1. Make an Ubuntu USB stick with [Rufus](https://rufus.ie) and the Ubuntu Desktop download. Boot from it and choose **Try Ubuntu**. Your Windows install is not touched.
2. Copy `gp4_linux_test.py` onto a second USB stick (or download it in Ubuntu's browser).
3. Open **Terminal**, go to the folder with the file, and run:
   ```bash
   sudo python3 gp4_linux_test.py
   ```
4. For each test it asks you to roll the wheel and answer `y` or `n`. Copy the summary at the end.

If any line says **WORKED** for the "Linux-tool 16-byte" packet but not the "standard 8-byte" one, the mouse needs that odd packet. A web page can't send it, but a small Linux autostart script can.

## Fallback 2: USB capture of the original software (the best way to learn new commands)

This only helps if you can find Windows software that recognises your mouse. The Gammec download is dead, but cheap mice with this chip often ship with the same generic "Gaming Mouse" program under different brands. Look in the box or on a mini-CD, ask the seller, or search for your mouse's look-alikes. Only run installers from sources you trust; you can do this in a virtual machine or a spare PC.

1. Install [Wireshark](https://www.wireshark.org/download.html). During setup, tick **Install USBPcap**. Restart Windows.
2. Open Wireshark. In the list you'll see **USBPcap1**, **USBPcap2**, and so on. Double-click one, move the mouse, and see if packets appear. If not, stop (red square) and try the next one.
3. Click the shark fin to start capturing. In the filter bar type:
   ```
   usb.setup.bRequest == 9 || usb.setup.bRequest == 1
   ```
   and press Enter.
4. In the mouse software, change **one** thing at a time, waiting 3 seconds between: lighting slow, fast, static, off, and every colour option it has. Write down the order.
5. Stop the capture. **File → Save As** as `.pcapng`.
6. For each packet, click it and look at the bottom pane. Note the **Setup Data** (`bmRequestType`, `wValue`, `wIndex`, `wLength`) and the data bytes (for example `07 13 7f 16 00 00 00 00`).

Send these: the `.pcapng` file, plus your list of what you clicked and in what order. With that, the page can be updated to use your mouse's real commands, including real colour choice if the software offers it.

You can also do step 3 while using `gp4-diagnostic.html`, to confirm the browser sends exactly `21 09 07 03 01 00 08 00` with data `07 11 01 00 00 00 00 00`.

## GP4 mouse lab (Python, Windows): study the mouse yourself

**Results so far (November 2026):** the GP4 **does** speak the A704F protocol. The volume test worked from `gp4_lab.py` on interface 1, feature report 7. The DPI button sends `06 f6 00` on press and `06 00 00` on release, the same message as the A704F. The Chrome diagnostic had failed, probably because it read the mouse's memory 60 ms after each command. Option 6 later showed the read-back was not the cause; both ways worked from Python. The A704F lighting commands (`13 7f xx`) and the wheel flash (`11 02 09`) had no effect on the light, so option 7 searches for the GP4's lighting command.

**Conclusion:** option 7 found nothing. Stage A tried all 255 second-byte values of command `13` and stage B tried 41 other command numbers; the light never reacted. The A704F's own firmware light effects (`11 02 08/09`, toggle and flash) also did nothing, even though the same `11` command controls the scroll wheel fine. The GP4's LED is almost certainly not controlled by the mouse's chip: most likely a self-cycling RGB LED that runs on its own. No software can change it.

The diagnostic page showed the GP4 ignores the A704F commands **on the part of the mouse Chrome can see**. `gp4_lab.py` goes further: Python can also reach the mouse's main interface, which Chrome hides.

**Is it safe?** It's one readable text file. It only talks to devices from vendor 0x18f8, never uses the internet, and only writes `gp4_lab_log.txt` (plus `gp4_lab_progress.json` for the probe). It needs one extra package, [hidapi](https://pypi.org/project/hidapi/), a widely used open-source USB library.

**Setup (once)**
1. Install Python from [python.org](https://www.python.org/downloads/). On the first installer screen, tick **Add python.exe to PATH**.
2. Put `gp4_lab.py` and `run_gp4_lab.bat` in the same folder.
3. Double-click `run_gp4_lab.bat`. The first time, it installs hidapi, then opens the menu.

**The menu**

| Option | What it does | Risk |
| --- | --- | --- |
| 1 Scan | Lists every part of the mouse, its report layout, firmware version, and what it currently holds | None, read-only |
| 2 Watch | Shows live everything the mouse sends while you press DPI/side buttons, plus any change in stored settings. Ctrl+C stops | None, read-only |
| 3 A704F volume test | Tries the volume command on **every** part of the mouse, including the one Chrome hid. Asks before each, always restores scrolling | Low |
| 5 Lighting controls | Breathing speeds, static, off, wheel-triggered flashes, freeze-on-a-colour | Low; scrolling is always restored after flashes |
| 6 Why did Chrome fail? | Volume test with and without an immediate read-back | Low |
| 7 Search for the lighting command | Guided: sends lighting-style commands once per second while you watch the light; press Ctrl+C when it changes, then it pins down which one. Never sends DPI, button, fire-speed or key commands | Low (stage A) to moderate (stage B, undocumented commands); unplug/replug undoes |
| 4 Careful probe | Sends undocumented commands one at a time, only when you press Enter. Records what you report (`l` = light changed, `o` = something else). Progress is saved | Moderate: changes last until you unplug/replug. Permanent changes are unlikely but not impossible |

Do 1, 2 and 3 first. Send `gp4_lab_log.txt` back to continue the analysis. Only try 4 if 3 finds nothing and you accept the risk. In the probe, start with the first byte (position 1) and a template of all zeros, and watch the light after every step.

## Things these pages deliberately never send

- Scroll debug value `0d` (makes the wheel spam the `z` key). It's blocked in code.
- `07 09` (DPI), `07 10` (button binding), `07 12` (fire speed), `07 15`/`07 17` (fake key presses). These are **risky**: they can make a button stop clicking or change pointer speed. If you ever try them with another tool, unplugging and replugging the mouse undoes them (the A704F doesn't save settings; we don't know for sure about the GP4).

## Sources

- [Instant A704F Mouse Utilities](https://github.com/AmberIsFrozen/Instant-A704F-Mouse-Utilities): README, SPECS.md and `src/hidhelper.cpp`
- USB ID 18f8:0f99: [linux-hardware.org](https://linux-hardware.org/index.php?id=usb:18f8-0f99), [DeviceHunt](https://devicehunt.com/view/type/usb/vendor/18F8/device/0F99)
- The author's blog post and the A704F/A704C spec PDFs could not be read during research (the sites were blocked from the research environment), so nothing here relies on them.
