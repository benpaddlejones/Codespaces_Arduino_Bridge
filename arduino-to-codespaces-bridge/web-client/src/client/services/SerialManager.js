/**
 * Serial Manager Service
 *
 * Manages serial communication with Arduino devices:
 * - Connect/disconnect via WebSerial API
 * - Data buffering and line parsing
 * - Baud rate detection/scanning
 * - Pause/resume for upload operations
 *
 * @module client/services/SerialManager
 */

import { WebSerialProvider } from "../providers/WebSerialProvider.js";

// =============================================================================
// Constants
// =============================================================================

/** Common baud rates to scan, ordered by prevalence in Arduino projects */
const COMMON_BAUD_RATES = [
  115200, 9600, 57600, 38400, 19200, 74880, 230400, 250000,
];

/** Minimum percentage of printable ASCII characters for valid data detection */
const ASCII_THRESHOLD = 0.8;

/** Delay in ms between baud rate scan attempts */
const BAUD_DETECT_DELAY_MS = 500;

/** Minimum bytes needed to determine if data is valid ASCII */
const MIN_BYTES_FOR_DETECTION = 5;

/**
 * Maximum characters held while waiting for a newline. A sketch that never
 * emits \n would otherwise grow this string until the tab runs out of memory.
 */
const MAX_LINE_BUFFER_CHARS = 65_536;

/** Sampling interval for the throughput meter */
const RATE_WINDOW_MS = 500;

/**
 * Sustained throughput above which output is stopped automatically. Set well
 * above 921600 baud (~92 KB/s) so ordinary high-speed logging never trips it.
 */
const FLOOD_BYTES_PER_SEC = 150_000;

/** Consecutive over-threshold samples required before auto-stopping */
const FLOOD_SAMPLES = 6;

// =============================================================================
// SerialManager Class
// =============================================================================

/**
 * Manages serial communication with Arduino devices
 */
export class SerialManager {
  constructor() {
    /** @type {WebSerialProvider} */
    this.provider = new WebSerialProvider();
    /** @type {string} */
    this.buffer = "";
    /** @type {boolean} */
    this.paused = false;
    /** @type {number} Nested pause depth; monitor is silent while > 0 */
    this.pauseDepth = 0;
    /** @type {boolean} User-requested stop; independent of pauseDepth so an
     * upload finishing cannot silently re-enable a stream the user stopped */
    this.userStopped = false;
    /** @type {boolean} */
    this.baudDetectionActive = false;
    /** @type {string} Raw chunk buffer used only during baud detection */
    this.detectionBuffer = "";
    /** @type {number} Bytes counted in the current rate window */
    this.rateBytes = 0;
    /** @type {number} Timestamp the current rate window opened */
    this.rateWindowStart = 0;
    /** @type {number} Most recent measured throughput in bytes/sec */
    this.bytesPerSecond = 0;
    /** @type {number} Consecutive samples above the flood threshold */
    this.floodSamples = 0;
    /** @type {{line: Function[], baudDetected: Function[], rate: Function[], flood: Function[]}} */
    this.listeners = {
      line: [],
      baudDetected: [],
      rate: [],
      flood: [],
    };

    this.provider.on("data", (chunk) => {
      this.handleData(chunk);
    });
  }

  /**
   * Connect to a serial port
   * @param {number} baudRate - Baud rate for connection
   * @param {SerialPort|null} port - Optional port to connect to
   * @returns {Promise<boolean>}
   */
  async connect(baudRate, port = null) {
    this.userStopped = false;
    this.floodSamples = 0;
    this.rateWindowStart = 0;
    this.rateBytes = 0;
    return await this.provider.connect(baudRate, port);
  }

  /**
   * Disconnect from the serial port
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.baudDetectionActive = false;
    return await this.provider.disconnect();
  }

  /**
   * Write data to the serial port
   * @param {string} data - Data to write
   * @returns {Promise<void>}
   */
  async write(data) {
    return await this.provider.write(data);
  }

  /**
   * Set control signals (DTR, RTS)
   * @param {object} signals - Signal states
   * @returns {Promise<void>}
   */
  async setSignals(signals) {
    return await this.provider.setSignals(signals);
  }

  /**
   * Pause serial data processing. Data is still received but not emitted.
   * Reference-counted so nested callers (e.g. a compile inside an upload)
   * each pause and resume without prematurely un-silencing the monitor.
   * Used during compile/upload to avoid garbled output in the terminal.
   */
  pause() {
    this.pauseDepth++;
    this.paused = true;
    this.buffer = "";
  }

  /**
   * Resume serial data processing after pause. Only resumes once every
   * matching pause() call has been balanced by a resume().
   */
  resume() {
    this.pauseDepth = Math.max(0, this.pauseDepth - 1);
    if (this.pauseDepth === 0) {
      this.paused = false;
    }
  }

  /**
   * Stop delivering serial output to the UI. The port stays open and is still
   * read, so the connection remains healthy; incoming data is discarded.
   */
  stopOutput() {
    this.userStopped = true;
    this.buffer = "";
  }

  /**
   * Resume delivering serial output after {@link stopOutput}.
   */
  resumeOutput() {
    this.userStopped = false;
    this.floodSamples = 0;
  }

