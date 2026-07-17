# Arduino to Codespaces Bridge

Compile and upload Arduino sketches from GitHub Codespaces to physical Arduino boards connected to your local machine via Web Serial.

## Features

- **🔌 Web Serial Upload**: Upload compiled sketches directly to Arduino boards via your browser
- **📝 Serial Monitor**: View serial output from your Arduino in a professional terminal
- **📊 Serial Plotter**: Visualize data with a real-time plotter (Arduino Serial Plotter compatible)
- **🔧 Board Manager**: Install and manage Arduino board cores
- **📚 Library Manager**: Search, install, and manage Arduino libraries
- **⚡ One-Click Workflow**: Compile in Codespaces, upload from your browser

## Requirements

- **GitHub Codespaces** with `arduino-cli` installed
- **Chrome or Edge browser** (required for Web Serial API)
- **Arduino board** connected to your local machine via USB

## Usage

1. Open a workspace containing Arduino sketches (`.ino` files)
2. Click the Arduino Bridge icon in the activity bar or use the status bar button
3. The extension will start the bridge server and open the web UI in your browser
4. Click "Connect Port" to connect to your Arduino
5. Select a sketch and click "Compile & Upload"

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
| `arduinoBridge.serverPort`      | `3001`            | Port for the bridge server                |
| `arduinoBridge.autoStartServer` | `true`            | Auto-start server on extension activation |
| `arduinoBridge.defaultBoard`    | `arduino:avr:uno` | Default board FQBN for compilation        |
| `arduinoBridge.showStatusBar`   | `true`            | Show status bar item                      |

### Environment Configuration

The workspace root contains an `arduino-bridge.config.json` file that lists
the board platforms and libraries to preload. When the bridge server starts,
it reads this file and installs any missing items automatically. Commit changes
to this file so collaborators inherit the same environment. Entries are sorted
alphabetically to keep merges friendly—add new platforms or libraries as
objects, for example:

```json
{
  "version": 1,
  "platforms": [{ "id": "arduino:avr" }],
  "libraries": [{ "name": "ArduinoJson", "version": "6.21.2" }]
}
```

## Supported Boards

| Board                 | Protocol     | Status          |
| --------------------- | ------------ | --------------- |
| Arduino Uno (R3)      | STK500       | ✅ Working      |
| Arduino Uno R4 WiFi   | BOSSA        | ✅ Working \*   |
| Arduino Uno R4 Minima | DFU (WebUSB) | ✅ Working \*   |
| Arduino Nano R4       | DFU (WebUSB) | ✅ Working \*   |
| Arduino Nano          | STK500       | ✅ Working      |
| Arduino Mega 2560     | STK500v2     | ✅ Working      |
| ESP32                 | ESPTool      | 🔄 Experimental |

\* All UNO R4 family boards (Minima, WiFi, Nano R4) require a one-time
driver install on Windows - see
[Troubleshooting](#r4-board-upload-fails-on-windows-empty-device-list).

## How It Works

1. **Compilation**: The extension runs `arduino-cli compile` inside your Codespace
2. **Web UI**: A bundled Express server serves the bridge UI
3. **Browser Upload**: The Web Serial API in your browser communicates directly with your Arduino
4. **Port Forwarding**: Codespaces automatically forwards the server port to your browser

## Troubleshooting

### Web Serial not working?

- Use Chrome or Edge browser
- The bridge must open in a full browser window (not iframe/webview)
- Grant serial port permissions when prompted

### Board not detected?

- Make sure `arduino-cli` is installed in your Codespace
- Install the required board core via Board Manager

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
