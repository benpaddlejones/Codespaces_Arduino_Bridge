# Changelog

All notable changes to the "Arduino to Codespaces Bridge" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.23] - 2026-07-17

### Changed

- License unified to MIT: package.json previously declared GPL-3.0 while the
  bundled LICENSE file and README said MIT. All three now agree on MIT.

## [1.2.22] - 2026-07-17

### Changed

- Removed the R4 upload diagnostic tracer (UploadTrace) now that the DFU
  flow is verified working: no more TRACE console output, USB/serial
  snapshots, or terminal debug reports. The functional upload logic
  (1200bps touch, re-enumeration detection, open retries, chooser retry and
  driver guidance) is unchanged.
- Package size: `dist/web` is now cleaned before each build so stale hashed
  client bundles from previous builds no longer accumulate inside the VSIX
  (was shipping ~10 obsolete bundles, several MB).

## [1.2.21] - 2026-07-17

### Added

- Guided onboarding popups in the web client:
  - First open with no board platforms installed → popup pointing to the
    Board Manager with install instructions.
  - Connecting a recognised board (e.g. UNO R4) whose platform core is not
    installed → popup naming the required platform with an "Open Board
    Manager" shortcut that pre-fills the search.
  - Compiling a sketch that includes a missing library (e.g. `<Servo.h>`)
    → popup listing the missing libraries with install suggestions and an
    "Open Library Manager" shortcut that pre-fills the search.
- The extension server now scans failed compile output for missing headers
  and returns Library Manager suggestions (`missingIncludes`), matching the
  dev server behaviour — previously it always returned an empty list.

## [1.2.20] - 2026-07-17

### Changed

- Windows driver guidance generalised to the whole UNO R4 family (R4 Minima,
  R4 WiFi, Nano R4) in the README troubleshooting section, the supported
  boards table, the DFU chooser dialog, and the empty-chooser error message.

## [1.2.19] - 2026-07-17

### Changed

- R4 Minima (DFU/WebUSB) upload confirmed working end-to-end once the
  Windows WinUSB driver is installed. Driver guidance is now surfaced only
  on the exact failure signature (Windows + empty USB chooser): the terminal
  error explains the one-time Zadig/Arduino-IDE driver installation. The
  happy path is prompt-free after the one-time device pairing. README gains
  a Windows driver troubleshooting section and lists the R4 Minima as
  supported.

## [1.2.18] - 2026-07-17

### Changed

- ROOT CAUSE of the empty DFU chooser on Windows confirmed: the UNO R4
  Minima bootloader enumerates as "Santiago DFU" (2341:0369) but Windows has
  no driver for it (Code 28), and Chrome on Windows only lists WebUSB
  devices with the WinUSB driver bound. The chooser guidance now names the
  device ("Santiago DFU" / "UNO R4 Minima DFU") and explains the one-time
  WinUSB installation with Zadig when the list is empty. The 1200bps touch,
  bootloader entry, and re-enumeration detection were all verified working
  in this configuration.

## [1.2.17] - 2026-07-17

### Fixed

- Web Serial spec compliance: WebSerialProvider now registers
  `navigator.serial` `connect`/`disconnect` events (the API's canonical way
  to track device arrival/removal) and adopts freshly connected granted
  ports when the previous reference died from re-enumeration. Post-failure
  recovery refreshes the port object from `getPorts()` on each retry instead
  of reusing a dead `SerialPort` instance. Fixed a write-timeout bug that
  leaked the writer lock (calling `getWriter()` on an already-locked stream)
  which poisoned all subsequent writes.
- Bootloader chooser: retries once after a 4s pause when nothing was
  selected (first-time Windows driver installation can leave the chooser
  list momentarily empty), with clearer instructions. IMPORTANT: the R4's
  DFU-mode magic lives in a battery-backed register (goBootloader writes
  DOUBLE_TAP_MAGIC to VBTBKR) and only clears on a POWER CYCLE - if a board
  seems stuck with no serial port, unplug and replug its USB cable.

## [1.2.16] - 2026-07-17

### Fixed

- The 1200bps touch was working all along but being reported as a failure:
  Chrome's `open({baudRate: 1200})` delivers the 1200 line coding with DTR
  low, the firmware reboots into the bootloader MID-OPEN, the CDC port dies
  under Chrome, and `open()` rejects with NetworkError. Every retry then
  fails because the CDC device no longer exists (the board is already in DFU
  mode). The open-retry loop now detects the re-enumeration
  (`SerialPort.connected === false`, with a `getPorts()` fallback for older
  Chrome) and treats it as touch SUCCESS, proceeding to bootloader pairing
  and flashing. Post-failure serial recovery now retries 6×2s to outlast the
  bootloader's ~10s auto-exit window.

## [1.2.15] - 2026-07-17

### Fixed

