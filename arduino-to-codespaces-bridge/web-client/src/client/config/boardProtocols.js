/**
 * Board Protocol Configuration
 *
 * SINGLE SOURCE OF TRUTH for all protocol parameters.
 * These values MUST match the YAML protocol files in Arduino_Upload_to_WebSerialAPI_Tool/protocols/
 *
 * When updating, verify against:
 * - protocols/bossa-renesas.yaml
 * - protocols/stk500v1.yaml
 * - Wireshark captures in captures/
 */

export const PROTOCOL_TYPES = {
  STK500: "STK500v1",
  BOSSA: "BOSSA",
  DFU: "DFU",
  ESPTOOL: "ESPTool",
  RP2040: "RP2040",
  TEENSY: "Teensy",
  UNKNOWN: "Unknown",
};

/**
 * STK500v1 Protocol Configuration
 * Reference: protocols/stk500v1.yaml
 */
export const STK500_CONFIG = {
  protocol: PROTOCOL_TYPES.STK500,

  serial: {
    baudUpload: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },

  timing: {
    syncTimeoutMs: 500,
    commandTimeoutMs: 500,
    writeTimeoutMs: 1000,
    syncRetries: 5,
  },

  memory: {
    pageSize: 128, // 128 bytes per page - from YAML
    flashSize: 0x8000, // 32KB for ATmega328P
    bootStart: 0x7e00,
  },

  constants: {
    STK_OK: 0x10,
    STK_INSYNC: 0x14,
    CRC_EOP: 0x20,
    STK_GET_SYNC: 0x30,
    STK_ENTER_PROGMODE: 0x50,
    STK_LEAVE_PROGMODE: 0x51,
    STK_LOAD_ADDRESS: 0x55,
    STK_PROG_PAGE: 0x64,
  },
};

/**
 * BOSSA/SAM-BA Protocol Configuration for Renesas RA4M1
 * Reference: protocols/bossa-renesas.yaml, R4.pcapng capture
 */
export const BOSSA_RENESAS_CONFIG = {
  protocol: PROTOCOL_TYPES.BOSSA,
  variant: "renesas-ra4m1",

  serial: {
    baudTouch: 1200, // For bootloader entry
    baudUpload: 230400, // Upload baud rate - from YAML & Wireshark
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },

  timing: {
    resetDelayMs: 2500, // Wait after 1200 touch - CRITICAL
    commandTimeoutMs: 1000,
    writeTimeoutMs: 5000,
    eraseTimeoutMs: 10000,
    retryCount: 3,
    retryDelayMs: 500,
  },

  memory: {
    flashBase: 0x00000000,
    flashSize: 0x40000, // 256KB
    sketchOffset: 0x4000, // 16KB - bootloader adds this internally
    pageSize: 256,
    chunkSize: 4096, // 4KB chunks - from YAML & Wireshark capture!
    sramBufferOffset: 0x34, // Offset in bootloader's data_buffer
  },

  // Bootloader PID for the R4 WiFi (ESP32-S3 bridge in SAM-BA mode).
  // SAMD boards define their own bootloader PIDs via makeSamd21Config().
  bootloaderPids: [0x006d],
};

/**
 * BOSSA (SAM-BA Extended) configuration for nRF52 boards (Nano 33 BLE).
 * Uses the flash applet buffer-write flow like the R4, but with nRF52
 * memory layout. Manual bootloader entry (double-tap) is detected before
 * attempting the 1200 baud touch.
 */
export const BOSSA_NRF52_CONFIG = {
  protocol: PROTOCOL_TYPES.BOSSA,
  variant: "nrf52",

  serial: {
    baudTouch: 1200,
    baudUpload: 115200,
    baudFallback: 921600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },

  timing: {
    resetDelayMs: 2500,
    commandTimeoutMs: 1000,
    writeTimeoutMs: 5000,
    eraseTimeoutMs: 10000,
    retryCount: 3,
    retryDelayMs: 500,
  },

  memory: {
    flashBase: 0x00000000,
    flashSize: 0xf0000, // 960KB usable (1MB - SoftDevice/bootloader)
    sketchOffset: 0x10000, // 64KB
    pageSize: 4096,
    chunkSize: 4096,
    sramBufferOffset: 0x34,
  },

  useDirectFlashWrite: false,
  applicationPids: [0x005a, 0x805a, 0x015a, 0x025a],
  bootloaderPids: [],
};

/**
 * Build a WebUSB DFU configuration (Renesas R4 family and STM32H7 mbed
 * boards). These boards do not expose a SAM-BA serial bootloader; firmware
 * is written over USB DFU (DFU 1.1 state machine).
 * @param {object} options - Per-board USB/memory parameters
 * @returns {object} DFU protocol configuration
 */
