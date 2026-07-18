/**
 * WebSerial Provider
 *
 * Provides low-level WebSerial API abstraction:
 * - Serial port connection management
 * - Data reading/writing with proper locking
 * - Control signal management (DTR/RTS)
 * - Event-based data streaming
 * - Timeout guards and auto-reconnection
 *
 * @module client/providers/WebSerialProvider
 * @version 1.0.1
 */

import { UploadLogger } from "../services/utils/UploadLogger.js";

// =============================================================================
// Constants
// =============================================================================

/** @constant {number} PORT_CLOSE_DELAY_MS - Delay after closing port before reopening */
const PORT_CLOSE_DELAY_MS = 100;

/** @constant {number} WRITE_TIMEOUT_MS - Timeout for write operations */
const WRITE_TIMEOUT_MS = 5000;

/** @constant {number} RECONNECT_DELAY_MS - Delay before reconnection attempts */
const RECONNECT_DELAY_MS = 2000;

/** @constant {number} MAX_RECONNECT_ATTEMPTS - Maximum number of reconnection attempts */
const MAX_RECONNECT_ATTEMPTS = 3;

// =============================================================================
// Module State
// =============================================================================

const serialLogger = new UploadLogger("Serial");

// =============================================================================
// WebSerialProvider Class
// =============================================================================

/**
 * WebSerial API provider for serial port communication
 */
export class WebSerialProvider {
  /**
   * Create a new WebSerialProvider instance
   */
  constructor() {
    /** @type {SerialPort|null} WebSerial port reference */
    this.port = null;

    /** @type {ReadableStreamDefaultReader|null} Active reader instance */
    this.reader = null;

    /** @type {WritableStreamDefaultWriter|null} Active writer instance */
    this.writer = null;

    /** @type {boolean} Whether read loop should continue */
    this.keepReading = false;

    /** @type {number} Last connected baud rate for reconnection */
    this.lastBaudRate = 9600;

    /** @type {boolean} Whether auto-reconnect is enabled */
    this.autoReconnect = true;

    /** @type {number} Current reconnection attempt count */
    this.reconnectAttempts = 0;

    /** @type {boolean} Guard against re-entrant/duplicate teardown */
    this.cleaningUp = false;

    /** @type {Object.<string, Function[]>} Event listener registry */
    this.listeners = {
      data: [],
      disconnect: [],
      reconnect: [],
      reconnect_failed: [],
      portConnected: [],
    };

    this.registerNavigatorEvents();
  }

