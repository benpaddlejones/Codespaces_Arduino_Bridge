# Codespaces Arduino Bridge

Program physical Arduino boards from **GitHub Codespaces** — compile in the
cloud, flash over USB from your browser. No local Arduino IDE or toolchain
install needed: the heavy lifting (arduino-cli, board cores, libraries) lives
in the Codespace, and the upload happens straight from Chrome/Edge to the
board on your desk via Web Serial / WebUSB.

**➡️ Install the VS Code extension:**
[Arduino to Codespaces Bridge on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=benpaddlejones.arduino-to-codespaces-bridge)

Built for classrooms: students open a Codespace, plug in a board, and are
compiling and uploading within minutes — on any machine with a Chromium
browser, including managed school computers.

## How it works

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  GitHub Codespace           │  HTTPS  │  Your computer               │
│                             │ (port   │                              │
│  VS Code extension          │ forward)│  Chrome / Edge               │
│   └─ bridge server          │◄───────►│   └─ bridge web UI           │
│       └─ arduino-cli        │         │       └─ Web Serial / WebUSB │
│          (compile, cores,   │         │              │ USB           │
│           libraries)        │         │       Arduino board          │
└─────────────────────────────┘         └──────────────────────────────┘
```

1. The extension starts a bridge server inside the Codespace and opens the
   web UI through the forwarded port.
2. You connect your board in the browser (Web Serial) — it is auto-detected
   by USB VID/PID.
3. Sketches compile in the Codespace with arduino-cli; the browser downloads
   the firmware and flashes it using the board's native protocol
   (STK500 / SAM-BA / DFU / esptool), then reconnects the serial monitor.

## Features

- **One-click Compile & Upload** with quiet, consistent progress output
  (full protocol trace available in the browser console for debugging)
- **Serial Monitor** (xterm.js) and **Serial Plotter** (Arduino-compatible)
- **Board auto-detection** — three-tier VID/PID catalog (official Arduino
  boards first, common clone chips as fallback), plus **learned devices**:
  after a successful upload the board↔USB-id pairing is remembered in
  `arduino-requirements.txt` and auto-selected next time
- **Board & Library Managers** in the browser, with one-click setup for
  third-party packages (Teensy, ESP32, ESP8266, RP2040, Adafruit, SparkFun,
  Seeed, STM32)
- **Reproducible environments** — platforms, libraries and learned devices
  are tracked in `arduino-requirements.txt` (committed), so a rebuilt or
  forked Codespace restores itself automatically
- **IntelliSense** for `.ino` files, regenerated automatically for the
  selected board
- **Drivers tab** — per-OS USB driver directory and troubleshooting for
  CP210x / CH340 / FTDI / R4-family WinUSB / Teensy
- **I2C scanner tool** — one click uploads a diagnostic sketch that
  identifies common sensors on the bus

## Supported boards

| Family          | Boards                                                              | Upload                                                                  |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| AVR             | Uno, Nano, Mega, Leonardo, Micro (+CH340/FTDI clones)               | Web Serial (STK500)                                                     |
| SAMD21          | MKR WiFi 1010, MKR1000/Zero/FOX/WAN/GSM/NB/Vidor, Nano 33 IoT, Zero | Web Serial (SAM-BA)                                                     |
| Renesas         | Uno R4 WiFi                                                         | Web Serial (SAM-BA)                                                     |
| Renesas         | Uno R4 Minima, Nano R4                                              | WebUSB (DFU) — Windows needs a one-time WinUSB driver (see Drivers tab) |
| nRF52           | Nano 33 BLE                                                         | Web Serial (SAM-BA)                                                     |
| ESP32           | DevKit modules, Nano ESP32                                          | Web Serial (esptool)                                                    |
| RP2040 / Teensy | Pico, Pico W, Teensy 4.x                                            | Compile + firmware download (UF2/hex), flash via board's own loader     |

## Getting started

1. Install the
   [extension](https://marketplace.visualstudio.com/items?itemName=benpaddlejones.arduino-to-codespaces-bridge)
   in your Codespace (or add it to your devcontainer).
2. Open a workspace containing `.ino` sketches — the bridge server starts
   automatically and the web UI opens in your browser.
3. Click **Connect Port**, pick your board, then **Compile & Upload**.

> The web UI requires Chrome or Edge (Web Serial / WebUSB APIs). Open it in a
> full browser tab, not the VS Code Simple Browser.

## Repository layout

| Path                                                                                                                                       | Contents                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [arduino-to-codespaces-bridge/](arduino-to-codespaces-bridge/)                                                                             | The VS Code extension: TypeScript extension + bridge server, and the Vite web client                  |
| [docs/sensors/](docs/sensors/)                                                                                                             | Classroom guides for dozens of Grove-style sensors and modules                                        |
| [docs/integrations/](docs/integrations/)                                                                                                   | Project challenges combining sensors (weather station, clap lamp, …)                                  |
| [demo_blink/](demo_blink/), [demo_plotter/](demo_plotter/), [demo_servo/](demo_servo/), [demo_upload_validation/](demo_upload_validation/) | Example sketches, including an upload-validation sketch that proves a flash replaced the old firmware |
| [arduino-requirements.txt](arduino-requirements.txt)                                                                                       | Tracked environment: platforms, libraries and learned devices                                         |

## Development

```bash
cd arduino-to-codespaces-bridge
npm install
npm run test:all     # static suites: version, meta, contracts, web client
npm run package      # build the VSIX
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and the extension's own
[README](arduino-to-codespaces-bridge/README.md) for commands, settings and
troubleshooting.

## License

MIT — see [LICENSE](arduino-to-codespaces-bridge/LICENSE).