function makeDfuConfig({
  variant,
  applicationPid,
  bootloaderPid,
  transferSize,
  flashBase = 0x00000000,
  flashOffset,
  flashSize,
  manifestTimeoutMs = 5000,
  use1200bpsTouch = false,
}) {
  return {
    protocol: PROTOCOL_TYPES.DFU,
    variant,
    usb: {
      vid: 0x2341, // Arduino
      applicationPid,
      bootloaderPid,
      transferSize,
      interfaceNumber: 0,
      alternateSetting: 0,
    },
    timing: {
      detachTimeoutMs: 1000,
      pollIntervalMs: 100,
      manifestTimeoutMs,
    },
    memory: {
      flashBase,
      flashOffset,
      flashSize,
    },
    use1200bpsTouch,
  };
}

/** Uno R4 Minima (and unor4minima alias) */
export const DFU_MINIMA_CONFIG = makeDfuConfig({
  variant: "renesas-ra4m1-dfu",
  applicationPid: 0x0069,
  bootloaderPid: 0x0369,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x40000,
});

/** Nano R4 */
export const DFU_NANOR4_CONFIG = makeDfuConfig({
  variant: "renesas-ra4m1-dfu",
  applicationPid: 0x0074,
  bootloaderPid: 0x0374,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x40000,
});

/** Portenta C33 */
export const DFU_PORTENTA_C33_CONFIG = makeDfuConfig({
  variant: "renesas-dfu",
  applicationPid: 0x0068,
  bootloaderPid: 0x0368,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x200000,
});

/** Opta Digital */
export const DFU_OPTA_DIGITAL_CONFIG = makeDfuConfig({
  variant: "renesas-dfu",
  applicationPid: 0x006e,
  bootloaderPid: 0x016e,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x40000,
});

/** Opta Analog */
export const DFU_OPTA_ANALOG_CONFIG = makeDfuConfig({
  variant: "renesas-dfu",
  applicationPid: 0x0071,
  bootloaderPid: 0x0171,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x40000,
});

/** Science Kit / muxto */
export const DFU_MUXTO_CONFIG = makeDfuConfig({
  variant: "renesas-dfu",
  applicationPid: 0x006c,
  bootloaderPid: 0x016c,
  transferSize: 64,
  flashOffset: 0x10000,
  flashSize: 0x40000,
});

/** Portenta H7 (envie_m7) */
export const DFU_PORTENTA_H7_CONFIG = makeDfuConfig({
  variant: "stm32h7-dfu",
  applicationPid: 0x025b,
  bootloaderPid: 0x035b,
  transferSize: 2048,
  flashBase: 0x08000000,
  flashOffset: 0x08040000,
  flashSize: 0x200000,
  manifestTimeoutMs: 10000,
  use1200bpsTouch: true,
});

/** Giga R1 */
export const DFU_GIGA_CONFIG = makeDfuConfig({
  variant: "stm32h7-dfu",
  applicationPid: 0x0266,
  bootloaderPid: 0x0366,
  transferSize: 2048,
  flashBase: 0x08000000,
  flashOffset: 0x08040000,
  flashSize: 0x200000,
  manifestTimeoutMs: 10000,
  use1200bpsTouch: true,
});

/** Nicla Vision */
export const DFU_NICLA_VISION_CONFIG = makeDfuConfig({
  variant: "stm32h7-dfu",
  applicationPid: 0x025f,
  bootloaderPid: 0x035f,
  transferSize: 2048,
  flashBase: 0x08000000,
  flashOffset: 0x08040000,
  flashSize: 0x200000,
  manifestTimeoutMs: 10000,
  use1200bpsTouch: true,
});

/** Opta (mbed) */
export const DFU_MBED_OPTA_CONFIG = makeDfuConfig({
  variant: "stm32h7-dfu",
  applicationPid: 0x0064,
  bootloaderPid: 0x0164,
  transferSize: 2048,
  flashBase: 0x08000000,
  flashOffset: 0x08040000,
  flashSize: 0x200000,
  manifestTimeoutMs: 10000,
  use1200bpsTouch: true,
});

/**
 * Build a SAM-BA configuration for SAMD21 boards (MKR family, Nano 33 IoT,
 * Zero). Same wire protocol as the R4 WiFi but with the SAMD21 memory
 * layout (8KB bootloader at 0x0000, sketch at 0x2000) and per-board USB
 * bootloader PIDs (bootloader PID = application PID - 0x8000, per
 * ArduinoCore-samd boards.txt).
 * @param {number[]} bootloaderPids - Bootloader product IDs for the board
 * @returns {object} BOSSA protocol configuration
 */
function makeSamd21Config(bootloaderPids) {
  return {
    ...BOSSA_RENESAS_CONFIG,
    variant: "samd21",
    memory: {
      ...BOSSA_RENESAS_CONFIG.memory,
      chunkSize: 4096,
      sketchOffset: 0x2000,
    },
    bootloaderPids,
  };
}

/**
 * Board to Protocol mapping
 */
