# Gammec GP4 mouse lighting (WebHID)

Files in this folder:

| File | What it is |
| --- | --- |
| `gp4-diagnostic.html` | **Start here.** Checks whether your mouse understands the commands. |
| `gp4-rgb.html` | Lighting controls. Only useful if the diagnostic's volume test works. |
| `gp4_linux_test.py` | Fallback test you can run from a Linux live USB (explained below). |

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

## Things these pages deliberately never send

- Scroll debug value `0d` (makes the wheel spam the `z` key). It's blocked in code.
- `07 09` (DPI), `07 10` (button binding), `07 12` (fire speed), `07 15`/`07 17` (fake key presses). These are **risky**: they can make a button stop clicking or change pointer speed. If you ever try them with another tool, unplugging and replugging the mouse undoes them (the A704F doesn't save settings; we don't know for sure about the GP4).

## Sources

- [Instant A704F Mouse Utilities](https://github.com/AmberIsFrozen/Instant-A704F-Mouse-Utilities): README, SPECS.md and `src/hidhelper.cpp`
- USB ID 18f8:0f99: [linux-hardware.org](https://linux-hardware.org/index.php?id=usb:18f8-0f99), [DeviceHunt](https://devicehunt.com/view/type/usb/vendor/18F8/device/0F99)
- The author's blog post and the A704F/A704C spec PDFs could not be read during research (the sites were blocked from the research environment), so nothing here relies on them.
