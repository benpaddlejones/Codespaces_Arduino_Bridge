/**
 * BOSSA Upload Strategy
 *
 * Upload strategy for Renesas/SAMD-based Arduino boards using SAM-BA protocol:
 * - Arduino Uno R4 WiFi
 * - Arduino Uno R4 Minima
 * - Arduino Nano R4
 * - Other Renesas RA4M1 and SAMD-based boards
 *
 * Uses 1200 baud touch sequence to enter bootloader mode.
 *
 * BOOTLOADER ENTRY: Works reliably via 1200 baud touch
 * =======================================================
 * The 1200 baud touch sequence successfully triggers bootloader mode:
 *   1. Open port at 1200 baud with DTR=1, RTS=1
 *   2. Toggle DTR=0 to trigger reset
 *   3. Close port and wait ~500ms for RA4M1 to enter bootloader
 *   4. Reconnect at 230400 baud for BOSSA protocol
 *
 * PROTOCOL: SAM-BA Extended (BOSSA)
 * ==================================
 * - Baud rate: From config (230400 for Renesas)
 * - Commands: N#, V#, S#, Y#, G# (see Bossa.js for details)
 * - Flash offset: From config (0x4000 for Renesas)
 * - Chunk size: From config (4096 bytes - MUST match Wireshark capture!)
 *
 * SOURCE OF TRUTH:
 * @see config/boardProtocols.js - Protocol configuration
 * @see protocols/bossa-renesas.yaml - YAML definition
 * @see https://github.com/arduino/arduino-renesas-bootloader/blob/main/src/bossa.c
 *
 * @module client/services/strategies/BOSSAStrategy
 */

import { BossaProtocol } from "../protocols/Bossa.js";
import {
  BOSSA_RENESAS_CONFIG,
  getProtocolConfig,
} from "../../config/boardProtocols.js";
import { UploadLogger } from "../utils/UploadLogger.js";
import { isIntelHex, parseIntelHex } from "../utils/intelHex.js";

// =============================================================================
// BOSSAStrategy Class
// =============================================================================

/**
 * Upload strategy for BOSSA/SAM-BA protocol boards
 * @implements {UploadStrategy}
 */
export class BOSSAStrategy {
  /**
   * Create a new BOSSAStrategy instance
   */
  constructor() {
    /** @type {string} Human-readable strategy name */
    this.name = "BOSSA/SAM-BA";

    /** @type {UploadLogger} Logger instance */
    this.log = new UploadLogger("BOSSA");

    // Load configuration from centralized config (matches YAML protocol files)
    /** @type {Object} Protocol configuration */
    this.config = BOSSA_RENESAS_CONFIG;

    /** @type {Object} Board-specific config selected in prepare() */
    this.activeConfig = this.config;
    this.setActiveConfig(this.config);
  }

  /**
   * Select the board-specific protocol configuration. Derives the baud
   * plan (primary/touch/fallback rates) from the active config so nRF52
   * boards probe their own rates before the generic scan.
   * @param {Object} config - Board protocol configuration
   */
  setActiveConfig(config) {
    this.activeConfig = config || this.config;
    const serial = this.activeConfig.serial || {};
    const defaults = this.config.serial || {};
    this.PRIMARY_BAUD = serial.baudUpload || defaults.baudUpload;
    this.TOUCH_BAUD = serial.baudTouch || defaults.baudTouch;

    const fallback = serial.baudFallback;
    const rates = [
      this.PRIMARY_BAUD,
      fallback,
      230400,
      115200,
      921600,
      460800,
      57600,
      38400,
      19200,
      9600,
    ];
    this.ALL_BAUD_RATES = [...new Set(rates.filter(Boolean))];
  }

  /**
   * Safely close port, releasing any locked streams
   */
  async safeClose(port) {
    try {
      if (port.readable && port.readable.locked) {
        try {
          const reader = port.readable.getReader();
          await reader.cancel();
          reader.releaseLock();
        } catch (e) {
          /* ignore */
        }
      }
      if (port.writable && port.writable.locked) {
        try {
          const writer = port.writable.getWriter();
          writer.releaseLock();
        } catch (e) {
          /* ignore */
        }
      }
      if (port.readable || port.writable) {
        await port.close();
      }
    } catch (e) {
      this.log.warn(`Port close warning: ${e.message}`);
    }
    // Wait for OS to release
    await new Promise((r) => setTimeout(r, 100));
  }

  /**
   * Set control signals, tolerating the errors that occur when the device
   * resets mid-call (expected during the 1200 baud touch).
   */
  async setSignalsSafe(port, signals) {
    try {
      await port.setSignals(signals);
    } catch (e) {
      const message = e?.message || "Unknown error";
      const expected =
        message.includes("Failed to set control signals") ||
        message.includes("device has been lost");
      const label = JSON.stringify(signals);
      if (expected) {
        this.log.info(
          `setSignals info (${label}): ${message} (likely reset in progress)`,
        );
      } else {
        this.log.warn(`setSignals warning (${label}): ${message}`);
      }
    }
  }