- 1200bps touch failed on Windows hosts with `NetworkError: Failed to open
serial port` because Windows releases the COM handle a moment AFTER
  `SerialPort.close()` resolves; the immediate reopen at 1200 baud raced the
  OS (diagnosed precisely by the new upload trace: close ok at +32ms, open
  failed at +46ms). The touch now retries the open up to 8 times with 250ms
  backoff, and the post-failure serial-monitor recovery retries reconnecting
  3 times for the same reason.

## [1.2.14] - 2026-07-17

### Added

- Deep upload diagnostics (`UploadTrace`): every DFU upload step is recorded
  with sub-millisecond timing, structured data, and USB/serial device
  snapshots (paired WebUSB devices with open/claim state, Web Serial ports
  with VID/PID). On failure the full JSON report is printed to the terminal
  and retrievable via `window.getUploadDebugReport()` in the DevTools
  console, pinpointing the exact failing operation.

## [1.2.13] - 2026-07-17

### Fixed

- UNO R4 Minima DFU-mode entry now uses the 1200bps touch over Web Serial as
  the primary mechanism, mirroring the official ArduinoCore-renesas firmware
  (`CheckSerialReset` in `cores/arduino/usb/SerialUSB.cpp`): opening the CDC
  port at 1200 baud and deasserting DTR makes the sketch write the double-tap
  magic and watchdog-reset into the DFU bootloader (PID 0x0369). This avoids
  the WebUSB `claimInterface` on the runtime CDC interface entirely, which
  the host cdc_acm kernel driver blocks in browsers (the root cause of the
  automatic-detach timeout). No RESET double-tap needed. The one-time USB
  chooser only appears the first time the bootloader device is paired.

## [1.2.12] - 2026-07-17

### Changed

- Confirmed the published marketplace 1.1.1 DFU code is identical to the
  current implementation, so nothing was "missing" from it. On platforms where
  the browser cannot detach the host CDC-ACM driver, the app-mode WebUSB DFU
  detach (`claimInterface` on the DFU-runtime interface) times out - this is a
  hard WebUSB limitation, not a regression. The reliable browser path is to
  double-tap RESET so the board re-enumerates as a pure DFU device (PID
  0x0369) with no CDC interface.
- Made the manual bootloader-entry fallback reliable against the R4 DFU
  bootloader's short (~8s) activity timeout. The previous flow polled for the
  bootloader for 30s before opening the USB chooser, so the board had already
  rebooted to application mode by the time the chooser appeared, leaving it
  empty ("No DFU device selected"). `enterBootloaderManually()` now skips the
  poll: it does a single instant check for an already-paired bootloader, then
  hands straight to the chooser whose button click is the user gesture. The
  user double-taps RESET and clicks within the same few seconds, so the chooser
  opens while the board is still in DFU mode. The chooser filter also accepts
  the application PID as a fallback to avoid an empty list if the timing slips.

## [1.2.11] - 2026-07-17

### Fixed

- Reverted the 1.2.7 change that closed the Web Serial port before a WebUSB/DFU
  upload. Inspecting the published marketplace 1.1.1 bundle (the last version
  confirmed working for the UNO R4 Minima) showed its DFU strategy is identical
  to ours, but it re-opened the serial port at 115200 for every board before
  flashing rather than closing it. Closing the port let the host CDC-ACM driver
  re-grab the composite device and stalled the DFU `claimInterface()`. The
  upload orchestration now matches 1.1.1: the port is re-opened at 115200 for
  all boards before flashing, restoring the working Minima DFU path.

## [1.2.10] - 2026-07-17

### Added

- DFU upload (Arduino UNO R4 Minima family) now falls back to guided manual
  bootloader entry when the browser cannot perform the automatic detach. In a
  browser, WebUSB cannot claim the DFU runtime interface while the host
  CDC-ACM driver owns the composite device (native `dfu-util` succeeds only
  because libusb can detach the kernel driver), so the app-mode detach timed
  out. Instead of failing, the upload now prompts the user to double-tap the
  RESET button; the board re-enumerates as a pure DFU device (PID 0x0369) with
  no CDC interface, which WebUSB claims cleanly, and flashing continues
  automatically. The claim timeout was also shortened (8s) so the fallback
  engages promptly. The DFU flash protocol/state machine is unchanged.

## [1.2.9] - 2026-07-17

### Fixed

- DFU upload (Arduino UNO R4 Minima family) could still freeze silently at the
  DFU detach step: WebUSB's `claimInterface()` blocks indefinitely (no error,
  no rejection) when the host CDC-ACM serial driver still holds the composite
  device, so the whole upload hung after "Device opened". The upload flow now
  waits briefly after releasing the Web Serial port so the OS can free the CDC
  interface before WebUSB claims it, and `claimInterface()` is bounded by a
  15s timeout that surfaces a clear, actionable error (unplug/replug, close
  other serial monitors, or double-tap RESET) instead of hanging forever. The
  device's USB interface descriptors are now logged before the claim to aid
  diagnosis. The DFU protocol/state machine itself is unchanged.

## [1.2.8] - 2026-07-17

