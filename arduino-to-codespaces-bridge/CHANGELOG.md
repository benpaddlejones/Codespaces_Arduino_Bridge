# Changelog

All notable changes to the "Arduino to Codespaces Bridge" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-05

> This release merges the previously-unpublished source of the 1.1.0/1.1.1
> marketplace releases (recovered from the published package) with new work.

### Added

- I2C Scanner tool: one-click "🔍 I2C Scan" button uploads a bundled diagnostic
  sketch that scans the I2C bus (0x08-0x77), identifies 27+ common devices
  (OLEDs, IMUs, environmental sensors, RTCs), detects floating buses, and
  rescans every 10 seconds
- Bundled tool sketches compiled via `__TOOL__:<id>` paths (packaged in
  `dist/tools/`)
- Periodic server health monitor with memory watermarks, self-healing garbage
  collection, and `/api/health/history` diagnostics endpoint
- Modal focus trap (WAI-ARIA dialog pattern) for bootloader and board-mismatch
  dialogs: Tab wraps, ESC cancels, focus restores on close
- IntelliSense generation: `POST /api/intellisense` regenerates
  `.vscode/c_cpp_properties.json` from `arduino-cli board details` build
  properties (correct compiler, core/variant includes, and defines for the
  selected board), with `Arduino.h` force-included so `.ino` files resolve
  core symbols

### Changed

- Serial connection teardown hardened: idempotent cleanup guard, half-open
  ports are closed on failed connects, device-loss errors are classified and
  reported cleanly, and the UI stays in sync on unexpected disconnects
- Cancelling the browser port picker now shows a friendly message instead of
  an error
- All server routes are wrapped with error protection so requests always
  receive a response (no hanging requests after async errors)
- Compile API accepts both `sketchPath` and `path` and returns `log`/`artifact`
  fields for web client compatibility

### Recovered from 1.1.0/1.1.1 (published Dec 2025, source reconstructed)

- Hardware upload protocol upgrades (web client):
  - New WebUSB DFU upload strategy for Uno R4 Minima, Nano R4, Portenta
    C33/H7, Giga R1, Nicla Vision and Opta boards (DFU 1.1 state machine,
    device-reported transfer sizes, DfuSe set-address for STM32H7)
  - BOSSA nRF52 variant (Nano 33 BLE): flash-applet buffer writes, manual
    double-tap bootloader detection, DTR-hold 1200 touch timing, Intel HEX
    conversion with start-address-based flash offsets
  - Standard-BOSSA direct-write mode (S# writes without Y# copy commands)
  - Bootloader port re-enumeration detection after the 1200 baud touch
  - Post-upload reconnection: wait for restart, find the re-enumerated
    port by VID, retry connection 3 times
  - Compile guards for missing board/sketch selection
- Bundled `arduino-cli` binary (`bin/arduino-cli`, fetched by
  `scripts/fetch-arduino-cli.sh`) so the extension works without a system
  install
- `arduino-requirements.txt` plain-text environment config with automatic
  migration from the legacy `arduino-bridge.config.json`
- Event-driven config sync: the server emits `environmentChanged` after
  install/uninstall/upgrade operations and the extension persists the
  requirements file
- Environment sync reports installation errors in a notification instead of
  claiming success
- Board list reports "no cores installed" with guidance instead of an empty
  list
- Sketch discovery uses the VS Code file search API (faster, respects remote
  filesystems)
- Server port defaults to 3000 with auto-forwarding (`openBrowserOnce`) and
  falls back to the next free port when busy
- Editor defaults for `.ino` files (cpp association, clang-format, spell-check
  dictionary); requires the `xaver.clang-format` extension
- License changed to GPL-3.0

### Fixed (vs published 1.1.1)

- The VSIX no longer leaks the unbundled `out/` build tree (24 files vs 3900+)

## [1.1.1] - 2025-12-18

## [1.1.0] - 2025-12-16

> Published to the marketplace from source that was not committed at the time;
> reconstructed and merged into 1.2.0 (see above).

## [1.0.0] - 2025-12-11

### Added

- Initial release
- Web Serial upload support for Arduino boards
- Serial Monitor with xterm.js terminal emulation
- Serial Plotter with Chart.js visualization
- Board Manager for installing/managing board cores
- Library Manager for installing/managing libraries
- VS Code commands for opening bridge, selecting boards, compiling
- Sidebar tree views for status, boards, and sketches
- Auto-start server option
- Status bar integration
- Support for Arduino Uno, Nano, Mega, Leonardo, Uno R4 WiFi
- Experimental support for ESP32 boards

### Known Issues

- BOSSA upload for Uno R4 may require multiple attempts
- ESP32 upload is experimental

## [Unreleased]

### Planned

- Upload from extension (without opening browser)
- Debug support via `arduino-cli debug`
- Multiple workspace support
- Settings sync
