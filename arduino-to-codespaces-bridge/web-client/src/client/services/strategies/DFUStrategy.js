/**
 * DFU (WebUSB) Upload Strategy
 *
 * Flashes boards whose bootloaders speak USB DFU 1.1 (Uno R4 Minima family,
 * Nano R4, Portenta C33/H7, Giga R1, Nicla Vision, Opta) over WebUSB.
 *
 * Recovered verbatim from the published 1.1.1 extension bundle (the source
 * was never committed); identifiers un-minified, logic unchanged.
 *
 * Flow:
 *  1. prepare(): acquire the WebUSB device (paired or user-prompted). If the
 *     device is in application mode, send DFU_DETACH and wait for it to
 *     re-enumerate with the bootloader PID.
 *  2. flash(): claim the DFU interface, honour the device's reported
 *     wTransferSize, drive the DFU state machine (DNLOAD blocks →
 *     manifestation), then reset into the new firmware.
 *
 * @module client/services/strategies/DFUStrategy
 */

import { UploadLogger } from "../utils/UploadLogger.js";
import { isIntelHex, parseIntelHex } from "../utils/intelHex.js";

// =============================================================================
// DFU 1.1 Protocol Constants
// =============================================================================

/** DFU class-specific bRequest values */
const DFU_REQUEST = {
  DETACH: 0,
  DNLOAD: 1,
  UPLOAD: 2,
  GETSTATUS: 3,
  CLRSTATUS: 4,
  GETSTATE: 5,
  ABORT: 6,
};

/** DFU device states (DFU 1.1 spec, section 6.1.2) */
const DFU_STATE = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
};

/** DFU status codes (DFU 1.1 spec, section 6.1.2) */
const DFU_STATUS = {
  OK: 0,
  errTARGET: 1,
  errFILE: 2,
  errWRITE: 3,
  errERASE: 4,
  errCHECK_ERASED: 5,
  errPROG: 6,
  errVERIFY: 7,
  errADDRESS: 8,
  errNOTDONE: 9,
  errFIRMWARE: 10,
  errVENDOR: 11,
  errUSBR: 12,
  errPOR: 13,
  errUNKNOWN: 14,
  errSTALLEDPKT: 15,
};

const STATE_NAMES = {
  [DFU_STATE.appIDLE]: "appIDLE",
  [DFU_STATE.appDETACH]: "appDETACH",
  [DFU_STATE.dfuIDLE]: "dfuIDLE",
  [DFU_STATE.dfuDNLOAD_SYNC]: "dfuDNLOAD-SYNC",
  [DFU_STATE.dfuDNBUSY]: "dfuDNBUSY",
  [DFU_STATE.dfuDNLOAD_IDLE]: "dfuDNLOAD-IDLE",
  [DFU_STATE.dfuMANIFEST_SYNC]: "dfuMANIFEST-SYNC",
  [DFU_STATE.dfuMANIFEST]: "dfuMANIFEST",
  [DFU_STATE.dfuMANIFEST_WAIT_RESET]: "dfuMANIFEST-WAIT-RESET",
  [DFU_STATE.dfuUPLOAD_IDLE]: "dfuUPLOAD-IDLE",
  [DFU_STATE.dfuERROR]: "dfuERROR",
};

const STATUS_NAMES = {
  [DFU_STATUS.OK]: "OK",
  [DFU_STATUS.errTARGET]: "errTARGET",
  [DFU_STATUS.errFILE]: "errFILE",
  [DFU_STATUS.errWRITE]: "errWRITE",
  [DFU_STATUS.errERASE]: "errERASE",
  [DFU_STATUS.errCHECK_ERASED]: "errCHECK_ERASED",
  [DFU_STATUS.errPROG]: "errPROG",
  [DFU_STATUS.errVERIFY]: "errVERIFY",
  [DFU_STATUS.errADDRESS]: "errADDRESS",
  [DFU_STATUS.errNOTDONE]: "errNOTDONE",
  [DFU_STATUS.errFIRMWARE]: "errFIRMWARE",
  [DFU_STATUS.errVENDOR]: "errVENDOR",
  [DFU_STATUS.errUSBR]: "errUSBR",
  [DFU_STATUS.errPOR]: "errPOR",
  [DFU_STATUS.errUNKNOWN]: "errUNKNOWN",
  [DFU_STATUS.errSTALLEDPKT]: "errSTALLEDPKT",
};

// =============================================================================
// Board Configurations
// =============================================================================

/** Per-board USB DFU parameters (PIDs are decimal in USB descriptors) */
const DFU_BOARD_CONFIGS = {
  "arduino:renesas_uno:minima": {
    vid: 0x2341,
    applicationPid: 0x0069,
    bootloaderPid: 0x0369,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:unor4minima": {
    vid: 0x2341,
    applicationPid: 0x0069,
    bootloaderPid: 0x0369,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:nanor4": {
    vid: 0x2341,
    applicationPid: 0x0074,
    bootloaderPid: 0x0374,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:portenta_c33": {
    vid: 0x2341,
    applicationPid: 0x0068,
    bootloaderPid: 0x0368,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:opta_digital": {
    vid: 0x2341,
    applicationPid: 0x006e,
    bootloaderPid: 0x016e,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:opta_analog": {
    vid: 0x2341,
    applicationPid: 0x0071,
    bootloaderPid: 0x0171,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:renesas_uno:muxto": {
    vid: 0x2341,
    applicationPid: 0x006c,
    bootloaderPid: 0x016c,
    flashOffset: 0x10000,
    transferSize: 64,
    useDfuSe: false,
  },
  "arduino:mbed_portenta:envie_m7": {
    vid: 0x2341,
    applicationPid: 0x025b,
    bootloaderPid: 0x035b,
    flashOffset: 0x08040000,
    transferSize: 2048,
    useDfuSe: true,
    use1200bpsTouch: true,
  },
  "arduino:mbed_giga:giga": {
    vid: 0x2341,
    applicationPid: 0x0266,
    bootloaderPid: 0x0366,
    flashOffset: 0x08040000,
    transferSize: 2048,
    useDfuSe: true,
    use1200bpsTouch: true,
  },
  "arduino:mbed_nicla:nicla_vision": {
    vid: 0x2341,
    applicationPid: 0x025f,
    bootloaderPid: 0x035f,
    flashOffset: 0x08040000,
    transferSize: 2048,
    useDfuSe: true,
    use1200bpsTouch: true,
  },
  "arduino:mbed_opta:opta": {
    vid: 0x2341,
    applicationPid: 0x0064,
    bootloaderPid: 0x0164,
    flashOffset: 0x08040000,
    transferSize: 2048,
    useDfuSe: true,
    use1200bpsTouch: true,
  },
};