  /**
   * Whether serial output is currently being withheld from the UI, for any
   * reason (user stop, auto-stop, or an in-progress compile/upload).
   * @returns {boolean}
   */
  isSilenced() {
    return this.paused || this.userStopped;
  }

  /**
   * Whether output is stopped by the user or the flood guard.
   * @returns {boolean}
   */
  isStopped() {
    return this.userStopped;
  }

  /**
   * Check if a string appears to be valid ASCII text (not garbled baud mismatch data).
   * @param {string} data - The string to check
   * @returns {boolean} - true if data looks like valid ASCII
   */
  isAsciiData(data) {
    if (!data || data.length === 0) return false;

    let printableCount = 0;
    let totalCount = 0;

    for (const char of data) {
      totalCount++;
      const code = char.charCodeAt(0);
      // Printable ASCII: 0x20-0x7E, plus newline (0x0A), carriage return (0x0D), tab (0x09)
      if (
        (code >= 0x20 && code <= 0x7e) ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09
      ) {
        printableCount++;
      }
    }

    return totalCount > 0 && printableCount / totalCount > ASCII_THRESHOLD;
  }

  /**
   * Start background baud rate detection. Will scan common baud rates
   * and emit 'baudDetected' when valid ASCII data is received.
   * @param {number} currentBaud - The current baud rate to start from
   * @param {function} onStatusUpdate - Optional callback for status updates
   * @returns {Promise<number|null>} - The detected baud rate, or null if detection failed
   */
  async startBaudDetection(currentBaud, onStatusUpdate = null) {
    if (this.baudDetectionActive) {
      return null; // Already detecting
    }

    this.baudDetectionActive = true;
    this.detectionBuffer = "";
    const startIndex = COMMON_BAUD_RATES.indexOf(currentBaud);
    const baudsToTry =
      startIndex >= 0
        ? [
            ...COMMON_BAUD_RATES.slice(startIndex + 1),
            ...COMMON_BAUD_RATES.slice(0, startIndex),
          ]
        : COMMON_BAUD_RATES;

    if (onStatusUpdate) {
      onStatusUpdate(`Baud detection: checking ${baudsToTry.length} rates...`);
    }

    for (const baud of baudsToTry) {
      if (!this.baudDetectionActive) {
        break; // Detection was cancelled
      }

      if (onStatusUpdate) {
        onStatusUpdate(`Trying ${baud} baud...`);
      }

      // Reopen port at new baud rate
      const success = await this.provider.reopenAtBaud(baud);
      if (!success) {
        continue;
      }

      // Wait briefly for data to arrive
      await new Promise((r) => setTimeout(r, BAUD_DETECT_DELAY_MS));

      // Check if we received valid ASCII data
      if (
        this.detectionBuffer.length >= MIN_BYTES_FOR_DETECTION &&
        this.isAsciiData(this.detectionBuffer)
      ) {
        this.baudDetectionActive = false;
        this.emit("baudDetected", baud);
        this.detectionBuffer = "";
        return baud;
      }

      // Clear buffer for next attempt
      this.buffer = "";
      this.detectionBuffer = "";
    }

    this.baudDetectionActive = false;
    this.detectionBuffer = "";
    return null;
  }

  /**
   * Cancel any active baud detection scan.
   */
  cancelBaudDetection() {
    this.baudDetectionActive = false;
  }

  handleData(chunk) {
    // Metered before any early return so the throughput readout stays live
    // while output is stopped - that is how the user knows when to resume.
    this.meter(chunk.length);

    if (this.paused || this.userStopped) {
      return;
    }

    if (this.baudDetectionActive) {
      this.detectionBuffer += chunk;
      if (this.detectionBuffer.length > 4096) {
        this.detectionBuffer = this.detectionBuffer.slice(-4096);
      }
    }

    this.buffer += chunk;

    let start = 0;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      this.emit("line", this.buffer.slice(start, index));
      start = index + 1;
      index = this.buffer.indexOf("\n", start);
    }
    this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;

    // A sketch emitting no newlines would otherwise buffer forever.
    if (this.buffer.length > MAX_LINE_BUFFER_CHARS) {
      this.emit("line", this.buffer);
      this.buffer = "";
    }
  }

  /**
   * Sample throughput and auto-stop output if the device floods the tab
   * faster than it can be rendered.
   * @param {number} byteCount - Bytes received in this chunk
   * @private
   */
  meter(byteCount) {
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.rateWindowStart === 0) {
      this.rateWindowStart = now;
    }

    this.rateBytes += byteCount;
    const elapsed = now - this.rateWindowStart;
    if (elapsed < RATE_WINDOW_MS) return;

    this.bytesPerSecond = Math.round((this.rateBytes * 1000) / elapsed);
    this.rateBytes = 0;
    this.rateWindowStart = now;
    this.emit("rate", this.bytesPerSecond);

    if (this.userStopped) return;

    if (this.bytesPerSecond >= FLOOD_BYTES_PER_SEC) {
      this.floodSamples++;
      if (this.floodSamples >= FLOOD_SAMPLES) {
        this.stopOutput();
        this.floodSamples = 0;
        this.emit("flood", this.bytesPerSecond);
      }
    } else {
      this.floodSamples = 0;
    }
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((callback) => callback(data));
    }
  }
}
