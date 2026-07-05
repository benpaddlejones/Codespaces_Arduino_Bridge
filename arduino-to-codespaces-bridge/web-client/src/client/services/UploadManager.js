/**
 * Upload Manager Service
 *
 * Manages firmware uploads to Arduino boards:
 * - Strategy selection based on board FQBN
 * - Supports multiple upload protocols (STK500, BOSSA, ESPTool, etc.)
 * - Progress reporting and error handling
 *
 * @module client/services/UploadManager
 */

import { AVRStrategy } from "./strategies/AVRStrategy.js";
import { BOSSAStrategy } from "./strategies/BOSSAStrategy.js";
import { DFUStrategy } from "./strategies/DFUStrategy.js";
import { ESPToolStrategy } from "./strategies/ESPToolStrategy.js";
import { TeensyStrategy } from "./strategies/TeensyStrategy.js";
import { RP2040Strategy } from "./strategies/RP2040Strategy.js";
import { UploadLogger } from "./utils/UploadLogger.js";

// =============================================================================
// UploadManager Class
// =============================================================================

/**
 * Manages firmware uploads using board-specific strategies
 */
export class UploadManager {
  constructor() {
    this.log = new UploadLogger("Manager");

    /** @type {Object<string, object>} Strategy instances keyed by FQBN prefix */
    this.strategies = {
      "arduino:avr": new AVRStrategy(),
      // R4 WiFi has a SAM-BA serial bootloader; the Minima family and
      // relatives only expose USB DFU
      "arduino:renesas_uno:unor4wifi": new BOSSAStrategy(),
      "arduino:renesas_uno:minima": new DFUStrategy(),
      "arduino:renesas_uno:unor4minima": new DFUStrategy(),
      "arduino:renesas_uno:nanor4": new DFUStrategy(),
      "arduino:renesas_uno:portenta_c33": new DFUStrategy(),
      "arduino:renesas_uno:opta_digital": new DFUStrategy(),
      "arduino:renesas_uno:opta_analog": new DFUStrategy(),
      "arduino:renesas_uno:muxto": new DFUStrategy(),
      "arduino:renesas_uno": new BOSSAStrategy(),
      "arduino:samd": new BOSSAStrategy(),
      "arduino:esp32": new ESPToolStrategy(),
      "esp32:esp32": new ESPToolStrategy(),
      "teensy:avr": new TeensyStrategy(),
      "arduino:mbed_nano": new BOSSAStrategy(),
      "arduino:mbed_portenta:envie_m7": new DFUStrategy(),
      "arduino:mbed_portenta": new BOSSAStrategy(),
      "arduino:mbed_giga:giga": new DFUStrategy(),
      "arduino:mbed_nicla:nicla_vision": new DFUStrategy(),
      "arduino:mbed_opta:opta": new DFUStrategy(),
      "arduino:mbed_rp2040": new RP2040Strategy(),
      "rp2040:rp2040": new RP2040Strategy(),
    };
  }

  /**
   * Get the appropriate upload strategy for a board.
   * Longest-prefix match so specific entries (e.g. unor4wifi) win over
   * family entries (arduino:renesas_uno).
   * @param {string} fqbn - Fully qualified board name
   * @returns {object} Upload strategy instance
   */
  getStrategy(fqbn) {
    if (!fqbn) return this.strategies["arduino:avr"];

    const keys = Object.keys(this.strategies).sort(
      (a, b) => b.length - a.length,
    );
    for (const key of keys) {
      if (fqbn.startsWith(key)) {
        return this.strategies[key];
      }
    }

    return this.strategies["arduino:avr"];
  }

  /**
   * Upload firmware to a board
   * @param {SerialPort} port - Serial port for upload
   * @param {ArrayBuffer|string} hexString - Firmware data
   * @param {function} progressCallback - Progress callback (percent, status)
   * @param {string} fqbn - Fully qualified board name
   * @returns {Promise<SerialPort>} The port used for flashing - may differ
   *   from the input when the device re-enumerated into its bootloader
   * @throws {Error} If upload fails
   */
  async upload(port, hexString, progressCallback, fqbn) {
    const strategy = this.getStrategy(fqbn);
    if (!strategy) {
      throw new Error(`No upload strategy found for board: ${fqbn}`);
    }

    this.log.info(
      `Using ${strategy.name || "unknown strategy"} for ${
        fqbn || "default (arduino:avr)"
      }`,
    );

    try {
      // prepare() may return a replacement port (bootloader re-enumeration)
      const activePort = (await strategy.prepare(port, fqbn)) || port;
      await strategy.flash(activePort, hexString, progressCallback, fqbn);
      return activePort;
    } catch (error) {
      this.log.error("Upload failed", error);
      throw error;
    }
  }
}