/** Default DFU configuration (Uno R4 Minima) */
const DEFAULT_DFU_CONFIG = {
  vid: 0x2341,
  applicationPid: 0x0069,
  bootloaderPid: 0x0369,
  flashOffset: 0x10000,
  transferSize: 64,
  interfaceNumber: 0,
  alternateSetting: 0,
  maxRetries: 5,
  useDfuSe: false,
  blockOffset: 0,
  blockDelay: 0,
  pollDelay: 0,
  use1200bpsTouch: false,
};

/** Build WebUSB filters covering every known DFU board (app + bootloader) */
function getAllDfuFilters() {
  const filters = [];
  const seen = new Set();
  for (const config of Object.values(DFU_BOARD_CONFIGS)) {
    const bootKey = `${config.vid}:${config.bootloaderPid}`;
    if (!seen.has(bootKey)) {
      filters.push({ vendorId: config.vid, productId: config.bootloaderPid });
      seen.add(bootKey);
    }
    const appKey = `${config.vid}:${config.applicationPid}`;
    if (!seen.has(appKey)) {
      filters.push({ vendorId: config.vid, productId: config.applicationPid });
      seen.add(appKey);
    }
  }
  return filters;
}

/** All known bootloader PIDs */
function getBootloaderPidSet() {
  const pids = new Set();
  for (const config of Object.values(DFU_BOARD_CONFIGS)) {
    pids.add(config.bootloaderPid);
  }
  return pids;
}

/** Find the board entry matching a USB PID (app or bootloader) */
function findBoardByPid(pid) {
  for (const [fqbn, config] of Object.entries(DFU_BOARD_CONFIGS)) {
    if (config.bootloaderPid === pid || config.applicationPid === pid) {
      return { fqbn, config };
    }
  }
  return null;
}

/** Resolve the effective config for a board (defaults + overrides) */
function getDfuConfigForBoard(fqbn) {
  const config = DFU_BOARD_CONFIGS[fqbn];
  return config
    ? { ...DEFAULT_DFU_CONFIG, ...config }
    : { ...DEFAULT_DFU_CONFIG };
}

// =============================================================================
// DFUStrategy Class
// =============================================================================

/**
 * WebUSB DFU upload strategy
 */
export class DFUStrategy {
  constructor() {
    this.name = "DFU (WebUSB)";
    this.log = new UploadLogger("DFU");
    this.device = null;
    this.config = DEFAULT_DFU_CONFIG;
    this.blockNum = 0;
    this.currentFqbn = null;
  }

