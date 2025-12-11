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

| Board               | Protocol | Status          |
| ------------------- | -------- | --------------- |
| Arduino Uno (R3)    | STK500   | ✅ Working      |
| Arduino Uno R4 WiFi | BOSSA    | ✅ Working      |
| Arduino Nano        | STK500   | ✅ Working      |
| Arduino Mega 2560   | STK500v2 | ✅ Working      |
| ESP32               | ESPTool  | 🔄 Experimental |

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

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please see the [Contributing Guide](https://github.com/benpaddlejones/Codespaces_Arduino_Bridge/blob/main/docs/CONTRIBUTING.md).