  /**
   * Detect manual bootloader entry (double-tap) without resetting the
   * device: probe with N# and look for the bootloader's CR/LF-only ACK.
   * Seeing user-sketch output instead means a 1200 touch is required.
   * @returns {Promise<boolean>} True when the bootloader answered
   */
  async probeBootloaderWithoutReset(port) {
    const rates = [this.PRIMARY_BAUD, this.activeConfig?.serial?.baudFallback]
      .filter(Boolean)
      .filter((rate, index, all) => all.indexOf(rate) === index);
    if (rates.length === 0) return false;

    let sawSketchOutput = false;
    for (const baudRate of rates) {
      let reader = null;
      let writer = null;
      let detected = false;
      try {
        await this.safeClose(port);
        await port.open({ baudRate });
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        reader = port.readable?.getReader?.();
        writer = port.writable?.getWriter?.();
        if (!reader || !writer) continue;

        const encoder = new TextEncoder();
        await writer.write(encoder.encode("N#"));

        const collected = [];
        const windowMs = 250;
        const start = Date.now();
        while (Date.now() - start < windowMs) {
          const remaining = Math.max(0, windowMs - (Date.now() - start));
          const waitMs = Math.min(remaining, 40);
          const timeout = new Promise((resolve) =>
            setTimeout(() => resolve("timeout"), waitMs),
          );
          const result = await Promise.race([reader.read(), timeout]);
          if (result === "timeout") continue;
          const { value, done } = result;
          if (done) break;
          if (value && value.length) {
            collected.push(...value);
            const bytes = new Uint8Array(collected);
            // Bootloader N# ACK is just CR/LF bytes
            if (
              bytes.length > 0 &&
              bytes.length <= 4 &&
              bytes.every((b) => b === 10 || b === 13)
            ) {
              detected = true;
              this.log.success(
                `Device already responding to bootloader commands at ${baudRate} baud`,
              );
              break;
            }
            if (collected.length > 4 && !sawSketchOutput) {
              sawSketchOutput = true;
              this.log.info(
                "Manual bootloader probe saw user sketch output; will perform 1200 baud touch",
              );
              break;
            }
          }
        }
      } catch {
        /* probe is best-effort */
      } finally {
        if (reader) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          reader.releaseLock();
        }
        if (writer) {
          try {
            writer.releaseLock();
          } catch {
            /* ignore */
          }
        }
        await this.safeClose(port);
      }
      if (detected) return true;
    }
    return false;
  }

  /**
   * Perform the 1200 baud touch sequence to enter bootloader mode
   *
   * From USB captures (R4.pcapng, NANO_Sense_BLE.pcapng):
   *   Frame 2589: SET_LINE_CODING = 1200
   *   Frame 2593: SET_CONTROL_LINE_STATE = DTR=1, RTS=1
   *   Frame 2595: SET_LINE_CODING = 1200 (again!)
   *   Frame 2601: SET_CONTROL_LINE_STATE = DTR=0, RTS=1
   *   (hold DTR LOW with the port open - critical for nRF52 - then release)
   * @param {SerialPort} port - Serial port
   * @param {number} [resetDelayMs=500] - Board-specific reset delay budget
   */
  async perform1200Touch(port, resetDelayMs = 500) {
    this.log.section("1200 BAUD TOUCH SEQUENCE");
    this.log.info(
      "Matching exact USB capture sequence (NANO_Sense_BLE.pcapng)",
    );

    await this.safeClose(port);

    // Step 1: First SET_LINE_CODING at 1200 baud
    this.log.serialConfig(
      this.TOUCH_BAUD,
      "First SET_LINE_CODING - open at 1200 baud",
    );
    await port.open({ baudRate: this.TOUCH_BAUD });

    // Step 2: SET_CONTROL_LINE_STATE = DTR=1, RTS=1 (0x0003)
    this.log.signal("DTR", true, "SET_CONTROL_LINE_STATE = 0x0003");
    this.log.signal("RTS", true, "Both control lines HIGH");
    await this.setSignalsSafe(port, {
      dataTerminalReady: true,
      requestToSend: true,
    });

    // Step 3: Second SET_LINE_CODING at 1200 (close and reopen to force)
    this.log.info("Forcing second SET_LINE_CODING by close/reopen");
    await port.close();
    await new Promise((r) => setTimeout(r, 10));
    await port.open({ baudRate: this.TOUCH_BAUD });

    // Step 4: SET_CONTROL_LINE_STATE = DTR=0, RTS=1 (0x0002) - triggers reset
    this.log.signal("DTR", false, "DTR LOW triggers reset");
    this.log.signal("RTS", true, "RTS stays HIGH");
    await this.setSignalsSafe(port, {
      dataTerminalReady: false,
      requestToSend: true,
    });

    // Hold DTR LOW with the port still open (critical for nRF52 boards)
    const holdMs = Math.min(resetDelayMs, 550);
    this.log.wait(holdMs, "Hold DTR LOW with port open (critical for nRF52)");
    await new Promise((r) => setTimeout(r, holdMs));

    // Release both control lines before closing
    this.log.signal("DTR", false, "Both control lines LOW (release)");
    this.log.signal("RTS", false, "Release complete");
    await this.setSignalsSafe(port, {
      dataTerminalReady: false,
      requestToSend: false,
    });

    this.log.info("Closing port after touch sequence");
    await port.close();

    // Wait out the remainder of the reset budget
    const settleMs = Math.max(resetDelayMs - holdMs, 500);
    this.log.wait(
      settleMs,
      "Wait for device to reset and enter SAM-BA bootloader",
    );
    await new Promise((r) => setTimeout(r, settleMs));

    this.log.success(
      "1200 baud touch complete - device should be in bootloader mode",
    );
  }

  /**
   * After the 1200 touch some boards re-enumerate as a different
   * SerialPort. Watch the granted ports for one matching the bootloader
   * PID (or any PID change) and hand it back for flashing.
   * @returns {Promise<SerialPort>} The bootloader port (or the original)
   */
  async waitForBootloaderPort(
    port,
    { vid, originalPid, bootloaderPids = [], timeoutMs = 5000 },
  ) {
    if (!navigator?.serial?.getPorts) {
      this.log.warn(
        "navigator.serial.getPorts unavailable - continuing with existing port",
      );
      return port;
    }

    const deadline = Date.now() + timeoutMs;
    const pollMs = 250;
    let announced = false;

    while (Date.now() < deadline) {
      const candidate = (await navigator.serial.getPorts()).find((p) => {
        const info = p.getInfo();
        if (vid && info.usbVendorId && info.usbVendorId !== vid) return false;
        if (bootloaderPids.length > 0 && info.usbProductId) {
          return bootloaderPids.includes(info.usbProductId);
        }
        if (info.usbProductId && originalPid) {
          return info.usbProductId !== originalPid;
        }
        return false;
      });

      if (candidate) {
        if (candidate !== port) {
          this.log.success(
            "Detected bootloader port via Web Serial enumeration",
          );
          await this.safeClose(candidate);
          return candidate;
        }
        return port;
      }

      if (!announced) {
        this.log.info("Waiting for bootloader port to appear...");
        announced = true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    this.log.warn("Bootloader port not detected automatically before timeout");
    return port;
  }

  /**
   * Fast baud rate probe - returns immediately on ASCII data, or when enough
   * data received to determine it's garbage (wrong baud)
   *
   * @returns { result: 'ascii'|'garbage'|'timeout', bossa?, bytes? }
   */
  async fastProbe(port, baudRate, timeoutMs = 2000) {
    this.log.info(`Probing at ${baudRate} baud (${timeoutMs}ms timeout)...`);

    try {
      await this.safeClose(port);
      await port.open({ baudRate: baudRate });
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      await new Promise((r) => setTimeout(r, 50));

      const bossa = new BossaProtocol(port);
      await bossa.connect();

      // Send N# to trigger response
      this.log.command(
        "N#",
        "Query bootloader - expects ASCII response if correct baud rate",
      );
      await bossa.writeCommand("N#");

      // Wait for data with early exit
      const collected = [];
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - startTime);
        const waitTime = Math.min(remaining, 30);

        const readResult = await bossa.readChunk(waitTime);

        if (readResult.timedOut) {
          // Check if we have enough data to decide
          if (collected.length >= 3) {
            const isAscii = this.isValidAsciiResponse(
              new Uint8Array(collected),
            );
            if (isAscii) {
              this.log.success(`ASCII data detected at ${baudRate} baud!`);
              return {
                result: "ascii",
                bossa,
                bytes: new Uint8Array(collected),
              };
            } else {
              this.log.warn(`Garbage data at ${baudRate} - wrong baud rate`);
              await bossa.disconnect();
              await this.safeClose(port);
              return { result: "garbage", bytes: new Uint8Array(collected) };
            }
          }
          continue;
        }

        const { value, done } = readResult;
        if (done) break;

        if (value && value.length) {
          // Log received data
          this.log.rx(
            `Probe response (${value.length} bytes)`,
            value,
            `Testing if data is valid ASCII at ${baudRate} baud`,
          );

          collected.push(...value);

          // As soon as we have enough bytes, check if ASCII
          if (collected.length >= 2) {
            const isAscii = this.isValidAsciiResponse(
              new Uint8Array(collected),
            );
            if (isAscii) {
              // ASCII! This is the right baud rate - return immediately
              this.log.success(
                `ASCII data confirmed at ${baudRate} baud (${collected.length} bytes)`,
              );
              return {
                result: "ascii",
                bossa,
                bytes: new Uint8Array(collected),
              };
            } else if (collected.length >= 4) {
              // Got enough garbage data - wrong baud rate, exit early
              this.log.warn(
                `Garbage data at ${baudRate} - wrong baud rate (${collected.length} bytes)`,
              );
              await bossa.disconnect();
              await this.safeClose(port);
              return { result: "garbage", bytes: new Uint8Array(collected) };
            }
          }
        }
      }

      // Timeout with no data
      if (collected.length === 0) {
        this.log.warn(`No response at ${baudRate} baud (timeout)`);
        await bossa.disconnect();
        await this.safeClose(port);
        return { result: "timeout" };
      }

      // Had some data but not enough to decide - check what we got
      const isAscii = this.isValidAsciiResponse(new Uint8Array(collected));
      if (isAscii) {
        return { result: "ascii", bossa, bytes: new Uint8Array(collected) };
      } else {
        await bossa.disconnect();
        await this.safeClose(port);
        return { result: "garbage", bytes: new Uint8Array(collected) };
      }
    } catch (e) {
      this.log.error(`Error probing at ${baudRate}`, e);
      await this.safeClose(port);
      return { result: "timeout" };
    }
  }

  /**
   * Complete handshake after successful probe
   */
  async completeHandshake(bossa, baudRate) {
    try {
      // Reconnect reader (drops any in-flight read safely)
      bossa.reattachReader();

      // Send V# to get version
      this.log.command("V#", "Request bootloader version string");
      await bossa.writeCommand("V#");

      const collected = [];
      const startTime = Date.now();

      while (Date.now() - startTime < 1000) {
        const result = await bossa.readChunk(50);

        if (result.timedOut) {
          if (collected.length > 0) break;
          continue;
        }

        const { value, done } = result;
        if (done) break;
        if (value && value.length) {
          collected.push(...value);
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      if (collected.length > 0) {
        const version = Array.from(collected)
          .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ""))
          .join("")
          .trim();
        this.log.success(`Bootloader version: ${version}`);
        return { success: true, version };
      }

      this.log.info(`Connected at ${baudRate} baud (no version string)`);
      return { success: true, version: `Connected at ${baudRate}` };
    } catch (e) {
      this.log.warn(`Handshake warning: ${e.message}`);
      return { success: true, version: `Connected at ${baudRate}` };
    }
  }

  /**
   * Check if response bytes look like valid ASCII text
   * Valid responses should have mostly printable ASCII characters
   */
  isValidAsciiResponse(bytes) {
    if (!bytes || bytes.length === 0) return false;

    let printableCount = 0;
    for (const b of bytes) {
      // Printable ASCII (space to ~) plus common control chars (CR, LF)
      if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d) {
        printableCount++;
      }
    }

    // At least 70% should be printable ASCII for it to be valid
    const ratio = printableCount / bytes.length;
    return ratio >= 0.7;
  }

  /**
   * Ultra-fast baud rate detection:
   * 1. Try PRIMARY_BAUD (115200) for up to 2 seconds
   *    - If ASCII data received -> return immediately (success!)
   *    - If garbage data received -> try all baud rates with short timeouts
   *    - If no data after 2 seconds -> return (needs manual reset)
   * 2. When trying all baud rates, only wait long enough to get data and decide
   */
  async fastBaudProbe(port) {
    this.log.section("BAUD RATE DETECTION");
    this.log.info(`Primary baud rate: ${this.PRIMARY_BAUD}`);
    this.log.info("Will probe for valid ASCII response from bootloader");

    // Step 1: Try primary baud (115200) with full timeout
    const primaryResult = await this.fastProbe(port, this.PRIMARY_BAUD, 2000);

    if (primaryResult.result === "ascii") {
      // Success! Complete handshake and return
      await this.completeHandshake(primaryResult.bossa, this.PRIMARY_BAUD);
      return {
        success: true,
        bossa: primaryResult.bossa,
        baudRate: this.PRIMARY_BAUD,
      };
    }

    if (primaryResult.result === "timeout") {
      // No response at all - device probably not in bootloader mode
      this.log.warn(
        "No response at primary baud - device may need manual reset",
      );
      return { success: false, needsManualReset: true, reason: "no_response" };
    }

    // Got garbage - device is responding but at different baud rate
    this.log.info("Got response but wrong baud rate - scanning all rates...");

    // Step 2: Try all baud rates with short timeouts (just need enough data to decide)
    for (const baudRate of this.ALL_BAUD_RATES) {
      if (baudRate === this.PRIMARY_BAUD) continue; // Already tried

      // Short timeout since we just need enough data to determine ASCII vs garbage
      const result = await this.fastProbe(port, baudRate, 500);

      if (result.result === "ascii") {
        // Found it!
        await this.completeHandshake(result.bossa, baudRate);
        return { success: true, bossa: result.bossa, baudRate };
      }

      // If timeout at this rate, continue to next (no data = not this rate)
      // If garbage, continue to next rate
    }

    // None worked
    this.log.error("No baud rate produced valid ASCII response");
    return { success: false, needsManualReset: false, reason: "no_valid_baud" };
  }

  /**
   * Wait for any data from the protocol's serial stream
   * Returns { gotData, bytes, hex, ascii }
   */
  async waitForAnyData(bossa, timeoutMs) {
    const collected = [];
    const startTime = Date.now();
    this.log.info(`Waiting for data (${timeoutMs}ms timeout)...`);

    try {
      while (Date.now() - startTime < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - startTime);
        const waitTime = Math.min(remaining, 50);

        const result = await bossa.readChunk(waitTime);

        if (result.timedOut) {
          // If we already have some data, return it
          if (collected.length > 0) {
            break;
          }
          continue;
        }

        const { value, done } = result;
        if (done) break;

        if (value && value.length) {
          this.log.rx(`Data received (${value.length} bytes)`, value);
          collected.push(...value);
          // Got some data, wait a bit more for complete response
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } catch (e) {
      this.log.warn(`Read error: ${e.message}`);
    }

    const elapsed = Date.now() - startTime;
    if (collected.length > 0) {
      const bytes = new Uint8Array(collected);
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const ascii = Array.from(bytes)
        .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
        .join("");
      this.log.success(`Received ${collected.length} bytes in ${elapsed}ms`);
      return { gotData: true, bytes, hex, ascii };
    }

    this.log.warn(`No data received after ${elapsed}ms`);
    return { gotData: false };
  }

  /**
   * Alias for waitForAnyData
   */
  async waitForResponse(bossa, timeoutMs) {
    return this.waitForAnyData(bossa, timeoutMs);
  }

  async prepare(port, fqbn) {
    this.log.section("PREPARE: Bootloader Entry for BOSSA/SAM-BA");

    const info = port.getInfo();
    const pid = info.usbProductId;
    const vid = info.usbVendorId;

    // Select the board-specific configuration (baud plan, PIDs, timing)
    const boardConfig = getProtocolConfig(fqbn) || this.config;
    this.setActiveConfig(boardConfig);
    const bootloaderPids =
      boardConfig.bootloaderPids || this.config.bootloaderPids || [];
    const resetDelayMs =
      boardConfig.timing?.resetDelayMs || this.config.timing?.resetDelayMs;

    this.log.device(vid, pid, "Checking if device is in bootloader mode");

    // Check if already in bootloader mode (different PID)
    if (pid && bootloaderPids.includes(pid)) {
      this.log.success("Device already in bootloader mode (detected by PID)");
      this.log.info(
        `Bootloader PID: 0x${pid.toString(16)} is a known bootloader PID`,
      );
      return port;
    }

    // nRF52 boards keep the same PID in bootloader mode - probe for a
    // manual (double-tap) entry before disturbing the device
    if (
      bootloaderPids.length === 0 &&
      this.activeConfig?.variant === "nrf52" &&
      (await this.probeBootloaderWithoutReset(port))
    ) {
      this.log.info(
        "Skipping 1200 baud touch - manual bootloader entry detected",
      );
      return port;
    }

    this.log.info("Device not in bootloader mode - performing 1200 baud touch");
    await this.perform1200Touch(port, resetDelayMs || 500);

    // The device may re-enumerate as a new port in bootloader mode
    const activePort = await this.waitForBootloaderPort(port, {
      vid,
      originalPid: pid,
      bootloaderPids,
      timeoutMs: resetDelayMs || 2500,
    });

    // SAMD boards re-enumerate as a brand-new USB device (different PID)
    // that the browser has NO Web Serial permission for yet, so the granted
    // port poll above cannot find it. If the original app-mode port is now
    // disconnected, continuing with it is guaranteed to fail - hand off to
    // the UI's bootloader port chooser instead (1.1.1 behaviour).
    if (
      activePort === port &&
      bootloaderPids.length > 0 &&
      port.connected === false
    ) {
      const error = new Error(
        "The board reset into its bootloader, which appears as a new USB device.",
      );
      error.code = "BOOTLOADER_PORT_NEEDED";
      throw error;
    }
    return activePort;
  }

  async flash(port, data, progressCallback, fqbn) {
    const variant =
      this.activeConfig?.variant || this.config?.variant || "sam-ba";
    this.log.section(
      `FLASH: Uploading Firmware via SAM-BA Protocol (${variant})`,
    );
    this.log.info(`Firmware size: ${UploadLogger.formatSize(data.byteLength)}`);
    this.log.info(`Board FQBN: ${fqbn || "unknown"}`);

    // Some cores emit Intel HEX (e.g. nRF52); bootloaders expect binary.
    const rawBytes = new Uint8Array(data);
    let firmwareBinary;
    let hexStartAddress = null;
    if (isIntelHex(rawBytes)) {
      this.log.info("Detected Intel HEX format - converting to binary...");
      try {
        const parsed = parseIntelHex(rawBytes);
        firmwareBinary = parsed.data;
        hexStartAddress = parsed.startAddress;
        this.log.info(
          `Converted to binary: ${UploadLogger.formatSize(firmwareBinary.byteLength)}`,
        );
        this.log.info(
          `Start address from HEX: 0x${parsed.startAddress.toString(16)}`,
        );
      } catch (e) {
        this.log.error("Failed to parse Intel HEX", e);
        throw new Error(`Failed to parse Intel HEX: ${e.message}`);
      }
    } else {
      this.log.info("Data is already binary format");
      firmwareBinary = rawBytes;
    }

    let bossa = null;
    let workingBaud = null;

    // Try direct connection at PRIMARY_BAUD (230400 - confirmed from Wireshark)
    if (progressCallback)
      progressCallback(5, `Connecting at ${this.PRIMARY_BAUD} baud...`);

    try {
      await this.safeClose(port);

      // USB capture shows SET_LINE_CODING sent twice at 230400
      this.log.serialConfig(
        this.PRIMARY_BAUD,
        "Opening at primary baud (first SET_LINE_CODING)",
      );
      await port.open({ baudRate: this.PRIMARY_BAUD });
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });

      // Force second SET_LINE_CODING by closing and reopening
      this.log.info("Forcing second SET_LINE_CODING by close/reopen");
      await port.close();
      await new Promise((r) => setTimeout(r, 10));
      await port.open({ baudRate: this.PRIMARY_BAUD });
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });

      // Wait ~111ms before N# (matching USB capture)
      this.log.wait(110, "Match USB capture timing before sending N#");
      await new Promise((r) => setTimeout(r, 110));

      bossa = new BossaProtocol(port);
      await bossa.connect();

      // Send N# to verify bootloader is responding
      this.log.command(
        "N#",
        "Verify bootloader is responding (chip info query)",
      );
      await bossa.writeCommand("N#");

      // Wait for response
      const response = await this.waitForResponse(bossa, 2000);

      if (response.gotData && this.isValidAsciiResponse(response.bytes)) {
        workingBaud = this.PRIMARY_BAUD;
        this.log.success(`Connected to bootloader at ${workingBaud} baud`);
        this.log.info(`Response: ${response.ascii}`);
      } else {
        this.log.warn("No valid response at primary baud rate");
        await bossa.disconnect();
        await this.safeClose(port);
      }
    } catch (e) {
      this.log.error(`Error connecting at ${this.PRIMARY_BAUD}`, e);
      await this.safeClose(port);
    }

    // If primary baud failed, try all baud rates
    if (!workingBaud) {
      this.log.info("Primary baud failed - scanning all baud rates...");
      for (const baudRate of this.ALL_BAUD_RATES) {
        if (baudRate === this.PRIMARY_BAUD) continue;

        if (progressCallback) progressCallback(5, `Trying ${baudRate} baud...`);

        try {
          await this.safeClose(port);
          this.log.serialConfig(baudRate, `Testing alternate baud rate`);
          await port.open({ baudRate });
          await port.setSignals({
            dataTerminalReady: true,
            requestToSend: true,
          });
          await new Promise((r) => setTimeout(r, 100));

          bossa = new BossaProtocol(port);
          await bossa.connect();

          this.log.command("N#", "Query bootloader at this baud rate");
          await bossa.writeCommand("N#");
          const response = await this.waitForResponse(bossa, 1000);

          if (response.gotData && this.isValidAsciiResponse(response.bytes)) {
            workingBaud = baudRate;
            this.log.success(`Connected at ${workingBaud} baud`);
            break;
          } else {
            await bossa.disconnect();
            await this.safeClose(port);
          }
        } catch (e) {
          this.log.warn(`Error at ${baudRate}: ${e.message}`);
          await this.safeClose(port);
        }
      }
    }

    // If no baud rate worked, prompt user for manual reset
    if (!workingBaud) {
      this.log.section("MANUAL BOOTLOADER ENTRY REQUIRED");
      this.log.warn("Could not connect to bootloader at any baud rate");
      this.log.info("User needs to double-tap RESET button on Arduino");

      if (progressCallback) {
        progressCallback(
          0,
          "⚠️ Double-tap RESET button on Arduino, then click OK",
        );
      }

      const userConfirmed = await this.promptUserForBootloader();
      if (!userConfirmed) {
        throw new Error("Upload cancelled by user");
      }

      // Wait for board to enter bootloader and try again
      this.log.wait(1000, "Waiting for board to enter bootloader mode");
      await new Promise((r) => setTimeout(r, 1000));

      if (progressCallback)
        progressCallback(5, `Retrying at ${this.PRIMARY_BAUD}...`);

      try {
        await this.safeClose(port);
        await port.open({ baudRate: this.PRIMARY_BAUD });
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await new Promise((r) => setTimeout(r, 100));

        bossa = new BossaProtocol(port);
        await bossa.connect();

        this.log.command("N#", "Retry bootloader query after manual reset");
        await bossa.writeCommand("N#");
        const response = await this.waitForResponse(bossa, 2000);

        if (response.gotData && this.isValidAsciiResponse(response.bytes)) {
          workingBaud = this.PRIMARY_BAUD;
          this.log.success(
            `Connected after manual reset at ${workingBaud} baud`,
          );
        }
      } catch (e) {
        this.log.error("Error after manual reset", e);
      }
    }

    if (!workingBaud) {
      this.log.error("Failed to connect to bootloader at any baud rate");
      throw new Error(
        "Failed to connect to bootloader at any baud rate.\n\n" +
          "Please ensure:\n" +
          "1. Double-tap RESET quickly (LED should pulse/fade)\n" +
          "2. Click Upload within 8 seconds\n" +
          "3. The board is properly connected via USB\n\n" +
          "If the LED never pulses, try tapping RESET faster.",
      );
    }

    // Now flash the firmware
    try {
      if (progressCallback) progressCallback(10, `Connected at ${workingBaud}`);

      // Reconnect reader since we consumed it during probe (drops any
      // in-flight read safely)
      bossa.reattachReader();

      // Variant-driven flash memory layout (from the board protocol config):
      //
      // renesas-ra4m1 (R4 WiFi) - from Wireshark capture + bootloader source
      //   (arduino-renesas-bootloader/src/bossa.c):
      //   - S command: writes to internal data_buffer[8192], addr is OFFSET
      //     into the buffer
      //   - Y command: copies from data_buffer to flash at
      //     SKETCH_FLASH_OFFSET + addr (SKETCH_FLASH_OFFSET = 0x4000)
      //   - flash write is blocking; ACK "Y\n\r" arrives after commit
      //
      // nrf52 (Nano 33 BLE) - SAM-BA Extended with the same flash applet
      //   as the R4, but flash writes target the HEX start address (or the
      //   configured sketch offset) with 4KB pages.
      //
      // direct-write (useDirectFlashWrite) - standard BOSSA: S# writes go
      //   straight to flash, no Y# copy commands.
      //
      // default (SAMD21) - flash write at the configured sketch offset.
      const protocolConfig = getProtocolConfig(fqbn) || this.config;
      const variant = protocolConfig.variant || "default";
      const useDirectWrite = protocolConfig.useDirectFlashWrite || false;

      let flashWriteOffset = protocolConfig.memory?.sketchOffset || 0x2000;
      let goOffset = flashWriteOffset;
      let sramBuffer = 0x34;

      if (variant === "renesas-ra4m1") {
        flashWriteOffset = 0x0000; // Y command offset (bootloader adds 0x4000)
        goOffset = 0x4000; // User code entry point (absolute address)
        sramBuffer = 0x34; // Offset into bootloader's data_buffer[8192]
        this.log.info("Flash memory layout (Renesas RA4M1):");
        this.log.memory(
          "FLASH_WRITE",
          flashWriteOffset,
          0,
          `Y command offset (bootloader adds 0x4000 internally → physical 0x${(
            flashWriteOffset + 0x4000
          ).toString(16)})`,
        );
        this.log.info(
          `Execution entry point: ${UploadLogger.formatAddr(
            goOffset,
          )} (G command uses absolute address)`,
        );
        this.log.info(
          `Data buffer offset: ${UploadLogger.formatAddr(
            sramBuffer,
          )} (into bootloader's data_buffer[8192])`,
        );
      } else if (variant === "nrf52") {
        flashWriteOffset =
          typeof hexStartAddress === "number"
            ? hexStartAddress
            : protocolConfig.memory?.sketchOffset || 0x10000;
        goOffset = flashWriteOffset;
        this.log.info(`Flash memory layout (${variant}):`);
        this.log.memory(
          "FLASH_WRITE",
          0x34,
          0,
          `Buffer-based writes to 0x34, applet copies to flash @ 0x${flashWriteOffset.toString(16)}`,
        );
        this.log.info(
          `Flash size: ${(protocolConfig.memory?.flashSize || 0) / 1024}KB`,
        );
        if (typeof hexStartAddress === "number") {
          this.log.info(
            `Firmware start address: 0x${hexStartAddress.toString(16)}`,
          );
        }
        this.log.info(
          "Protocol: SAM-BA Extended with flash applet (same as R4)",
        );
      } else if (useDirectWrite) {
        flashWriteOffset =
          typeof hexStartAddress === "number"
            ? hexStartAddress
            : protocolConfig.memory?.sketchOffset || 0x10000;
        goOffset = flashWriteOffset;
        this.log.info("Flash memory layout (direct write):");
        this.log.memory(
          "FLASH_WRITE",
          flashWriteOffset,
          0,
          `Direct flash write at offset 0x${flashWriteOffset.toString(16)}`,
        );
        this.log.info(
          "Protocol: Standard BOSSA (direct S# writes, no Y# commands)",
        );
      } else {
        this.log.info(`Flash memory layout (${variant || "SAMD"}):`);
        this.log.memory(
          "FLASH_WRITE",
          flashWriteOffset,
          0,
          `Flash write offset 0x${flashWriteOffset.toString(16)}`,
        );
      }

      // Get chunk size from config (used for both padding and writing)
      const chunkSize =
        protocolConfig.memory?.chunkSize || this.config.memory.chunkSize;

      // Pad firmware to chunk size boundary to ensure complete flash pages
      // The bootloader may have issues with partial page writes
      const originalSize = firmwareBinary.byteLength;
      const paddedSize = Math.ceil(originalSize / chunkSize) * chunkSize;
      const firmware = new Uint8Array(paddedSize);
      firmware.set(firmwareBinary, 0);
      // Fill padding with 0xFF (erased flash state)
      firmware.fill(0xff, originalSize);
      const totalBytes = firmware.length;
      this.log.info(
        `Firmware: ${originalSize} bytes → padded to ${totalBytes} bytes (${chunkSize}-byte boundary)`,
      );

      // Step 1: Upload flash applet (matches Arduino IDE protocol from Wireshark)
      // The IDE uploads a 52-byte applet to data_buffer[0] before writing firmware
      // This applet is ARM Thumb code used for flash operations.
      // Used by both the R4 (renesas-ra4m1) and Nano 33 BLE (nrf52) variants.
      if (variant === "renesas-ra4m1" || variant === "nrf52") {
        this.log.section("FLASH APPLET UPLOAD");
        this.log.info(
          "Uploading 52-byte ARM Thumb flash applet to data_buffer[0]",
        );
        this.log.info("This applet assists with flash write operations");
        if (progressCallback) progressCallback(10, "Uploading flash applet...");

        // Flash applet extracted from Arduino IDE Wireshark capture (R4.pcapng)
        // S00000000,00000034# followed by 52 bytes of ARM Thumb code
        const FLASH_APPLET = new Uint8Array([
          0x09,
          0x48,
          0x0a,
          0x49,
          0x0a,
          0x4a,
          0x02,
          0xe0,
          0x08,
          0xc9,
          0x08,
          0xc0,
          0x01,
          0x3a,
          0x00,
          0x2a,
          0xfa,
          0xd1,
          0x04,
          0x48,
          0x00,
          0x28,
          0x01,
          0xd1,
          0x01,
          0x48,
          0x85,
          0x46,
          0x70,
          0x47,
          0xc0,
          0x46,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00, // 52 bytes total
        ]);
        this.log.command(
          "S00000000,00000034#",
          "Write 52 bytes to data_buffer[0x00] (flash applet)",
        );
        await bossa.writeBinary(0x00, FLASH_APPLET);
        this.log.success("Flash applet uploaded");

        // W# register commands from Arduino IDE (flash configuration)
        this.log.info("Configuring flash registers via W# commands");
        this.log.command(
          "W00000030,00000400#",
          "Write 0x400 to register at 0x30 (flash config)",
        );
        await bossa.writeWord(0x30, 0x400);
        this.log.command(
          "W00000020,00000000#",
          "Write 0x00 to register at 0x20 (flash config)",
        );
        await bossa.writeWord(0x20, 0x00);
        this.log.success("Flash registers configured");
      }

      // Step 2: Erase flash
      this.log.section("FLASH ERASE");
      if (progressCallback) progressCallback(12, "Erasing flash...");

      const isSamdVariant = variant !== "renesas-ra4m1" && variant !== "nrf52";

      // SAMD only: query bootloader version + capability flags before the
      // erase (mirrors bossac, which only sends X# when the version string
      // advertises it via "[Arduino:XYZ]"). Old SAM-BA bootloaders silently
      // ignore X#, which otherwise looks identical to an erase timeout.
      let samdCaps = null;
      if (isSamdVariant) {
        try {
          this.log.command(
            "V#",
            "Query bootloader version + [Arduino:XYZ] capability flags",
          );
          await bossa.writeCommand("V#");
          const vBytes = await bossa.readUntilTerminator({
            timeout: 2000,
            maxBytes: 256,
          });
          const vStr = bossa.bytesToPrintable(vBytes);
          this.log.info(`Bootloader version: ${vStr || "<unreadable>"}`);
          const capsMatch = vStr.match(/\[Arduino:([A-Z]+)\]/);
          if (capsMatch) {
            samdCaps = capsMatch[1];
            this.log.info(
              `Capabilities: ${samdCaps} (X=chip-erase, Y=buffer-write, Z=checksum)`,
            );
          } else {
            this.log.warn(
              "No [Arduino:XYZ] capability flags in version string - old bootloader; X# chip erase may be ignored",
            );
          }
        } catch (e) {
          this.log.warn(
            "V# version query failed - proceeding without capability info",
          );
        }
      }

      // Page size differs per family (nRF52: 4KB, Renesas: 8KB)
      const erasePageSize = variant === "nrf52" ? 0x1000 : 0x2000;
      const eraseAddr = isSamdVariant ? flashWriteOffset : 0;
      const pagesToErase = Math.ceil(totalBytes / erasePageSize);
      this.log.memory(
        "ERASE",
        eraseAddr,
        totalBytes,
        `Erase ${pagesToErase} pages (${erasePageSize} bytes per page)`,
      );

      if (isSamdVariant && samdCaps !== null && !samdCaps.includes("X")) {
        // Bootloader explicitly reports no X support - skip the wait; the
        // secure SAM-BA bootloader auto-erases on the first flash write.
        this.log.warn(
          "Bootloader does not advertise X (chip erase) - skipping; bootloader erases on first write",
        );
      } else if (isSamdVariant) {
        // SAMD X# erases 0x2000..end-of-flash row-by-row (992 rows on a
        // 256KB SAMD21) in a blocking busy-loop with USB completely
        // unserviced (sam_ba_monitor.c). At worst-case row-erase times this
        // exceeds 10s, and the board is DEAF until it finishes - commands
        // sent early just stall. Wait up to 30s for the X\n\r ACK.
        this.log.info(
          "Waiting for chip erase - the bootloader is blocked and cannot respond until the full flash is erased (typically 3-15s)",
        );
        const eraseAcknowledged = await bossa.chipErase(eraseAddr, 30000);
        if (eraseAcknowledged) {
          this.log.success("Flash erased successfully");
        } else {
          this.log.warn(
            "No X# ACK after 30s - continuing anyway (matches bossac/1.1.1 behavior; bootloader may auto-erase on write)",
          );
          // Discard a late X\n\r ACK so it can't corrupt later ACK reads
          await bossa.flush(300);
        }
      } else {
        // R4 / nRF52: applet-based bootloaders ACK quickly; a missing ACK is
        // a real failure - abort before flash write to avoid a freeze.
        const eraseAcknowledged = await bossa.chipErase(eraseAddr);
        if (!eraseAcknowledged) {
          throw new Error(
            "Bootloader did not acknowledge chip erase (X#). Upload stopped before flash write to avoid freeze.",
          );
        }
        this.log.success("Flash erased successfully");
      }

      // Step 3: Write flash in chunks (variant-specific write flow)
      this.log.section("FLASH WRITE");
      const numChunks = Math.ceil(totalBytes / chunkSize);
      this.log.info(
        `Writing ${totalBytes} bytes in ${numChunks} chunks of ${chunkSize} bytes`,
      );
      this.log.info(`Protocol variant: ${variant}`);
      if (progressCallback) progressCallback(15, "Writing flash...");

      if (variant === "renesas-ra4m1") {
        // R4: S# into data_buffer, then Y#/Y# buffered copy to flash.
        // The bootloader adds 0x4000 to the Y command flash offset.
        let flashAddr = flashWriteOffset;
        for (let i = 0; i < totalBytes; i += chunkSize) {
          const chunkNum = Math.floor(i / chunkSize) + 1;
          const chunk = firmware.subarray(
            i,
            Math.min(i + chunkSize, totalBytes),
          );
          const isLastChunk = i + chunkSize >= totalBytes;

          const sramHex = sramBuffer.toString(16).padStart(8, "0");
          const chunkHex = chunk.length.toString(16).padStart(8, "0");
          const flashHex = flashAddr.toString(16).padStart(8, "0");
          const physicalHex = (flashAddr + 0x4000)
            .toString(16)
            .padStart(8, "0");

          this.log.chunk(
            chunkNum,
            numChunks,
            flashAddr + 0x4000,
            chunk.length,
            isLastChunk,
          );
          this.log.command(
            `S${sramHex},${chunkHex}#`,
            `Write ${chunk.length} bytes into bootloader data_buffer[0x${sramHex}]`,
          );
          await bossa.writeBinary(sramBuffer, chunk);
          this.log.command(
            `Y${sramHex},00000000#`,
            "Set copy offset from data_buffer (bootloader uses this as source)",
          );
          this.log.command(
            `Y${flashHex},${chunkHex}#`,
            `Copy ${chunk.length} bytes from data_buffer to flash @ 0x${physicalHex}`,
          );
          await bossa.writeBuffer(sramBuffer, flashAddr, chunk.length);
          flashAddr += chunk.length;

          const percent = 15 + Math.round((i / totalBytes) * 80);
          if (progressCallback)
            progressCallback(percent, `Chunk ${chunkNum}/${numChunks}`);

          // Delay between chunks - Wireshark shows 238-261ms between 4KB
          // chunks; allows the flash controller to commit each page
          if (isLastChunk) {
            this.log.wait(1000, "Final chunk - extended wait for flash commit");
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            this.log.wait(250, "Inter-chunk delay for flash page commit");
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } else if (variant === "nrf52") {
        // Nano 33 BLE: buffered writes via SRAM buffer @ 0x34; the applet
        // copies to flash at relative offsets from the firmware start.
        let relativeAddr = 0;
        for (let i = 0; i < totalBytes; i += chunkSize) {
          const chunkNum = Math.floor(i / chunkSize) + 1;
          const chunk = firmware.subarray(
            i,
            Math.min(i + chunkSize, totalBytes),
          );
          const isLastChunk = i + chunkSize >= totalBytes;

          const sramHex = "34".padStart(8, "0");
          const chunkHex = chunk.length.toString(16).padStart(8, "0");
          const relativeHex = relativeAddr.toString(16).padStart(8, "0");
          const physicalAddr = flashWriteOffset + relativeAddr;

          this.log.chunk(
            chunkNum,
            numChunks,
            physicalAddr,
            chunk.length,
            isLastChunk,
          );
          this.log.command(
            `S${sramHex},${chunkHex}#`,
            `Write ${chunk.length} bytes to SRAM buffer @ 0x${sramHex}`,
          );
          await bossa.writeBinary(0x34, chunk);
          this.log.command(
            `Y${sramHex},0#`,
            "Set source pointer to buffer offset 0x34",
          );
          this.log.command(
            `Y${relativeHex},${chunkHex}#`,
            `Copy ${chunk.length} bytes to flash @ relative 0x${relativeHex} (real 0x${physicalAddr.toString(16)})`,
          );
          await bossa.writeBuffer(0x34, relativeAddr, chunk.length);
          relativeAddr += chunk.length;

          const percent = 15 + Math.round((i / totalBytes) * 80);
          if (progressCallback)
            progressCallback(percent, `Chunk ${chunkNum}/${numChunks}`);

          if (isLastChunk) {
            this.log.wait(500, "Final chunk - wait for flash commit");
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            this.log.wait(100, "Inter-chunk delay for applet flash write");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      } else {
        // SAMD21 / standard BOSSA: bossac-faithful buffered writes.
        // The bootloader's S handler is a raw memcpy intended for RAM
        // addresses (sam_ba_monitor.c) - direct S# writes to a flash address
        // bypass the NVM controller sequencing. bossac (D2xNvmFlash) instead
        // writes each chunk to an SRAM buffer (0x20004000), then issues
        // Y<sram>,0# + Y<flash>,<size># - the Y handler performs the proper
        // PBC -> fill page buffer -> WP -> wait-READY sequence per 64-byte
        // page and only ACKs after the data is committed.
        const SRAM_BUFFER = 0x20004000;
        this.log.info(
          `Buffered write via SRAM @ 0x${SRAM_BUFFER.toString(16)} (bossac D2xNvmFlash flow)`,
        );
        let flashAddr = flashWriteOffset;
        for (let i = 0; i < totalBytes; i += chunkSize) {
          const chunkNum = Math.floor(i / chunkSize) + 1;
          const chunk = firmware.subarray(
            i,
            Math.min(i + chunkSize, totalBytes),
          );
          const isLastChunk = i + chunkSize >= totalBytes;

          const sramHex = SRAM_BUFFER.toString(16).padStart(8, "0");
          const flashHex = flashAddr.toString(16).padStart(8, "0");
          const chunkHex = chunk.length.toString(16).padStart(8, "0");

          this.log.chunk(
            chunkNum,
            numChunks,
            flashAddr,
            chunk.length,
            isLastChunk,
          );
          await bossa.writeBinary(SRAM_BUFFER, chunk);
          this.log.command(
            `Y${sramHex},0# / Y${flashHex},${chunkHex}#`,
            `Commit ${chunk.length} bytes from SRAM to flash @ 0x${flashHex}`,
          );
          await bossa.writeBuffer(SRAM_BUFFER, flashAddr, chunk.length);
          flashAddr += chunk.length;

          const percent = 15 + Math.round((i / totalBytes) * 80);
          if (progressCallback)
            progressCallback(percent, `Chunk ${chunkNum}/${numChunks}`);

          if (isLastChunk) {
            this.log.wait(500, "Final chunk - wait for flash commit");
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            this.log.wait(50, "Inter-chunk delay");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }

      // Wait for flash operations to fully complete before reset.
      // Applet-based variants (R4/nRF52) need longer for the final commit;
      // the Y# ACK only means data was received, not committed.
      const waitTime =
        variant === "renesas-ra4m1" || variant === "nrf52" ? 5000 : 2000;
      this.log.section("FLASH COMMIT");
      this.log.wait(
        waitTime,
        `Final flash commit wait (${numChunks} chunks, ${totalBytes} bytes)`,
      );
      if (variant === "renesas-ra4m1" || variant === "nrf52") {
        this.log.info(
          "Applet-based write - waiting for flash commit to complete",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waitTime));

      // Verify bootloader is still responsive by sending N# before reset.
      // Skipped on nRF52 - its bootloader often resets immediately.
      if (variant === "nrf52") {
        this.log.info(
          "Skipping post-flash handshake for nRF52 (bootloader often resets immediately)",
        );
      } else {
        this.log.info("Verifying bootloader is still responsive...");
        try {
          await bossa.hello();
          this.log.success("Bootloader still responsive after flash write");
        } catch (e) {
          this.log.warn(
            "Bootloader unresponsive after write - proceeding with reset",
          );
        }
      }

      if (progressCallback) progressCallback(96, "Finalizing...");

      this.log.section("RESET DEVICE");
      if (progressCallback) progressCallback(98, "Resetting...");

      if (isSamdVariant) {
        // Old SAMD bootloaders (e.g. v2.0 2018, ArduinoCore-samd 1.6.18)
        // have NO K# command at all - it is silently ignored and the board
        // stays in the bootloader forever. bossac resets these boards with a
        // W# word write of SYSRESETREQ to the Cortex-M AIRCR register.
        this.log.command(
          "WE000ED0C,05FA0004#",
          "Write SCB->AIRCR = VECTKEY|SYSRESETREQ - immediate system reset (bossac-style, works on all SAMD bootloaders)",
        );
        try {
          await bossa.writeWord(0xe000ed0c, 0x05fa0004);
        } catch (e) {
          this.log.info("Port dropped during reset write (board resetting)");
        }
      } else {
        // Use K# command (system reset) instead of G# (jump) - this is what
        // Arduino IDE uses; the bootloader validates and boots user code.
        // nRF52 boards drop off USB immediately without ACKing - reset()
        // treats that as the expected success outcome.
        this.log.info("Sending K# reset command to boot new firmware");
        await bossa.reset();
      }

      if (progressCallback) progressCallback(100, "Complete!");
      this.log.success("Firmware upload complete!");
      this.log.info("Device should now be running the new firmware");
    } finally {
      if (bossa) {
        try {
          await bossa.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
      await this.safeClose(port);
    }
  }

  async promptUserForBootloader() {
    return new Promise((resolve) => {
      const message =
        "🔴 MANUAL RESET REQUIRED 🔴\n\n" +
        "Web Serial cannot automatically enter bootloader mode.\n\n" +
        "Please do this NOW:\n" +
        "1. Find the RESET button on your Arduino\n" +
        "2. Double-tap it QUICKLY (like double-clicking a mouse)\n" +
        "3. The built-in LED should start pulsing/fading\n" +
        "4. Click OK within 8 seconds\n\n" +
        "Click OK when the LED is pulsing, or Cancel to abort.";

      const result = window.confirm(message);
      resolve(result);
    });
  }
}