export const BOARD_PROTOCOL_MAP = {
  // AVR boards - STK500v1
  "arduino:avr:uno": STK500_CONFIG,
  "arduino:avr:nano": STK500_CONFIG,
  "arduino:avr:mega": {
    ...STK500_CONFIG,
    memory: { ...STK500_CONFIG.memory, flashSize: 0x40000, pageSize: 256 },
  },
  "arduino:avr:leonardo": STK500_CONFIG,
  "arduino:avr:micro": STK500_CONFIG,

  // Renesas boards
  "arduino:renesas_uno:unor4wifi": BOSSA_RENESAS_CONFIG,
  "arduino:renesas_uno:minima": DFU_MINIMA_CONFIG,
  "arduino:renesas_uno:unor4minima": DFU_MINIMA_CONFIG,
  "arduino:renesas_uno:nanor4": DFU_NANOR4_CONFIG,
  "arduino:renesas_uno:portenta_c33": DFU_PORTENTA_C33_CONFIG,
  "arduino:renesas_uno:opta_digital": DFU_OPTA_DIGITAL_CONFIG,
  "arduino:renesas_uno:opta_analog": DFU_OPTA_ANALOG_CONFIG,
  "arduino:renesas_uno:muxto": DFU_MUXTO_CONFIG,

  // mbed STM32H7 boards - WebUSB DFU
  "arduino:mbed_portenta:envie_m7": DFU_PORTENTA_H7_CONFIG,
  "arduino:mbed_giga:giga": DFU_GIGA_CONFIG,
  "arduino:mbed_nicla:nicla_vision": DFU_NICLA_VISION_CONFIG,
  "arduino:mbed_opta:opta": DFU_MBED_OPTA_CONFIG,

  // SAMD21 boards - same SAM-BA protocol, SAMD21 memory layout, per-board
  // bootloader PIDs from ArduinoCore-samd boards.txt (boot = app - 0x8000)
  "arduino:samd:mkr1000": makeSamd21Config([0x004e, 0x024e]),
  "arduino:samd:mkrzero": makeSamd21Config([0x004f]),
  "arduino:samd:mkrwifi1010": makeSamd21Config([0x0054]),
  "arduino:samd:nano_33_iot": makeSamd21Config([0x0057]),
  "arduino:samd:arduino_zero_native": makeSamd21Config([0x004d, 0x024d]),

  // mbed boards - BOSSA variant
  "arduino:mbed_nano:nano33ble": BOSSA_NRF52_CONFIG,
};

/**
 * Get protocol configuration for a board
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {Object} Protocol configuration
 */
export function getProtocolConfig(fqbn) {
  if (!fqbn) return null;

  // Direct match
  if (BOARD_PROTOCOL_MAP[fqbn]) {
    return BOARD_PROTOCOL_MAP[fqbn];
  }

  // Partial match (e.g., "arduino:avr" matches "arduino:avr:uno")
  for (const [key, config] of Object.entries(BOARD_PROTOCOL_MAP)) {
    if (fqbn.startsWith(key.split(":").slice(0, 2).join(":"))) {
      return config;
    }
  }

  return null;
}

/**
 * Get protocol type for a board
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {string} Protocol type
 */
export function getProtocolType(fqbn) {
  const config = getProtocolConfig(fqbn);
  return config?.protocol || PROTOCOL_TYPES.UNKNOWN;
}

/**
 * Get chunk size for a board's protocol
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {number} Chunk size in bytes
 */
export function getChunkSize(fqbn) {
  const config = getProtocolConfig(fqbn);
  if (!config) return 2048; // Fallback

  // Use chunkSize if available, otherwise pageSize
  return config.memory?.chunkSize || config.memory?.pageSize || 2048;
}

/**
 * Get page size for a board's protocol
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {number} Page size in bytes
 */
export function getPageSize(fqbn) {
  const config = getProtocolConfig(fqbn);
  return config?.memory?.pageSize || 128;
}

/**
 * Get upload baud rate for a board
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {number} Baud rate
 */
export function getUploadBaudRate(fqbn) {
  const config = getProtocolConfig(fqbn);
  return config?.serial?.baudUpload || 115200;
}

/**
 * Check if board uses 1200 baud touch for bootloader entry
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {boolean}
 */
export function uses1200BaudTouch(fqbn) {
  const config = getProtocolConfig(fqbn);
  return config?.serial?.baudTouch === 1200;
}

export default {
  PROTOCOL_TYPES,
  STK500_CONFIG,
  BOSSA_RENESAS_CONFIG,
  BOARD_PROTOCOL_MAP,
  getProtocolConfig,
  getProtocolType,
  getChunkSize,
  getPageSize,
  getUploadBaudRate,
  uses1200BaudTouch,
};

// Convenience aliases for shorter imports
export const STK500 = STK500_CONFIG;
export const BOSSA_RENESAS = BOSSA_RENESAS_CONFIG;
