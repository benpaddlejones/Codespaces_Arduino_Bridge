# Arduino to Codespaces Bridge

Program physical Arduino boards from GitHub Codespaces: sketches compile in
the cloud with the bundled `arduino-cli`, and your browser flashes the board
on your desk over USB using Web Serial / WebUSB. No local Arduino IDE,
toolchain, or CLI install is needed - ideal for classrooms and managed
computers where only a Chromium browser is available.

## Features

**Compile & upload**

- **One-click Compile & Upload** - build in the Codespace, flash from the
  browser using the board's native protocol (STK500 for AVR, SAM-BA/BOSSA
  for SAMD/R4 WiFi/Nano 33 BLE, WebUSB DFU for the R4 Minima family,
  esptool for ESP32)
- **Quiet, consistent upload output** - fixed progress phases and a single
  success/failure summary in the terminal; the full wire-protocol trace
  (every command/response with timing) is available in the browser console
  (F12) for debugging
- **UF2/hex download mode** for boards without a browser-flashable
  bootloader (Pico, Teensy): compile in the Codespace, download the
  firmware file, flash with the board's own loader

**Board handling**

- **Board auto-detection** by USB VID/PID with a tiered catalog: official
  Arduino ids match first, then common clone chips (CH340/CP210x/FTDI)
- **Learned devices** - after a successful upload, the VID:PID → board
  pairing is saved to `arduino-requirements.txt`; that board is
  auto-selected (and never triggers a mismatch warning) on every future
  connect, even in a rebuilt Codespace
- **Mismatch guard** - warns before flashing only when the connected device
  positively identifies as a _different_ official board (clone chips never
  false-alarm)
- **IntelliSense for .ino files** - `.vscode/c_cpp_properties.json` is
  regenerated automatically for the selected board (correct compiler,
  core/variant includes, defines)

**Web UI (opens in Chrome/Edge via the forwarded port)**

- **📝 Serial Monitor** - professional xterm.js terminal with timestamps,
  DTR/RTS control, baud selection, auto-reconnect after uploads
- **📊 Serial Plotter** - real-time charting, Arduino Serial Plotter
  compatible
- **🔧 Board Manager** - search/install/upgrade board cores, with one-click
  presets for common third-party packages (Teensy, ESP32, ESP8266,
  RP2040, Adafruit, SparkFun, Seeed, STM32)
- **📚 Library Manager** - search, install, and manage Arduino libraries;
  missing `#include`s in a failed compile produce install suggestions
- **🛠️ Drivers tab** - per-OS USB driver directory (CP210x, CH340, FTDI,
  R4 WinUSB, Teensy) with official download links and a "no serial device
  found" checklist
- **🔍 I2C scanner** - one click uploads a diagnostic sketch that scans the
  bus and identifies 27+ common sensor/display modules

**Reliability & reproducibility**

- **Reproducible environments** - platforms, libraries and learned devices
  tracked in a committed `arduino-requirements.txt`; a rebuilt or forked
  Codespace restores itself automatically
- **Resilient connection** - startup gate until the server is ready,
  health monitoring with automatic recovery after Codespace sleep/wake,
  request retries over the forwarded port, and clear guidance when the
  Codespaces port session expires

## Requirements

- **GitHub Codespaces** (or any remote VS Code environment) - `arduino-cli`
  is bundled with the extension, no install needed
- **Chrome or Edge browser** (required for the Web Serial / WebUSB APIs)
- **Arduino board** connected to your local machine via USB (a DATA cable,
  not charge-only)

## Usage

1. Open a workspace containing Arduino sketches (`.ino` files)
2. Click the Arduino Bridge icon in the activity bar or use the status bar button
3. The extension starts the bridge server and opens the web UI in your browser
4. Click "Connect Port" and pick your board - it is auto-detected and
   selected by its USB id
5. Select a sketch and click "Compile & Upload"
6. The serial monitor reconnects automatically and shows your sketch output

## Commands

| Command                        | Description                             |
| ------------------------------ | --------------------------------------- |
| `Arduino: Open Arduino Bridge` | Open the bridge UI in your browser      |
| `Arduino: Start Bridge Server` | Start the background server             |
| `Arduino: Stop Bridge Server`  | Stop the background server              |
| `Arduino: Select Board`        | Choose the target board for compilation |
| `Arduino: Compile Sketch`      | Compile the active sketch               |

## Extension Settings

| Setting                         | Default           | Description                               |
| ------------------------------- | ----------------- | ----------------------------------------- |
| `arduinoBridge.serverPort`      | `3000`            | Port for the bridge server                |
| `arduinoBridge.autoStartServer` | `true`            | Auto-start server on extension activation |
| `arduinoBridge.defaultBoard`    | `arduino:avr:uno` | Default board FQBN for compilation        |
| `arduinoBridge.showStatusBar`   | `true`            | Show status bar item                      |

### Environment Configuration

The workspace root contains an `arduino-requirements.txt` file that tracks
the environment. When the bridge server starts, it reads this file and
installs any missing platforms and libraries automatically; after installs
and successful uploads it is updated in place. Commit it so collaborators
(and rebuilt Codespaces) inherit the same environment. Format:

