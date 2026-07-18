# Changelog

All notable changes to the "Arduino to Codespaces Bridge" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Same-day debugging iterations are grouped into their release milestone.

## [1.2.54] - 2026-07-18

### Fixed

- Board auto-detection catalog rebuilt AUTHORITATIVELY from the official
  Arduino cores' boards.txt on github.com/arduino (avr, megaavr, samd, sam,
  renesas, mbed) instead of piecemeal hand maintenance. 56 tier-1 boards
  generated with every official VID/PID (both classic vid.N/pid.N and
  pluggable-discovery upload_port formats parsed). Previously missing and
  now detected: **Nano R4** (the reported bug), Nano Every, Uno WiFi Rev2,
  Uno Mini, Uno with 0x006a/0x0210/0x0237 ids, Giga R1, Nicla family, Opta
  variants, Portenta H7/C33, Edge Control, M0/M0 Pro, Tian, Due, Circuit
  Playground Express, and all bootloader-mode ids across the range.
  Official data conflicts resolved per the tier rules (M0/M0 Pro shared
  pairs, Tian's twin console port demoted to tier 3). Curated tier-2/3
  clone-chip entries preserved; the rebuild script is idempotent.
- Protocol configs added for the newly catalogued SAMD boards (Circuit
  Playground Express, M0/M0 Pro, Zero EDBG, Tian).

## [1.2.53] - 2026-07-18

### Fixed

- Connecting a detected board whose platform is not installed looked like
  broken auto-detection: the 1.2.51 anti-spam change suppressed the
  terminal line together with the popup on repeat connects, so the second
  and later connects in a session were completely silent. The "Detected X,
  but its platform is not installed" line now always prints (with a Board
  Manager pointer); only the popup is deduped per session.

## [1.2.52] - 2026-07-18

### Fixed

- Persistent "Failed to open serial port" on Connect:
  - The Connect open now retries up to 4 times with backoff. Windows
    releases the COM handle a moment AFTER close() resolves (whether closed
    by us or another program), and a just-re-enumerated device briefly
    refuses opens - a single attempt failed in both cases. If the device
    re-enumerated, the retry adopts the fresh granted port with the same
    USB identity instead of reusing the dead port object.
  - New cross-tab guard: bridge tabs announce themselves over a
    BroadcastChannel, and opening the page while another tab is running
    shows a clear warning - a second same-origin tab holding the port is
    the most common cause of repeated open failures after hard refreshes.

## [1.2.51] - 2026-07-18

### Fixed

- Connecting a board whose platform is not installed (e.g. a Raspberry Pi
  Pico running MicroPython) no longer spams the "platform required" popup
  and terminal line on every connect/reconnect attempt - the notice now
  shows once per platform per session.
- "Failed to open serial port" now produces an actionable message and
  guidance dialog: the port is almost always held by another program
  (Thonny, Arduino IDE, PuTTY, a second tab) or the device just
  re-enumerated - close the other tool or replug, then retry.

## [1.2.50] - 2026-07-18

### Fixed

- Mismatch warning missed vendor-identified non-Arduino devices: a
  Raspberry Pi Pico connected while "Arduino M0" was selected uploaded
  silently. Tier-2 catalog entries are now split by a genericChip flag:
  USB-UART bridge chips (CH340/CP210x/FTDI/Holtek) still never warn (chip
  id ≠ board id), but vendor-specific ids (Raspberry Pi 0x2E8A, PJRC
  0x16C0) count as positive identification - selecting an unrelated board
  for them now raises the mismatch dialog, while tier-3 alternates for the
  same chip (e.g. Pico W) stay silent. 5 new test assertions.

## [1.2.49] - 2026-07-18

### Changed

- Marketplace README rewritten for clarity: grouped feature overview
  (compile & upload protocols, board auto-detection with learned devices,
  full web-UI tab tour, reliability features), corrected requirements
  (arduino-cli is BUNDLED - no install needed), refreshed usage flow,
  supported-boards table including the SAMD/MKR family and Nano 33 BLE,
  and environment documentation for arduino-requirements.txt including the
  learned `device` lines. Project root README now documents the overall
  architecture with a marketplace link.