  /**
   * Register navigator.serial connect/disconnect listeners as recommended
   * by the Web Serial API. "connect" fires when a granted device is
   * (re)attached - including a board returning from its bootloader - and
   * provides a live SerialPort object, which is more reliable than
   * re-opening a stale reference. "disconnect" gives positive confirmation
   * the device left (unplug or re-enumeration into another mode).
   */
  registerNavigatorEvents() {
    if (
      typeof navigator === "undefined" ||
      !navigator.serial ||
      typeof navigator.serial.addEventListener !== "function"
    ) {
      return;
    }
    navigator.serial.addEventListener("connect", (event) => {
      const info =
        typeof event.target.getInfo === "function"
          ? event.target.getInfo()
          : {};
      serialLogger.info("Serial device connected (navigator event)", info);
      this.emit("portConnected", event.target);
      // Adopt the returning device when we lost ours and adoption is on
      // (enabled by the recovery flow after reconnect retries fail).
      if (this.autoReconnect && !this.port && !this.cleaningUp) {
        serialLogger.info("Adopting newly connected port for reconnection");
        this.connect(this.lastBaudRate, event.target).catch((error) => {
          serialLogger.warn("Auto-adopt reconnect failed", error);
        });
      }
    });
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.target === this.port) {
        serialLogger.warn("Serial device disconnected (navigator event)");
        // The read loop notices the stream error as well; this is the
        // spec-level positive signal that the device is gone.
        this.emit("disconnect", { unexpected: true });
      }
    });
  }

  /**
   * Determine whether an error represents an expected loss of the serial
   * device (unplugged, reset, or port closed) rather than a genuine fault.
   * @param {unknown} error - Error to classify
   * @returns {boolean} True if the error indicates the device was lost
   */
  isDeviceLostError(error) {
    if (!error) return false;
    const name = error.name || "";
    const message = (error.message || "").toLowerCase();
    return (
      name === "NetworkError" ||
      name === "BreakError" ||
      message.includes("device has been lost") ||
      message.includes("the device has been closed") ||
      message.includes("disconnected") ||
      message.includes("network error")
    );
  }

  /**
   * Connect to a serial port
   * @param {number} [baudRate=9600] - Baud rate for the connection
   * @param {SerialPort|null} [port=null] - Existing port to use, or null to prompt user
   * @returns {Promise<boolean>} True if connection successful
   * @throws {Error} If connection fails
   */
  async connect(baudRate = 9600, port = null) {
    try {
      const requestedPort = port || (await navigator.serial.requestPort());

      // If WE already hold an open session (background auto-reconnect, a
      // previous connect, or a UI desync), a bare close() fails with
      // "Cannot cancel a locked stream" because the read loop holds the
      // reader lock - and the subsequent open() then fails, which used to
      // be misreported as "another program is using the port".
      // Tear our own session down properly first.
      if (this.port && (this.port.readable || this.port.writable)) {
        serialLogger.warn(
          "This page already holds an open port - releasing it before reconnect",
        );
        this.keepReading = false;
        if (this.reader) {
          try {
            await this.reader.cancel();
          } catch (e) {
            serialLogger.warn("Error canceling reader", e);
          }
          this.reader = null;
        }
        if (this.writer) {
          try {
            await this.writer.close();
          } catch (e) {
            serialLogger.warn("Error closing writer", e);
          }
          this.writer = null;
        }
        try {
          await this.port.close();
        } catch (e) {
          serialLogger.warn("Error closing our open port", e);
        }
        await new Promise((r) => setTimeout(r, PORT_CLOSE_DELAY_MS));
      }

      this.port = requestedPort;
      this.lastBaudRate = baudRate;
      this.reconnectAttempts = 0;
      // Re-enable auto-reconnect for the new session (an earlier intentional
      // disconnect turns it off permanently otherwise).
      this.autoReconnect = true;

      // The chosen port may still be open (e.g. granted to this page but
      // opened by an earlier session object) - close it before reopening
      if (this.port.readable || this.port.writable) {
        serialLogger.warn("Port already open, closing before reconnect");
        try {
          await this.port.close();
        } catch (e) {
          serialLogger.warn("Error closing existing port", e);
        }
        // Small delay to let the port fully close
        await new Promise((r) => setTimeout(r, PORT_CLOSE_DELAY_MS));
      }

      // Open with retry/backoff: Windows releases the COM handle a moment
      // AFTER close() resolves (both ours above and other programs'), and a
      // just-re-enumerated device can briefly refuse opens - a single
      // attempt fails with "Failed to open serial port" in both cases.
      const OPEN_ATTEMPTS = 4;
      for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
        try {
          serialLogger.info(
            `Opening port at ${baudRate} baud...${
              attempt > 1 ? ` (attempt ${attempt}/${OPEN_ATTEMPTS})` : ""
            }`,
          );
          await this.port.open({ baudRate });
          break;
        } catch (openError) {
          const msg = (openError?.message || "").toLowerCase();
          const retryable = msg.includes("failed to open serial port");
          if (!retryable || attempt === OPEN_ATTEMPTS) {
            throw openError;
          }
          serialLogger.warn(
            `Open failed (attempt ${attempt}/${OPEN_ATTEMPTS}) - retrying after backoff`,
          );
          await new Promise((r) => setTimeout(r, 400 * attempt));

          // If the device re-enumerated, our SerialPort object is dead -
          // adopt the fresh granted port with the same USB identity
          if (this.port.connected === false) {
            try {
              const info = this.port.getInfo();
              const granted = await navigator.serial.getPorts();
              const fresh = granted.find(
                (p) =>
                  p.connected !== false &&
                  p.getInfo().usbVendorId === info.usbVendorId &&
                  p.getInfo().usbProductId === info.usbProductId,
              );
              if (fresh && fresh !== this.port) {
                serialLogger.info("Adopting re-enumerated port for retry");
                this.port = fresh;
              }
            } catch (refreshError) {
              serialLogger.warn("Port refresh failed", refreshError);
            }
          }
        }
      }

      // Native USB boards (e.g., Uno R4) buffer output until DTR is asserted.
      // Raise both DTR/RTS like Arduino IDE so sketches start streaming data immediately.
      try {
        await this.port.setSignals({
          dataTerminalReady: true,
          requestToSend: true,
        });
      } catch (signalError) {
        serialLogger.warn("Unable to assert control signals", signalError);
      }
      serialLogger.success("Port opened - starting read loop");

      this.keepReading = true;
      this.readLoop();
      return true;
    } catch (error) {
      serialLogger.error("Error connecting to serial port", error);
      // Leave no half-open port behind if opening/initialising failed -
      // a lingering open port previously required a hardware reset before
      // the next reconnect attempt could succeed.
      if (this.port) {
        try {
          await this.port.close();
        } catch (closeError) {
          /* port was never opened or is already closed */
        }
        this.port = null;
      }
      throw error;
    }
  }

  /**
   * Disconnect from the serial port
   * @param {boolean} [intentional=true] - Whether disconnect was user-initiated
   * @returns {Promise<void>}
   */
  async disconnect(intentional = true) {
    // Idempotent: only the first caller performs the teardown. Racing
    // cleanup (e.g. read loop error + user disconnect) previously left the
    // port in a half-open state that broke the next reconnect.
    if (this.cleaningUp) {
      return;
    }
    this.cleaningUp = true;

    try {
      this.keepReading = false;

      // Disable auto-reconnect if intentional disconnect
      if (intentional) {
        this.autoReconnect = false;
      }

      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch (e) {
          serialLogger.warn("Error canceling reader", e);
        }
        this.reader = null;
      }
      if (this.writer) {
        try {
          await this.writer.close();
        } catch (e) {
          serialLogger.warn("Error closing writer", e);
        }
        this.writer = null;
      }
      if (this.port) {
        try {
          await this.port.setSignals({
            dataTerminalReady: false,
            requestToSend: false,
          });
        } catch (signalError) {
          serialLogger.warn("Unable to clear control signals", signalError);
        }
        try {
          await this.port.close();
        } catch (e) {
          serialLogger.warn("Error closing port", e);
        }
      }
      this.port = null;
      this.emit("disconnect", { unexpected: false });
    } finally {
      this.cleaningUp = false;
    }
  }

  /**
   * Write data to the serial port with timeout guard
   * @param {string} data - Text data to write
   * @returns {Promise<boolean>} True if write successful
   */
  async write(data) {
    if (!this.port || !this.port.writable) {
      serialLogger.warn("Write failed: port not writable");
      return false;
    }

    const encoder = new TextEncoder();
    const writer = this.port.writable.getWriter();
    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Write timeout")), WRITE_TIMEOUT_MS);
      });

      // Race write against timeout
      await Promise.race([writer.write(encoder.encode(data)), timeoutPromise]);
      return true;
    } catch (error) {
      serialLogger.error("Write error", error);
      return false;
    } finally {
      // Always release THIS writer's lock (getting a new writer on a locked
      // stream throws and leaks the original lock, poisoning future writes).
      try {
        writer.releaseLock();
      } catch (e) {
        // Ignore release errors
      }
    }
  }

  /**
   * Set control signals on the serial port
   * @param {Object} signals - Signal states to set
   * @param {boolean} [signals.dataTerminalReady] - DTR signal state
   * @param {boolean} [signals.requestToSend] - RTS signal state
   * @returns {Promise<void>}
   */
  async setSignals(signals) {
    if (!this.port) return;
    await this.port.setSignals(signals);
  }

  /**
   * Enable or disable auto-reconnect behavior
   * @param {boolean} enabled - Whether to enable auto-reconnect
   */
  setAutoReconnect(enabled) {
    this.autoReconnect = enabled;
  }

  /**
   * Handle port disconnect with auto-reconnect
   * @private
   */
  async _handleDisconnect() {
    serialLogger.warn("Port disconnected unexpectedly");
    this.emit("disconnect", { unexpected: true });

    // Only attempt auto-reconnect if enabled and we have port reference
    if (!this.autoReconnect || !this.port) {
      return;
    }

    serialLogger.info(`Auto-reconnect enabled, attempting to reconnect...`);

    // Capture the port reference - a failed connect() attempt clears
    // this.port as part of its half-open cleanup.
    const savedPort = this.port;

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      this.reconnectAttempts = attempt;
      serialLogger.info(
        `Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`,
      );

      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));

      try {
        // Try to reopen the port at the last baud rate
        await this.connect(this.lastBaudRate, savedPort);
        serialLogger.success("Reconnected successfully");
        this.reconnectAttempts = 0;
        this.emit("reconnect");
        return;
      } catch (e) {
        serialLogger.warn(`Reconnect attempt ${attempt} failed:`, e.message);
      }
    }

    serialLogger.error("All reconnect attempts failed");
    this.reconnectAttempts = 0;
    this.emit("reconnect_failed");
  }

  /**
   * Close and reopen the port at a new baud rate without losing the port reference.
   * Used for baud rate detection/scanning.
   * @param {number} baudRate - New baud rate to open at
   * @returns {Promise<boolean>} True if successful
   */
  async reopenAtBaud(baudRate) {
    if (!this.port) {
      serialLogger.error("Cannot reopen - no port connected");
      return false;
    }

    try {
      // Stop reading
      this.keepReading = false;
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader = null;
      }

      // Close the port
      try {
        await this.port.close();
      } catch (e) {
        serialLogger.warn("Error closing port during reopen", e);
      }

      // Small delay to let the port fully close
      await new Promise((r) => setTimeout(r, PORT_CLOSE_DELAY_MS));

      // Reopen at new baud rate
      serialLogger.info(`Reopening port at ${baudRate} baud...`);
      await this.port.open({ baudRate });

      // Reassert DTR/RTS
      try {
        await this.port.setSignals({
          dataTerminalReady: true,
          requestToSend: true,
        });
      } catch (signalError) {
        serialLogger.warn(
          "Unable to assert control signals after reopen",
          signalError,
        );
      }

      serialLogger.success(`Port reopened at ${baudRate} baud`);

      // Restart read loop
      this.keepReading = true;
      this.readLoop();

      return true;
    } catch (error) {
      serialLogger.error(`Failed to reopen at ${baudRate} baud`, error);
      return false;
    }
  }

  /**
   * Continuously read data from the serial port
   * Detects disconnection and triggers auto-reconnect if enabled
   * @private
   * @returns {Promise<void>}
   */
  async readLoop() {
    serialLogger.info("Serial read loop started", {
      keepReading: this.keepReading,
      hasReadable: !!this.port?.readable,
    });

    let unexpectedDisconnect = false;

    while (this.port && this.port.readable && this.keepReading) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) {
            serialLogger.info("Serial reader signaled completion");
            break;
          }
          if (value) {
            const decoder = new TextDecoder();
            this.emit("data", decoder.decode(value));
          }
        }
      } catch (error) {
        // Check if this is a disconnect error
        if (this.isDeviceLostError(error)) {
          serialLogger.warn("Port disconnected during read");
          unexpectedDisconnect = true;
          break;
        }
        serialLogger.error("Error reading from serial port", error);
      } finally {
        try {
          this.reader?.releaseLock();
        } catch (e) {
          // Ignore release errors
        }
        serialLogger.info("Serial reader released lock");
      }
    }

    serialLogger.info("Serial read loop stopped", {
      hasPort: !!this.port,
      hasReadable: !!this.port?.readable,
      keepReading: this.keepReading,
      unexpectedDisconnect,
    });

    // If unexpected disconnect, attempt auto-reconnect
    if (unexpectedDisconnect && this.keepReading) {
      this.keepReading = false;
      await this._handleDisconnect();
    }
  }

  /**
   * Register an event listener
   * @param {string} event - Event name ('data', 'disconnect', 'reconnect', 'reconnect_failed')
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  /**
   * Remove an event listener
   * @param {string} event - Event name
   * @param {Function} callback - Callback function to remove
   */
  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(
        (cb) => cb !== callback,
      );
    }
  }

  /**
   * Emit an event to all registered listeners
   * @param {string} event - Event name
   * @param {*} [data] - Event data
   * @private
   */
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((callback) => {
        try {
          callback(data);
        } catch (e) {
          serialLogger.error(`Error in ${event} listener:`, e);
        }
      });
    }
  }
}