### Fixed

- Auto board detection never matched the Arduino UNO R4 Minima. Its entry in
  `boards.json` used the FQBN `arduino:renesas_uno:unor4minima`, but arduino-cli
  (and the rest of the app) uses `arduino:renesas_uno:minima`. Because the
  VID/PID merge in `loadBoards()` matches boards by exact FQBN, the Minima's
  USB VID/PID (0x2341/0x0069) were never attached to its dropdown option, so
  connecting the board could not auto-select it. Corrected the FQBN so that
  connecting a Minima now auto-selects "Arduino Uno R4 Minima" in the board menu

## [1.2.7] - 2026-07-17

### Fixed

- DFU upload (Arduino UNO R4 Minima family) hung forever right after "Device
  opened", during the DFU detach step. `handleUpload()` re-opened the Web
  Serial port at 115200 baud before every upload (needed for AVR's DTR reset
  toggle), but for WebUSB/DFU boards that open serial handle holds the USB
  interface, so the DFU strategy's `claimInterface()` call blocked
  indefinitely. The upload flow now closes and keeps the Web Serial port
  released for WebUSB/DFU boards (via the new `UploadManager.usesWebUsb()`
  check) and only re-opens it for serial-based strategies (AVR/BOSSA)

## [1.2.6] - 2026-07-17

### Fixed

- DFU upload (Arduino UNO R4 Minima/Nano R4/Portenta/Giga/Nicla/Opta) failed
  with `SecurityError: Failed to execute 'requestDevice' on 'USB': Must be
handling a user gesture` when no device was previously paired. Compile &
  Upload awaits a multi-second compile before the upload step, which consumes
  the original button-click gesture, so the direct `navigator.usb.requestDevice()`
  call in the DFU prepare step was rejected. The initial DFU device request now
  routes through the existing `requestDfuDevice` modal, whose own button click
  supplies a fresh user gesture (the same pattern already used when re-selecting
  the bootloader device)

## [1.2.5] - 2026-07-17

### Fixed

- Serial monitor now stays silent during compile and upload. Incoming device
  output (e.g. plotter/heartbeat lines) previously interleaved with the build
  log because the terminal echo was wired directly to the serial provider and
  ignored the paused state, and plain "Compile" never paused at all. The
  terminal now respects the paused state, `pause()`/`resume()` are
  reference-counted so a compile nested inside an upload balances correctly,
  and every compile path pauses the monitor while building

## [1.2.4] - 2026-07-17

### Fixed

- "Failed to load libraries: fetch failed" (and the same failure for the
  Boards/Status tree views, board selection, compile, and environment sync):
  the 1.2.1 security change bound the server to IPv4 loopback (`127.0.0.1`),
  but the extension's internal requests used `http://localhost`, which Node 18+
  resolves to IPv6 `::1` first — so the connection was refused. All internal
  extension requests now target `127.0.0.1` to match the server bind. The
  browser URL opened by "Open Bridge" still uses `localhost` (unchanged)

## [1.2.3] - 2026-07-17

### Fixed

- Sketch selection sent an `undefined` sketch name to the compiler: the web
  client read the non-existent `relativePath` field from `/api/sketches`
  (the server returns `path`), so every sketch option carried the literal
  value `"undefined"` and compiles (e.g. the upload-validation sketch) failed
  with `Compiling sketch: 'undefined'`. The client now reads `path`, and the
  compile guard rejects stray `"undefined"`/`"null"` values

## [1.2.2] - 2026-07-17

### Added

- Meta / code-quality test suite (`npm run test:meta`) that guards the
  extension source: it fails the build if `eslint` or `tsc --noEmit` report
  problems, if any source file, exported declaration, or public class method is
  missing a Google-style JSDoc block, or if a contributed command is not
  registered in code
- Google-style JSDoc documentation across previously undocumented exports and
  methods in the config, services, views, and server modules

## [1.2.1] - 2026-07-17

### Security

- CSRF protection: state-changing API requests (`POST`/`PUT`/`PATCH`/`DELETE`)
  are now rejected when the browser reports them as cross-site
  (`Sec-Fetch-Site: cross-site`), blocking hostile websites from driving
  `arduino-cli` (core/library install/uninstall, board-URL changes, compiles)
  via the local server
- Removed the permissive `Access-Control-Allow-Origin: *` CORS policy; the web
  client is same-origin, so cross-origin sites can no longer read API responses
  (e.g. the workspace sketch listing)
- Added hardening HTTP headers: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
  and anti-clickjacking `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`
- Argument-injection guard for all values passed to `arduino-cli` (FQBN,
  platform/library names and versions, board-manager URLs): values beginning
  with `-` or containing control characters are rejected
- Path-traversal guards: `/api/hex/:sketchName` accepts only a safe path
  segment, and relative compile paths must stay inside the workspace
- The extension server now binds to loopback (`127.0.0.1`) instead of all
  interfaces, and the JSON body parser is capped at 2 MB

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