## [1.2.48] - 2026-07-18

### Changed

- Upload output rewritten around a single UploadReporter module: the
  terminal now shows only fixed phases (compile -> prepare -> erase ->
  write -> verify -> reset -> reconnect) with one self-overwriting progress
  line and a single success/failure summary - identical across
  BOSSA/DFU/AVR/ESP boards. The full protocol trace (CMD/RSP/timing) now
  lives in the browser console only: the console-to-terminal mirror that
  flooded the terminal with every log line is removed, and failure
  summaries point to the console (F12) for diagnosis. All upload paths
  (compile & upload, bootloader chooser, I2C scanner) route through the
  reporter. 9 new test assertions drive the reporter under Node and
  tripwire the console-only rule.

## [1.2.47] - 2026-07-18

### Added

- Learned-device tracking: a successful upload records the connected
  VID:PID -> board mapping as a `device 0xVVVV:0xPPPP <fqbn>` line in
  arduino-requirements.txt (committed - mappings follow the repo across
  Codespace rebuilds and forks). One entry per VID:PID, latest successful
  upload wins. On connect, a learned mapping overrides the tier catalog:
  the board is auto-selected and mismatch warnings are suppressed for that
  pair. New GET/POST /api/devices/learned endpoints on both servers; the
  extension's environment sync seeds the server from the file and persists
  runtime learns back through the existing single-writer path. 10 new test
  assertions cover the request contract, both success paths, the file
  format parser/serializer agreement, and the sync lifecycle.

## [1.2.46] - 2026-07-18

### Added

- Three-tier board identification (boards.json `tier` field):
  - Tier 1 = official Arduino VID:PIDs (auto-picker tries first).
  - Tier 2 = probable non-Arduino devices, exactly one board per VID:PID
    (auto-picker fallback): Uno compatible (CH340), Nano (FTDI), ESP32 Dev
    Module (CP210x / CH9102), Wemos D1 mini, Raspberry Pi Pico, Teensy 4.1.
  - Tier 3 = boards sharing an already-used chip (never auto-selected;
    only suppress mismatch warnings): Pico W, Teensy 4.0, NodeMCU, D1.
  - New pure boardResolver module implements the policy: learned mapping
    (future) -> tier 1 -> tier 2; mismatch warnings now fire ONLY when the
    device positively identifies as a different official board, replacing
    the ad-hoc bridge-chip VID allowlist.
  - 13 new test assertions: tier schema, VID:PID uniqueness across tiers
    1+2, tier-3 duplicates rule, and resolver/mismatch policy unit tests.

## [1.2.45] - 2026-07-17

### Fixed