  /** WebUSB availability check */
  static isSupported() {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  static getSupportedBoards() {
    return Object.keys(DFU_BOARD_CONFIGS);
  }

  static isSupportsBoard(fqbn) {
    return fqbn in DFU_BOARD_CONFIGS;
  }

  static getFilters() {
    return getAllDfuFilters();
  }

  static getFiltersForBoard(fqbn) {
    const config = DFU_BOARD_CONFIGS[fqbn];
    return config
      ? [
          { vendorId: config.vid, productId: config.bootloaderPid },
          { vendorId: config.vid, productId: config.applicationPid },
        ]
      : getAllDfuFilters();
  }

  /**
   * Find an already-paired device currently in bootloader mode.
   * @param {string|null} fqbn - Restrict to a specific board
   */
  static async findPairedBootloader(fqbn = null) {
    if (!DFUStrategy.isSupported()) return null;
    try {
      const devices = await navigator.usb.getDevices();
      const bootloaderPids = getBootloaderPidSet();

      if (fqbn && DFU_BOARD_CONFIGS[fqbn]) {
        const config = DFU_BOARD_CONFIGS[fqbn];
        const device = devices.find(
          (d) =>
            d.vendorId === config.vid && d.productId === config.bootloaderPid,
        );
        return device
          ? { device, fqbn, config: { ...DEFAULT_DFU_CONFIG, ...config } }
          : null;
      }

      for (const device of devices) {
        if (bootloaderPids.has(device.productId)) {
          const match = findBoardByPid(device.productId);
          if (match) {
            return {
              device,
              fqbn: match.fqbn,
              config: { ...DEFAULT_DFU_CONFIG, ...match.config },
            };
          }
        }
      }
      return null;
    } catch (error) {
      console.warn("Error checking for paired DFU devices:", error);
      return null;
    }
  }

  /**
   * Find an already-paired device in either application or bootloader mode.
   * @param {string|null} fqbn - Restrict to a specific board
   */
  static async findPairedDevice(fqbn = null) {
    if (!DFUStrategy.isSupported()) return null;
    try {
      const devices = await navigator.usb.getDevices();

      if (fqbn && DFU_BOARD_CONFIGS[fqbn]) {
        const config = DFU_BOARD_CONFIGS[fqbn];
        const device = devices.find(
          (d) =>
            d.vendorId === config.vid &&
            (d.productId === config.bootloaderPid ||
              d.productId === config.applicationPid),
        );
        return device
          ? {
              device,
              fqbn,
              config: { ...DEFAULT_DFU_CONFIG, ...config },
              isBootloader: device.productId === config.bootloaderPid,
            }
          : null;
      }

      for (const device of devices) {
        const match = findBoardByPid(device.productId);
        if (match) {
          return {
            device,
            fqbn: match.fqbn,
            config: { ...DEFAULT_DFU_CONFIG, ...match.config },
            isBootloader: device.productId === match.config.bootloaderPid,
          };
        }
      }
      return null;
    } catch (error) {
      console.warn("Error checking for paired DFU devices:", error);
      return null;
    }
  }

  /**
   * Acquire the WebUSB device and ensure it is in DFU bootloader mode.
   * @param {SerialPort|null} port - Optional serial port (used only to read VID/PID)
   * @param {string} fqbn - Board FQBN
   */
  async prepare(port, fqbn) {
    this.log.section("PREPARE: DFU Mode Entry");
    this.currentFqbn = fqbn;
    this.config = getDfuConfigForBoard(fqbn);
    this.log.info(`Board: ${fqbn}`);
    this.log.info(
      `Config: VID=0x${this.config.vid.toString(16)}, App PID=0x${this.config.applicationPid.toString(16)}, Boot PID=0x${this.config.bootloaderPid.toString(16)}`,
    );
    this.log.info(
      `Flash offset: 0x${this.config.flashOffset.toString(16)}, Transfer size: ${this.config.transferSize} bytes`,
    );

    if (!DFUStrategy.isSupported()) {
      throw new Error(
        "WebUSB is not supported in this browser. Please use Chrome or Edge.",
      );
    }

    // Fast path: a bootloader device pre-requested during a user gesture
    // (WebUSB requestDevice must run inside a gesture handler).
    if (
      typeof window !== "undefined" &&
      window._dfuDevice &&
      window._dfuDevice.productId === this.config.bootloaderPid
    ) {
      this.device = window._dfuDevice;
      this.log.success(
        `Using pre-requested WebUSB device: ${this.device.productName || "Arduino DFU"}`,
      );
      this.log.device(
        this.device.vendorId,
        this.device.productId,
        "Pre-selected device",
      );
      return;
    }

    // Fast path: bootloader already connected and previously paired.
    try {
      const pairedBoot = (await navigator.usb.getDevices()).find(
        (d) =>
          d.vendorId === this.config.vid &&
          d.productId === this.config.bootloaderPid,
      );
      if (pairedBoot) {
        this.device = pairedBoot;
        if (typeof window !== "undefined") {
          window._dfuDevice = pairedBoot;
        }
        this.log.success(
          "Device already in DFU bootloader mode - continuing flash",
        );
        return;
      }
    } catch (error) {
      this.log.warn(`Paired-device check failed: ${error.message}`);
    }

    // PREFERRED PATH: 1200bps touch over Web Serial. The official
    // ArduinoCore-renesas firmware reboots into the DFU bootloader whenever
    // the CDC line coding is 1200 baud with DTR deasserted (CheckSerialReset
    // in cores/arduino/usb/SerialUSB.cpp). This avoids WebUSB claimInterface
    // on the runtime CDC device entirely - which the host cdc_acm kernel
    // driver blocks in browsers (the reason automatic DFU detach never
    // worked). boards.txt sets use_1200bps_touch=false only because dfu-util
    // performs its own detach; the firmware itself fully supports the touch.
    if (port) {
      const touched = await this.performSerialTouch(port);
      if (touched) {
        await this.waitForBootloader();
        return;
      }
    }

    if (port && typeof port.getInfo === "function") {
      const info = port.getInfo();
      this.log.device(
        info.usbVendorId,
        info.usbProductId,
        "Checking device mode",
      );
      if (info.usbProductId === this.config.bootloaderPid) {
        this.log.success("Device already in DFU bootloader mode!");
      } else if (info.usbProductId === this.config.applicationPid) {
        this.log.info("Device in application mode - need to enter DFU mode");
      }
    }

    this.log.info("Requesting WebUSB device access...");
    try {
      const devices = await navigator.usb.getDevices();
      this.device = devices.find(
        (d) =>
          d.vendorId === this.config.vid &&
          (d.productId === this.config.bootloaderPid ||
            d.productId === this.config.applicationPid),
      );
      if (!this.device) {
        this.log.info("No paired device found, requesting user selection...");
        const filters = [
          { vendorId: this.config.vid, productId: this.config.bootloaderPid },
          { vendorId: this.config.vid, productId: this.config.applicationPid },
        ];
        // navigator.usb.requestDevice() must run inside a user gesture. The
        // compile step before upload consumes the original button-click
        // gesture, so route through the modal helper whose own button click
        // provides a fresh gesture. Fall back to a direct request only when
        // the helper is unavailable.
        if (
          typeof window !== "undefined" &&
          typeof window.requestDfuDevice === "function"
        ) {
          this.device = await window.requestDfuDevice(
            filters,
            "Click below, then choose the Arduino DFU device in the USB chooser.",
          );
        } else {
          this.log.warn(
            "Note: WebUSB requires user gesture. If this fails, use the Upload button.",
          );
          this.device = await navigator.usb.requestDevice({ filters });
        }
        if (typeof window !== "undefined") {
          window._dfuDevice = this.device;
        }
      }
      this.log.success(
        `WebUSB device acquired: ${this.device.productName || "DFU Device"}`,
      );
      this.log.device(
        this.device.vendorId,
        this.device.productId,
        "WebUSB device",
      );
      if (this.device.productId === this.config.bootloaderPid) {
        this.log.success(
          `Device is in DFU bootloader mode (PID 0x${this.config.bootloaderPid.toString(16)})`,
        );
      } else {
        this.log.info(
          `Device in application mode (PID 0x${this.config.applicationPid.toString(16)}) - triggering DFU detach`,
        );
        await this.triggerDfuDetach();
      }
    } catch (error) {
      if (error.name === "NotFoundError") {
        throw new Error(
          "No DFU device selected. Please connect the board and try again.",
        );
      }
      throw error;
    }
  }

  /** Send DFU_DETACH in application mode and wait for bootloader re-enumeration */
  async triggerDfuDetach() {
    this.log.section("DFU DETACH: Entering Bootloader");
    try {
      await this.device.open();
      this.log.info("Device opened");
      if (this.device.configuration === null) {
        this.log.info("Selecting USB configuration 1...");
        await this.device.selectConfiguration(1);
        this.log.info("Configuration selected");
      }

      const dfuInterface = this.findDfuInterface();
      if (!dfuInterface) {
        throw new Error(
          "No DFU interface found on device. The device may not support DFU Runtime mode.",
        );
      }

      // Diagnostic: dump the interface layout so a claim failure is debuggable
      this.logInterfaceDescriptors();

      this.log.info(
        `Claiming DFU runtime interface ${dfuInterface.interfaceNumber}...`,
      );
      await this.claimInterfaceWithTimeout(dfuInterface.interfaceNumber, 8000);
      this.log.info(`Claimed DFU interface ${dfuInterface.interfaceNumber}`);

      this.log.command("DFU_DETACH", "Requesting device to enter DFU mode");
      await this.device.controlTransferOut(
        {
          requestType: "class",
          recipient: "interface",
          request: DFU_REQUEST.DETACH,
          value: 1000,
          index: dfuInterface.interfaceNumber,
        },
        new ArrayBuffer(0),
      );

      await this.device.close();
      this.log.info("Device closed, waiting for re-enumeration...");
      await this.waitForBootloader();
    } catch (error) {
      // In a browser, WebUSB usually cannot claim the DFU runtime interface
      // while the host CDC-ACM driver owns the composite device (native
      // dfu-util works because libusb can detach the kernel driver; Chrome
      // cannot). Fall back to user-driven bootloader entry - the user
      // double-taps RESET so the board re-enumerates as a pure DFU device.
      this.log.warn(`Automatic DFU detach unavailable: ${error.message}`);
      try {
        if (this.device && this.device.opened) {
          await this.device.close();
        }
      } catch (closeError) {
        this.log.info(`Cleanup close skipped: ${closeError.message}`);
      }
      // A timed-out claimInterface() can leave the current USBDevice object in
      // a stuck state inside the browser USB stack. Drop references before the
      // manual chooser so flash() cannot reuse a poisoned handle.
      this.device = null;
      if (typeof window !== "undefined") {
        window._dfuDevice = null;
      }
      await this.enterBootloaderManually();
    }
  }

  /**
   * Guide the user to enter the DFU bootloader manually when the browser
   * cannot trigger the detach automatically (the host CDC-ACM driver holds
   * the composite device). The user double-taps RESET; the board then
   * re-enumerates as a pure DFU device (PID 0x0369) with no CDC interface,
   * which WebUSB can claim cleanly for flashing.
   * @returns {Promise<void>}
   */
  async enterBootloaderManually() {
    this.log.section("MANUAL BOOTLOADER ENTRY");
    this.log.warn(
      "The browser cannot switch this board into DFU mode automatically.",
    );

    // The R4 Minima's DFU bootloader auto-exits back to application mode after
    // roughly 8 seconds of inactivity. A long poll here misses that window, so
    // we do NOT wait: first check whether the bootloader (PID 0x0369) is
    // already paired from a previous upload (instant, no gesture needed), and
    // otherwise hand straight to the chooser. The chooser button click IS the
    // user gesture, so the user double-taps RESET and clicks within the same
    // few seconds - the USB chooser then opens while the board is still in DFU
    // mode and lists it for selection.
    const alreadyPaired = (await navigator.usb.getDevices()).find(
      (d) =>
        d.vendorId === this.config.vid &&
        d.productId === this.config.bootloaderPid,
    );
    if (alreadyPaired) {
      this.device = alreadyPaired;
      if (typeof window !== "undefined") {
        window._dfuDevice = alreadyPaired;
      }
      this.log.success("DFU bootloader already paired - continuing flash");
      return;
    }

    if (
      typeof window === "undefined" ||
      typeof window.requestDfuDevice !== "function"
    ) {
      throw new Error(
        "Could not enter the DFU bootloader automatically. Double-tap the " +
          "RESET button on the board, then try uploading again.",
      );
    }

    this.log.info(
      "DOUBLE-TAP the RESET button NOW - watch for the pulsing built-in LED - " +
        "then immediately click the button in the dialog and pick the board. " +
        "The DFU bootloader only stays active for a few seconds.",
    );

    // Keep the chooser strict: the official Arduino Renesas upload flow targets
    // the DFU bootloader PID for flashing. Selecting app-mode here leads to
    // InvalidStateError loops when a prior claimInterface timed out.
    const device = await window.requestDfuDevice(
      [{ vendorId: this.config.vid, productId: this.config.bootloaderPid }],
      "1. DOUBLE-TAP the RESET button on your Arduino now (the built-in LED " +
        "will pulse/fade).\n2. Then click \u201cSelect Device\u201d below and " +
        "pick the Arduino from the USB chooser to finish flashing.",
    );
    if (!device) {
      throw new Error("No DFU bootloader device selected.");
    }
    if (device.productId !== this.config.bootloaderPid) {
      throw new Error(
        "Selected device is not in DFU bootloader mode. Double-tap RESET " +
          "until the LED pulses, then choose the DFU bootloader device.",
      );
    }
    this.device = device;
    if (typeof window !== "undefined") {
      window._dfuDevice = device;
    }
    this.log.success("Bootloader device selected - continuing flash");
  }

  /**
   * Reboot the board into its DFU bootloader using the 1200bps touch.
   * Mirrors the official firmware behaviour (CheckSerialReset in
   * cores/arduino/usb/SerialUSB.cpp): opening the CDC port at 1200 baud and
   * dropping DTR makes the sketch write the double-tap magic and
   * watchdog-reset into the bootloader (PID 0x0369). Works entirely over
   * Web Serial - no WebUSB interface claim needed.
   * @param {SerialPort} port - Web Serial port for the board (any state)
   * @returns {Promise<boolean>} True when the touch sequence completed
   */
  async performSerialTouch(port) {
    this.log.section("1200BPS TOUCH: Entering Bootloader (Web Serial)");
    try {
      if (port.readable || port.writable) {
        await port.close();
      }
      // Chrome's open({baudRate:1200}) sends SET_LINE_CODING(1200) with DTR
      // low. The firmware's CheckSerialReset() can fire MID-OPEN and reboot
      // the board into the bootloader - which kills the COM port under
      // Chrome, so open() itself rejects with NetworkError even though the
      // touch WORKED. openPortWithRetry detects the re-enumeration
      // (SerialPort.connected === false) and reports it as success.
      const openResult = await this.openPortWithRetry(port, 1200, 8, 250);
      if (openResult === "reenumerated") {
        this.log.success(
          "CDC port vanished - board rebooted into the DFU bootloader",
        );
        return true;
      }
      this.log.info("Port opened at 1200 baud");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (typeof port.setSignals === "function") {
        await port.setSignals({
          dataTerminalReady: false,
          requestToSend: false,
        });
        this.log.info("DTR deasserted");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await port.close();
      } catch (closeError) {
        // The board may reboot mid-close; that's expected.
        this.log.info(`Close after touch: ${closeError.message}`);
      }
      this.log.success(
        "1200bps touch sent - board should reboot into DFU bootloader",
      );
      return true;
    } catch (error) {
      // Before declaring failure, check whether the board actually left
      // application mode (touch worked but every open raced the reboot).
      if (port.connected === false) {
        this.log.success(
          "CDC port vanished - board rebooted into the DFU bootloader",
        );
        return true;
      }
      this.log.warn(`1200bps touch failed: ${error.message}`);
      try {
        if (port.readable || port.writable) {
          await port.close();
        }
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /**
   * Open a Web Serial port, retrying while the OS releases the handle.
   * Detects board re-enumeration between attempts: when the 1200bps line
   * coding lands, the firmware reboots into the bootloader and the CDC
   * device disappears, so open() keeps failing even though the touch
   * succeeded. SerialPort.connected === false (Chrome 117+) or the port
   * vanishing from getPorts() identifies that case.
   * @param {SerialPort} port - Port to open
   * @param {number} baudRate - Baud rate for open()
   * @param {number} attempts - Maximum attempts
   * @param {number} delayMs - Delay between attempts
   * @returns {Promise<string>} "opened" or "reenumerated"
   */
  async openPortWithRetry(port, baudRate, attempts, delayMs) {
    let lastError = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        await port.open({ baudRate });
        if (i > 1) {
          this.log.info(`Port opened on attempt ${i}`);
        }
        return "opened";
      } catch (error) {
        lastError = error;
        const connected = port.connected;
        // connected === false means the OS-level device is gone: the board
        // re-enumerated (rebooted into its bootloader). That IS the goal.
        if (connected === false) {
          return "reenumerated";
        }
        // Fallback for older Chrome without SerialPort.connected: check
        // whether the granted app-mode serial port disappeared.
        if (connected === undefined) {
          try {
            const stillPresent = (await navigator.serial.getPorts()).some(
              (p) => {
                const info = p.getInfo();
                return (
                  info.usbVendorId === this.config.vid &&
                  info.usbProductId === this.config.applicationPid
                );
              },
            );
            if (!stillPresent) {
              return "reenumerated";
            }
          } catch {
            /* ignore */
          }
        }
        if (i < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  /** Poll for the device re-appearing with the bootloader PID */
  async waitForBootloader() {
    this.log.wait(3000, "Waiting for device to enter DFU bootloader...");
    const pollMs = 100;
    const attempts = Math.ceil(3000 / pollMs);

    for (let i = 0; i < attempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const devices = await navigator.usb.getDevices();
      this.device = devices.find(
        (d) =>
          d.vendorId === this.config.vid &&
          d.productId === this.config.bootloaderPid,
      );
      if (this.device) {
        this.log.success(
          `Device found in bootloader mode after ${(i + 1) * pollMs}ms`,
        );
        if (typeof window !== "undefined") {
          window._dfuDevice = this.device;
        }
        return;
      }
      if ((i + 1) % 10 === 0) {
        this.log.info(
          `Still waiting for DFU bootloader... ${(i + 1) * pollMs}ms elapsed`,
        );
      }
    }

    this.log.warn(
      "Bootloader not paired with the browser yet - prompting for one-time device selection...",
    );
    if (
      typeof window !== "undefined" &&
      typeof window.requestDfuDevice === "function"
    ) {
      // On first use Windows can take several seconds to install the driver
      // for the never-before-seen DFU device, so an early chooser may list
      // nothing. Allow a second attempt after a settling delay.
      const chooserMessage =
        "The board is now in DFU mode - its built-in LED should be PULSING. " +
        "Click \u201cSelect Device\u201d and pick the DFU device (e.g. " +
        "\u201cSantiago DFU\u201d for the R4 Minima). " +
        "If the list is EMPTY on Windows, the WinUSB driver is missing - " +
        "see the Drivers tab for the one-time install (Zadig, zadig.akeo.ie: " +
        "List All Devices \u2192 the DFU device \u2192 WinUSB \u2192 Install).";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const device = await window.requestDfuDevice(
            [
              {
                vendorId: this.config.vid,
                productId: this.config.bootloaderPid,
              },
            ],
            chooserMessage,
          );
          if (device) {
            if (device.productId !== this.config.bootloaderPid) {
              throw new Error(
                "Selected device is not in DFU bootloader mode. Double-tap " +
                  "RESET and select the bootloader device.",
              );
            }
            this.device = device;
            if (typeof window !== "undefined") {
              window._dfuDevice = device;
            }
            this.log.success("DFU device selected via manual prompt");
            return;
          }
        } catch (error) {
          if (error.name === "NotFoundError" && attempt < 2) {
            this.log.warn(
              "No device selected - waiting 4s for Windows to finish " +
                "installing the DFU driver, then offering the chooser again...",
            );
            await new Promise((resolve) => setTimeout(resolve, 4000));
            continue;
          }
          this.log.error(`Manual DFU selection failed: ${error.message}`);
          // An empty chooser on Windows means the WinUSB driver is not
          // installed for the DFU bootloader - show the same driver
          // guidance popup the Connect button uses, linking to the
          // Drivers tab, and surface the fix in the terminal error too.
          if (
            error.name === "NotFoundError" &&
            typeof navigator !== "undefined" &&
            /Windows/i.test(navigator.userAgent)
          ) {
            if (
              typeof window !== "undefined" &&
              typeof window.showDriverGuidance === "function"
            ) {
              window.showDriverGuidance("No DFU device selected", [
                "If the device list was EMPTY, Windows is missing the driver for the board's DFU bootloader (one-time setup, needed for all UNO R4 family boards: R4 Minima, R4 WiFi, Nano R4).",
                "1. Open Device Manager and look for a DFU device (e.g. 'Santiago DFU') with a yellow warning icon.",
                "2. Install the WinUSB driver with Zadig (zadig.akeo.ie): Options > List All Devices > the DFU device > WinUSB > Install - or install the Arduino IDE with the UNO R4 board package.",
                "3. Try uploading again - the full steps are on the Drivers tab.",
                "If you simply cancelled the dialog, dismiss this message.",
              ]);
            }
            throw new Error(
              "No DFU device was selected. If the device list was EMPTY, " +
                "Windows is missing the WinUSB driver for the board's DFU " +
                "bootloader (one-time setup for all UNO R4 family boards) - " +
                "see the Drivers tab for install steps (Zadig or the " +
                "Arduino IDE with the UNO R4 board package), then try " +
                "uploading again.",
            );
          }
          throw error;
        }
      }
    }
    throw new Error(
      "Device did not enter DFU bootloader mode. Please try again.",
    );
  }

  /** Locate the DFU interface (class 0xFE, subclass 0x01) */
  findDfuInterface() {
    if (!this.device.configuration) return null;
    for (const iface of this.device.configuration.interfaces) {
      for (const alternate of iface.alternates) {
        if (
          alternate.interfaceClass === 0xfe &&
          alternate.interfaceSubclass === 1
        ) {
          return iface;
        }
      }
    }
    return null;
  }

  /**
   * Claim a USB interface but reject if the OS never grants it. WebUSB's
   * claimInterface() can block indefinitely when another driver (e.g. the
   * host CDC-ACM serial driver) still holds the composite device, which
   * otherwise freezes the whole upload with no error. The timeout converts
   * that silent hang into a clear, actionable failure.
   * @param {number} interfaceNumber - Interface to claim
   * @param {number} timeoutMs - Milliseconds to wait before giving up
   * @returns {Promise<void>}
   */
  async claimInterfaceWithTimeout(interfaceNumber, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out claiming USB interface ${interfaceNumber} after ` +
              `${timeoutMs}ms. Another driver may still hold the port. ` +
              "Unplug and replug the board, close any other serial monitor, " +
              "then try again - or double-tap the RESET button to enter the " +
              "bootloader manually and use the Upload button.",
          ),
        );
      }, timeoutMs);
    });
    try {
      await Promise.race([
        this.device.claimInterface(interfaceNumber),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Log the device's USB interface/alternate descriptors for diagnostics */
  logInterfaceDescriptors() {
    try {
      const cfg = this.device.configuration;
      if (!cfg) {
        this.log.info("No active USB configuration to describe");
        return;
      }
      for (const iface of cfg.interfaces) {
        const alt = iface.alternates[0];
        const cls = alt.interfaceClass.toString(16).padStart(2, "0");
        const sub = alt.interfaceSubclass.toString(16).padStart(2, "0");
        this.log.info(
          `IF${iface.interfaceNumber}: class=0x${cls} subclass=0x${sub} claimed=${iface.claimed}`,
        );
      }
    } catch (err) {
      this.log.info(`Could not read interface descriptors: ${err.message}`);
    }
  }

  /** Log descriptor details for diagnostics */
  logDeviceInfo(dfuInterface) {
    try {
      this.log.info(`Device: ${this.device.productName || "Unknown"}`);
      this.log.info(
        `Manufacturer: ${this.device.manufacturerName || "Unknown"}`,
      );
      this.log.info(
        `VID: 0x${this.device.vendorId.toString(16).padStart(4, "0")}, PID: 0x${this.device.productId.toString(16).padStart(4, "0")}`,
      );
      if (dfuInterface && dfuInterface.alternates) {
        for (const alt of dfuInterface.alternates) {
          this.log.info(
            `  Alternate ${alt.alternateSetting}: ${alt.interfaceName || "unnamed"}`,
          );
          this.log.info(
            `    Class: 0x${alt.interfaceClass.toString(16)}, Subclass: 0x${alt.interfaceSubclass.toString(16)}, Protocol: 0x${alt.interfaceProtocol.toString(16)}`,
          );
          if (alt.endpoints && alt.endpoints.length > 0) {
            for (const ep of alt.endpoints) {
              this.log.info(
                `    Endpoint ${ep.endpointNumber}: ${ep.direction}, packetSize=${ep.packetSize}`,
              );
            }
          }
        }
      }
    } catch (error) {
      this.log.warn(`Could not log device info: ${error.message}`);
    }
  }

  /**
   * Read the DFU functional descriptor (type 0x21) from the configuration
   * descriptor to learn the device's true wTransferSize and attributes.
   */
  async readDfuFunctionalDescriptor() {
    try {
      let result = await this.device.controlTransferIn(
        {
          requestType: "standard",
          recipient: "device",
          request: 6, // GET_DESCRIPTOR
          value: 0x0200, // CONFIGURATION
          index: 0,
        },
        4,
      );
      if (result.status !== "ok" || !result.data) {
        this.log.warn("Failed to read configuration descriptor length");
        return null;
      }
      const totalLength = result.data.getUint16(2, true);

      result = await this.device.controlTransferIn(
        {
          requestType: "standard",
          recipient: "device",
          request: 6,
          value: 0x0200,
          index: 0,
        },
        totalLength,
      );
      if (result.status !== "ok" || !result.data) {
        this.log.warn("Failed to read full configuration descriptor");
        return null;
      }

      const view = result.data;
      let offset = 9; // skip configuration descriptor header
      while (offset < view.byteLength - 2) {
        const length = view.getUint8(offset);
        const type = view.getUint8(offset + 1);
        if (length === 0) break;
        if (type === 0x21 && length >= 7) {
          const attributes = view.getUint8(offset + 2);
          const detachTimeout = view.getUint16(offset + 3, true);
          const transferSize = view.getUint16(offset + 5, true);
          const dfuVersion =
            length >= 9 ? view.getUint16(offset + 7, true) : 0x0100;
          const descriptor = {
            canDownload: (attributes & 1) !== 0,
            canUpload: (attributes & 2) !== 0,
            manifestationTolerant: (attributes & 4) !== 0,
            willDetach: (attributes & 8) !== 0,
            detachTimeout,
            transferSize,
            dfuVersion,
          };
          this.log.info("DFU Functional Descriptor found:");
          this.log.info(`  wTransferSize: ${descriptor.transferSize}`);
          this.log.info(
            `  bmAttributes: 0x${attributes.toString(16).padStart(2, "0")}`,
          );
          this.log.info(
            `  CanDownload: ${descriptor.canDownload}, CanUpload: ${descriptor.canUpload}`,
          );
          this.log.info(
            `  ManifestationTolerant: ${descriptor.manifestationTolerant}`,
          );
          this.log.info(
            `  DFU Version: 0x${descriptor.dfuVersion.toString(16).padStart(4, "0")}`,
          );
          return descriptor;
        }
        offset += length;
      }
      this.log.warn("DFU functional descriptor not found in configuration");
      return null;
    } catch (error) {
      this.log.warn(
        `Failed to read DFU functional descriptor: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Flash firmware via DFU DNLOAD.
   * @param {SerialPort|null} _port - Unused (WebUSB, not serial)
   * @param {ArrayBuffer} firmwareData - Firmware (binary or Intel HEX)
   * @param {Function} onProgress - Progress callback (percent, status)
   * @param {string} _fqbn - Board FQBN
   */
  async flash(_port, firmwareData, onProgress, _fqbn) {
    this.log.section("FLASH: DFU Download");
    if (!this.device) {
      throw new Error("No DFU device available. Run prepare() first.");
    }

    let firmware = new Uint8Array(firmwareData);
    if (isIntelHex(firmware)) {
      this.log.info("Detected Intel HEX format, converting to binary...");
      try {
        const parsed = parseIntelHex(firmware);
        firmware = parsed.data;
        this.log.info(
          `Converted HEX to binary: ${firmware.length} bytes, start address: 0x${parsed.startAddress.toString(16).padStart(8, "0")}`,
        );
      } catch (error) {
        throw new Error(`Failed to parse Intel HEX: ${error.message}`);
      }
    }

    this.log.info(`Firmware size: ${firmware.length} bytes`);
    this.log.info(
      `Flash offset: 0x${this.config.flashOffset.toString(16).padStart(8, "0")}`,
    );
    this.log.info(`Transfer size: ${this.config.transferSize} bytes`);

    let interfaceNumber = null;
    try {
      if (this.device.opened) {
        this.log.info("Device already open, closing first...");
        try {
          await this.device.close();
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          this.log.warn(`Could not close device: ${error.message}`);
          // close() fails when a claimInterface() from a prior attempt is still
          // pending in the browser USB stack (InvalidStateError). The device
          // object is permanently stuck; open() will also fail. Surface a clear
          // message so the user knows what to do instead of showing a cryptic
          // WebUSB internal error.
          throw new Error(
            "The USB device is stuck from a previous operation. " +
              "Please double-tap the RESET button on the board (the LED will " +
              "pulse), then click Upload again.",
          );
        }
      }

      await this.device.open();
      this.log.info("Device opened");
      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }

      const dfuInterface = this.findDfuInterface();
      if (!dfuInterface) {
        throw new Error("No DFU interface found on device");
      }
      interfaceNumber = dfuInterface.interfaceNumber;
      await this.device.claimInterface(interfaceNumber);
      this.log.info(`Claimed interface ${interfaceNumber}`);
      this.logDeviceInfo(dfuInterface);

      // Prefer the device's own reported transfer size
      const descriptor = await this.readDfuFunctionalDescriptor();
      let transferSize = this.config.transferSize;
      if (descriptor && descriptor.transferSize > 0) {
        transferSize = descriptor.transferSize;
        this.log.info(
          `Using device's reported transfer size: ${transferSize} bytes`,
        );
      } else {
        this.log.warn(
          `Could not read device transfer size, using default: ${transferSize} bytes`,
        );
      }

      this.log.info(
        `Selecting alternate setting ${this.config.alternateSetting}`,
      );
      await this.device.selectAlternateInterface(
        interfaceNumber,
        this.config.alternateSetting,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      await this.clearStatus(interfaceNumber);
      let status = await this.getStatus(interfaceNumber);
      this.log.info(
        `Initial state: ${STATE_NAMES[status.state] || status.state}`,
      );

      if (status.state === DFU_STATE.dfuERROR) {
        this.log.warn("Device in error state, clearing...");
        await this.clearStatus(interfaceNumber);
        status = await this.getStatus(interfaceNumber);
      }
      if (status.state !== DFU_STATE.dfuIDLE) {
        await this.abort(interfaceNumber);
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await this.getStatus(interfaceNumber);
      }
      if (status.state !== DFU_STATE.dfuIDLE) {
        throw new Error(
          `Device not in dfuIDLE state: ${STATE_NAMES[status.state] || status.state}`,
        );
      }

      const totalBlocks = Math.ceil(firmware.length / transferSize);
      let blockNum = 0;
      this.log.info(
        `Downloading ${totalBlocks} blocks (${transferSize} bytes each)`,
      );
      if (onProgress) onProgress(10, "Starting DFU download...");

      let bytesSent = 0;
      while (bytesSent < firmware.length) {
        const bytesLeft = firmware.length - bytesSent;
        const chunkSize = Math.min(bytesLeft, transferSize);
        const chunk = firmware.slice(bytesSent, bytesSent + chunkSize);

        if (blockNum < 3) {
          this.log.info(
            `Block ${blockNum}, size=${chunk.length}, first bytes: ${Array.from(
              chunk.slice(0, 8),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")}`,
          );
        }

        try {
          await this.downloadWithRetry(interfaceNumber, chunk, blockNum);
          status = await this.pollUntilIdle(
            interfaceNumber,
            DFU_STATE.dfuDNLOAD_IDLE,
          );
          if (status.state === DFU_STATE.dfuERROR) {
            throw new Error(
              `DFU error: ${STATUS_NAMES[status.status] || status.status}`,
            );
          }
          if (status.status !== DFU_STATUS.OK) {
            throw new Error(
              `DFU status error: ${STATUS_NAMES[status.status] || status.status}`,
            );
          }
          blockNum++;
          bytesSent += chunkSize;
          if (blockNum % 20 === 0) {
            const percent = Math.floor(10 + (bytesSent / firmware.length) * 80);
            if (onProgress) {
              onProgress(percent, "Flashing");
            }
          }
        } catch (error) {
          this.log.error(`Block ${blockNum} transfer failed: ${error.message}`);
          throw new Error(
            `Failed to write block ${blockNum}: ${error.message}`,
          );
        }
      }

      this.log.info(
        `Successfully wrote ${blockNum} blocks (${bytesSent} bytes)`,
      );

      // Zero-length DNLOAD signals end of download
      this.log.info("Sending end-of-download signal");
      try {
        await this.downloadWithRetry(
          interfaceNumber,
          new Uint8Array(0),
          blockNum,
        );
      } catch (error) {
        this.log.warn(
          `End-of-download signal failed (may be OK): ${error.message}`,
        );
      }

      this.log.info("Waiting for manifestation...");
      if (onProgress) onProgress(95, "Finalizing flash...");
      status = await this.getStatus(dfuInterface.interfaceNumber);
      while (
        status.state === DFU_STATE.dfuMANIFEST_SYNC ||
        status.state === DFU_STATE.dfuMANIFEST
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, status.pollTimeout || 100),
        );
        try {
          status = await this.getStatus(dfuInterface.interfaceNumber);
        } catch {
          break; // device may reset during manifestation
        }
      }

      this.log.info("Triggering device reset...");
      try {
        await this.device.controlTransferOut(
          {
            requestType: "class",
            recipient: "interface",
            request: DFU_REQUEST.DETACH,
            value: 1000,
            index: interfaceNumber,
          },
          new ArrayBuffer(0),
        );
        this.log.info("DFU DETACH sent");
      } catch (error) {
        this.log.info(`DETACH result: ${error.message} (may be OK)`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        if (typeof this.device.reset === "function") {
          await this.device.reset();
          this.log.info("USB reset sent");
        }
      } catch (error) {
        this.log.info(`USB reset result: ${error.message} (may be OK)`);
      }

      this.log.success("DFU download complete!");
      if (onProgress) onProgress(100, "Upload complete!");
      try {
        await this.device.close();
      } catch {
        /* device likely re-enumerating */
      }
    } catch (error) {
      this.log.error(`DFU flash failed: ${error.message}`);
      try {
        await this.device.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /** DfuSe set-address command (STM32H7 boards only) */
  async setAddress(interfaceNumber, address) {
    if (!this.config.useDfuSe) {
      this.log.info("Skipping DfuSe set-address (TinyUSB uses standard DFU)");
      return;
    }
    this.log.info(`Setting flash address: 0x${address.toString(16)}`);
    const command = new Uint8Array(5);
    command[0] = 0x21; // DfuSe: Set Address Pointer
    command[1] = address & 0xff;
    command[2] = (address >> 8) & 0xff;
    command[3] = (address >> 16) & 0xff;
    command[4] = (address >> 24) & 0xff;

    await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_REQUEST.DNLOAD,
        value: 0,
        index: interfaceNumber,
      },
      command,
    );

    let status = await this.getStatus(interfaceNumber);
    while (status.state === DFU_STATE.dfuDNBUSY) {
      await new Promise((resolve) =>
        setTimeout(resolve, status.pollTimeout || 10),
      );
      status = await this.getStatus(interfaceNumber);
    }
    if (status.status !== DFU_STATUS.OK) {
      throw new Error(`Set address failed: ${STATUS_NAMES[status.status]}`);
    }
  }

  /** DNLOAD one block */
  async downloadWithRetry(interfaceNumber, data, blockNum) {
    let buffer;
    if (data instanceof Uint8Array) {
      buffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
    } else {
      buffer = data;
    }
    const result = await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_REQUEST.DNLOAD,
        value: blockNum,
        index: interfaceNumber,
      },
      buffer,
    );
    if (result.status !== "ok") {
      throw new Error(`controlTransferOut failed: ${result.status}`);
    }
    return result;
  }

  /** Poll GETSTATUS until the target state (or error) is reached */
  async pollUntilIdle(interfaceNumber, targetState) {
    let status = await this.getStatus(interfaceNumber);
    while (
      status.state !== targetState &&
      status.state !== DFU_STATE.dfuERROR
    ) {
      const waitMs = Math.max(status.pollTimeout || 100, 10);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      status = await this.getStatus(interfaceNumber);
    }
    return status;
  }

  /** DFU_GETSTATUS */
  async getStatus(interfaceNumber) {
    const result = await this.device.controlTransferIn(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_REQUEST.GETSTATUS,
        value: 0,
        index: interfaceNumber,
      },
      6,
    );
    if (result.status !== "ok" || !result.data) {
      throw new Error("Failed to get DFU status");
    }
    const bytes = new Uint8Array(result.data.buffer);
    return {
      status: bytes[0],
      pollTimeout: bytes[1] | (bytes[2] << 8) | (bytes[3] << 16),
      state: bytes[4],
    };
  }

  /** DFU_CLRSTATUS */
  async clearStatus(interfaceNumber) {
    await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_REQUEST.CLRSTATUS,
        value: 0,
        index: interfaceNumber,
      },
      new ArrayBuffer(0),
    );
  }

  /** DFU_ABORT */
  async abort(interfaceNumber) {
    await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: DFU_REQUEST.ABORT,
        value: 0,
        index: interfaceNumber,
      },
      new ArrayBuffer(0),
    );
  }

  /** Release the WebUSB device */
  async cleanup() {
    this.log.section("CLEANUP");
    if (this.device) {
      try {
        await this.device.close();
        this.log.info("Device closed");
      } catch (error) {
        this.log.warn(`Cleanup warning: ${error.message}`);
      }
      this.device = null;
    }
  }
}