```text
# Platforms
platform arduino:avr 1.8.8

# Libraries
library Servo 1.3.0

# Devices (learned from successful uploads)
device 0x2341:0x8054 arduino:samd:mkrwifi1010
```

`device` lines are written automatically after a successful upload: the
USB VID:PID pair is remembered so that board is auto-selected (and never
warned about) the next time it connects. One entry per VID:PID - the latest
successful upload wins.

## Supported Boards

| Board                           | Protocol         | Status                         |
| ------------------------------- | ---------------- | ------------------------------ |
| Arduino Uno (R3)                | STK500           | ✅ Working                     |
| Arduino Uno R4 WiFi             | BOSSA            | ✅ Working \*                  |
| Arduino Uno R4 Minima           | DFU (WebUSB)     | ✅ Working \*                  |
| Arduino Nano R4                 | DFU (WebUSB)     | ✅ Working \*                  |
| Arduino Nano                    | STK500           | ✅ Working                     |
| Arduino Mega 2560               | STK500v2         | ✅ Working                     |
| Arduino MKR WiFi 1010           | BOSSA            | ✅ Working                     |
| MKR family / Nano 33 IoT / Zero | BOSSA            | ✅ Expected (same SAMD21 flow) |
| Arduino Nano 33 BLE             | BOSSA            | ✅ Working                     |
| ESP32                           | ESPTool          | 🔄 Experimental                |
| Pico / Pico W / Teensy 4.x      | UF2/hex download | ✅ Compile + download          |

\* All UNO R4 family boards (Minima, WiFi, Nano R4) require a one-time
driver install on Windows - see
[Troubleshooting](#r4-board-upload-fails-on-windows-empty-device-list).

## How It Works

1. **Compilation**: The extension runs the bundled `arduino-cli compile` inside your Codespace
2. **Web UI**: A bundled Express server serves the bridge UI through the forwarded port
3. **Browser Upload**: The Web Serial / WebUSB APIs in your browser speak the board's bootloader protocol directly over USB
4. **Reconnect**: After flashing, the serial monitor reattaches to the re-enumerated board automatically

## Troubleshooting

### Web Serial not working?

- Use Chrome or Edge browser
- The bridge must open in a full browser window (not iframe/webview)
- Grant serial port permissions when prompted

### Board not detected?

- Auto-detection needs the board's platform core installed - open the Board
  Manager tab and install it (a popup offers this automatically)
- Boards with clone USB chips are detected as their most common identity
  (e.g. CH340 → "Uno compatible"); after one successful upload the real
  board is remembered

### Upload fails?

- Check that the correct board is selected
- Try pressing the reset button on your Arduino before uploading

### R4 board upload fails on Windows (empty device list)?

This applies to the whole **UNO R4 family** (R4 Minima, R4 WiFi, Nano R4).
These boards are flashed through their bootloader, and Chrome on Windows can
only see the bootloader device when the **WinUSB driver** is installed -
without it the USB device chooser is empty and Device Manager shows the
bootloader (e.g. "Santiago DFU" for the R4 Minima) with a yellow warning
(Code 28).

**One-time fix per PC** (either option):

1. **Zadig** (fastest): download [zadig.akeo.ie](https://zadig.akeo.ie),
   double-tap the board's RESET button (LED pulses), then in Zadig:
   _Options → List All Devices_ → select the board's DFU/bootloader device
   (e.g. **Santiago DFU**) → target driver **WinUSB** → _Install Driver_.
   Repeat once per board model.
2. **Arduino IDE**: install the Arduino IDE plus the "Arduino UNO R4 Boards"
   package - its driver installer registers the drivers for all R4 boards
   in one go.

After the driver is installed, the first upload shows a one-time USB pairing
dialog (pick the board's DFU device); every upload after that is fully
automatic. macOS, Linux, and ChromeOS need no driver.

### CP2102/CH340 board missing from the serial port dialog?

Boards that use a **USB-to-UART bridge chip** (CP2102, CP2102N, CH340,
FT232 - common on ESP32, NodeMCU, and Nano clones) only appear in Chrome's
port picker when the operating system has created a serial port for them.
The bridge does not filter the list - if the board is missing, the OS driver
is missing or the device failed to enumerate.

**Windows**: open Device Manager. If the device shows under _Other devices_
or with a yellow warning, install the vendor VCP driver:

- CP2102/CP2102N: [Silicon Labs CP210x VCP driver](https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers)
- CH340/CH341: WCH CH341SER driver
- After installing, replug the board - it should appear under _Ports (COM & LPT)_.

**Linux/ChromeOS**: the kernel driver is built in, but check:

- Your user is in the `dialout` group (`sudo usermod -a -G dialout $USER`,
  then log out/in).
- `brltty` is not claiming the device (a known CP210x conflict on Ubuntu:
  `sudo apt remove brltty`).

**All platforms**:

- Use a **data** USB cable - charge-only cables power the board but no port
  ever appears.
- Some counterfeit CP2102N/CH340 chips enumerate unreliably; try another
  cable/USB port, or check `dmesg` (Linux) / Device Manager events (Windows)
  for enumeration errors.

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please see the [Contributing Guide](https://github.com/benpaddlejones/Codespaces_Arduino_Bridge/blob/main/docs/CONTRIBUTING.md).