- IntelliSense (.vscode/c_cpp_properties.json) could stay generated for a
  previously used board, producing walls of red squiggles ("pinMode is
  ambiguous", UART::begin mismatches) in sketches for the currently
  selected board. Regeneration only ran on a manual dropdown change -
  auto-detect sets the value programmatically (no change event fires) and
  page load never synced at all. The selected board is now the single
  source of truth: IntelliSense regenerates on manual selection, on
  auto-detect, and on startup (deduplicated per FQBN).

## [1.2.44] - 2026-07-17

**Testing milestone** — static quality gates for the whole codebase.

### Added

- Web-client meta test suite (`npm run test:webclient`, 30 assertions):
  boards.json copies in sync + schema + SAMD bootloader-PID pairing,
  protocol configs verified against boards.json via real module import,
  BOSSA regression tripwires (orphaned-read pattern, SAMD SRAM+Y# flow,
  AIRCR reset), DOM id contract against index.html, syntax check of every
  web-client file, and client→server API route coverage for BOTH servers.
- `npm run test:all` runs all four static suites (version, meta, contracts,
  webclient) — 82 assertions, no hardware or CLI required.

### Fixed

- Found by the new route-coverage test: the "Restart Bridge" button called
  `POST /api/restart`, which only existed on the dev server — in the shipped
  extension it always failed with 404. The extension server now implements
  it via a `restartRequested` event handled by the extension.

## [1.2.38 - 1.2.43] - 2026-07-17

**Reliability & board-support milestone** — stable UI startup, stable
Codespaces tunnel, Nano 33 BLE fix, Teensy support surface.

### Added

- Startup gate: the UI is held behind a loading overlay until the bridge
  server answers and the boards + sketches lists have loaded — no more
  empty dropdowns while the server starts; Retry button on failure (1.2.38).
- Board Manager: one-click presets for common third-party board packages —
  Teensy (PJRC), ESP32, ESP8266, RP2040 (earlephilhower), Adafruit,
  SparkFun, Seeed Studio, STM32duino (1.2.41).
- Drivers tab: PJRC Teensy entry — no driver needed on Windows 10+/macOS,
  Linux udev rules for uploads, HalfKay-is-HID limitation, and the
  "no serial port at all" explanation (USB type is compiled into the
  sketch; factory boards need one host-side flash first) (1.2.40, 1.2.42).

### Fixed

- Nano 33 BLE reported "Upload failed: The device has been lost" after a
  fully successful flash: the nRF52 bootloader resets and drops off USB
  ~30ms after K# without ACKing. Device loss during reset is now treated as
  the expected success outcome, and serial teardown is robust against a
  vanished port (1.2.39).
- Codespaces forwarded-port stability (1.2.43): new `bridgeFetch` wrapper
  with timeout + retry/backoff on transient proxy failures; detection of
  GitHub's port sign-in page served as HTTP 200 after cookie expiry
  (previously silent JSON failures — now a clear "reload the page" notice);
  automatic boards/sketches reload when the server comes back after a
  Codespace sleep/wake; immediate health check on any bridge error.

## [1.2.31 - 1.2.37] - 2026-07-17

**SAMD21 upload milestone** — MKR WiFi 1010 upload working end-to-end,
then extended to the full official SAMD family. Flow verified against the
official bootloader source (ArduinoCore-samd `bootloaders/zero`) and
bossac's D2xNvmFlash driver.

### Added

- Per-board SAMD21 protocol configs with bootloader PIDs from boards.txt,
  covering MKR1000, MKR Zero, MKR WiFi 1010, MKR FOX 1200, MKR WAN
  1300/1310, MKR GSM 1400, MKR NB 1500, MKR Vidor 4000, Nano 33 IoT and
  Zero (native USB).
- Bootloader-mode auto-detect: boards.json lists bootloader PIDs
  (app PID − 0x8000) so sketch-less boards stuck in the bootloader are
  still recognised.
- V# capability probe before erase (mirrors bossac): logs the bootloader
  version and its [Arduino:XYZ] flags.

### Fixed

- SAM-BA flow corrected to match the official bootloader: chip erase is a
  blocking full-flash busy-loop (waits up to 30s for the ACK instead of
  writing to a deaf board); flash writes go to the SRAM buffer at
  0x20004000 and are committed with Y# (the S handler is a raw memcpy for
  RAM — direct-to-flash S# writes were never valid); reset uses a W# AIRCR
  SYSRESETREQ write because 2018-era bootloaders have no K# command (the
  reason boards stayed stuck in bootloader mode).
- Orphaned-read bug: every polling read loop raced a fresh reader.read()
  against a timer; losing reads stayed queued and swallowed later bootloader
  ACKs (uploads succeeded while logging walls of timeout errors). All reads
  now go through a single shared in-flight read (`readChunk`).
- SAMD boards no longer inherit the R4 WiFi configuration; bootloader
  re-enumeration after the 1200-baud touch raises the port chooser;
  restored the missing `flashToBootloader()` handoff.

### Changed

- Removed debug output from upload logs (duplicate command logging,
  payload previews, [Debug] terminal lines).

