# Changelog

All notable changes to the "Arduino to Codespaces Bridge" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