## [1.2.24 - 1.2.30] - 2026-07-17

**Onboarding & guidance milestone.**

### Added

- Drivers tab: per-OS USB driver directory (official Arduino, CP210x,
  CH340/CH9102, FTDI, UNO R4 WinUSB via Zadig) with official download links
  and a "no serial device found" checklist; Connect shows a guidance dialog
  when the port chooser closes with nothing selected.

### Fixed

- Board-mismatch warning only fires on a clear mismatch (generic USB-UART
  bridge chips and unknown VID/PIDs no longer false-alarm on clones).
- Sketch dropdown could be empty right after extension start (VS Code file
  index not warmed up) — server now falls back to a filesystem scan.

## [1.2.13 - 1.2.23] - 2026-07-17

**UNO R4 family DFU upload milestone** — R4 Minima/WiFi/Nano R4 uploads
working end-to-end in the browser.

### Added

- 1200bps-touch DFU entry mirroring the official ArduinoCore-renesas
  firmware: the touch reboots the board into the pure DFU bootloader, which
  WebUSB can claim cleanly — no manual RESET double-tap needed.
- Detection of the touch's re-enumeration (the CDC port dies mid-open by
  design, previously misreported as failure) and one-time bootloader
  pairing flow.
- Windows root cause identified and documented everywhere it matters:
  Chrome only lists WebUSB devices with the WinUSB driver bound, so the R4
  family needs a one-time Zadig/Arduino-IDE driver install per PC.

### Changed

- Upload diagnostics tracer removed after verification; stale hashed client
  bundles no longer accumulate in the VSIX (22.5 MB → 17.9 MB).
- License unified to MIT (package.json, LICENSE, README).

## [1.2.1 - 1.2.12] - 2026-07-17

**Security & recovery milestone.**

### Security

- CSRF rejection for cross-site state-changing requests, removal of
  wildcard CORS, hardening headers (nosniff, no-referrer, frame denial),
  arduino-cli argument-injection guards, path-traversal guards, loopback
  bind, and a 2 MB JSON body cap (1.2.1).

### Added

- Meta / code-quality test suite for the extension source: eslint, tsc,
  JSDoc coverage and VS Code best practices (1.2.2).

### Fixed

- Serial monitor stays silent during compile/upload; sketch selection sent
  `undefined` to the compiler (client/server field mismatch); extension
  internal requests use 127.0.0.1 to match the server bind; DFU groundwork
  fixes for the R4 family (user-gesture handling, port lifecycle, board
  auto-detect FQBN).

## [1.2.0] - 2026-07-05

Merges the previously-unpublished source of the 1.1.x marketplace releases
(recovered from the published package) with new work.

### Added

- I2C Scanner tool, bundled tool sketches, server health monitor, modal
  focus trap, IntelliSense generation from board build properties.
- Recovered from 1.1.x: WebUSB DFU strategy (R4 Minima/Portenta/Giga/
  Nicla/Opta), BOSSA nRF52 variant (Nano 33 BLE), bootloader port
  re-enumeration detection, post-upload reconnection, bundled arduino-cli,
  arduino-requirements.txt environment sync, faster sketch discovery.

### Fixed

- The VSIX no longer leaks the unbundled `out/` build tree.

## [1.1.1] - 2025-12-18

## [1.1.0] - 2025-12-16

> Published to the marketplace from source that was not committed at the
> time; reconstructed and merged into 1.2.0.

## [1.0.0] - 2025-12-11

### Added

- Initial release: Web Serial upload, Serial Monitor (xterm.js), Serial
  Plotter (Chart.js), Board & Library Managers, VS Code commands and tree
  views, auto-start server, status bar. Supported boards: Uno, Nano, Mega,
  Leonardo, Uno R4 WiFi; experimental ESP32.

## [Unreleased]

### Planned

- Upload from extension (without opening browser)
- Debug support via `arduino-cli debug`
- Multiple workspace support
- Settings sync
