/**
 * Terminal UI Component
 *
 * Provides serial monitor functionality:
 * - XTerm.js-based terminal display
 * - Timestamp mode for debugging
 * - Log download capability
 * - Auto-resize on window changes
 * - Bounded memory and render cost under high-rate serial output
 *
 * @module client/ui/TerminalUI
 */

import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters retained for the downloadable log (~8 MB). */
const MAX_LOG_CHARS = 8_000_000;

/**
 * Maximum characters allowed to queue between frames. Far more than any
 * viewport can display, so exceeding it means we are behind the device and
 * the oldest queued output is worthless.
 */
const MAX_PENDING_CHARS = 262_144;

/** Compact the log ring once this many chunks have been retired. */
const LOG_COMPACT_THRESHOLD = 4096;

/** Scrollback lines retained by xterm. */
const SCROLLBACK_LINES = 10_000;

// =============================================================================
// TerminalUI Class
// =============================================================================

/**
 * Terminal UI component for serial monitor display
 */
export class TerminalUI {
  /**
   * Create a new TerminalUI instance
   * @param {string} containerId - DOM element ID for the terminal container
   */
  constructor(containerId) {
    /** @type {HTMLElement} */
    this.container = document.getElementById(containerId);

    /** @type {Terminal} */
    this.term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
      },
      scrollback: SCROLLBACK_LINES,
      // Sketches emit bare \n; letting xterm translate avoids allocating a
      // rewritten copy of every chunk on the hot path.
      convertEol: true,
      fastScrollModifier: "shift",
    });

    /** @type {FitAddon} */
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.term.open(this.container);
    this.fitAddon.fit();

    window.addEventListener("resize", () => {
      this.fitAddon.fit();
    });

    /** @type {string[]} Ring of log chunks retained for download */
    this.logChunks = [];

    /** @type {number} Index of the oldest live chunk in logChunks */
    this.logHead = 0;

    /** @type {number} Characters currently retained in the log ring */
    this.logLength = 0;

    /** @type {number} Characters evicted from the log ring */
    this.logDropped = 0;

    /** @type {string[]} Chunks awaiting the next frame's terminal write */
    this.pending = [];

    /** @type {number} Characters currently queued in `pending` */
    this.pendingLength = 0;

    /** @type {number} Characters discarded because rendering fell behind */
    this.pendingDropped = 0;

    /** @type {boolean} Whether a flush is already scheduled */
    this.flushScheduled = false;

    /** @type {boolean} Whether xterm is still rendering the previous flush */
    this.writeInFlight = false;

    /** @type {boolean} Whether to show timestamps */
    this.showTimestamp = false;

    /** @type {boolean} Track if last character was newline (for timestamp insertion) */
    this.lastCharWasNewline = true;
  }

  /**
   * Enable or disable timestamp mode
   * @param {boolean} enabled - Whether to show timestamps
   */
  setTimestampMode(enabled) {
    this.showTimestamp = enabled;
  }

  /**
   * Write data to the terminal
   * @param {string} data - Data to display
   */
  write(data) {
    if (!data) return;
    const output = this.showTimestamp ? this.applyTimestamps(data) : data;
    this.appendToLog(output);
    this.queueWrite(output);
  }

  /**
   * Prefix each new line with a timestamp. The clock is sampled once per
   * call rather than once per line so a burst costs a single Date read.
   * @param {string} data - Raw chunk
   * @returns {string} Chunk with line-leading timestamps
   * @private
   */
  applyTimestamps(data) {
    const now = new Date();
    const stamp = `[${now.toLocaleTimeString("en-US", {
      hour12: false,
    })}.${String(now.getMilliseconds()).padStart(3, "0")}] `;

    const segments = data.split("\n");
    let output = "";

    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      // A trailing empty segment is just the split artefact of a chunk that
      // ended on \n - stamping it would emit a timestamp with no content.
      if (this.lastCharWasNewline && (segments[i].length > 0 || !isLast)) {
        output += stamp;
        this.lastCharWasNewline = false;
      }
      output += segments[i];
      if (!isLast) {
        output += "\n";
        this.lastCharWasNewline = true;
      }
    }

    return output;
  }

  /**
   * Append to the downloadable log ring, evicting the oldest chunks once the
   * cap is reached so a long session cannot exhaust the tab's heap.
   * @param {string} text - Text to retain
   * @private
   */
  appendToLog(text) {
    this.logChunks.push(text);
    this.logLength += text.length;

    while (
      this.logLength > MAX_LOG_CHARS &&
      this.logHead < this.logChunks.length - 1
    ) {
      const evicted = this.logChunks[this.logHead].length;
      this.logLength -= evicted;
      this.logDropped += evicted;
      this.logChunks[this.logHead] = "";
      this.logHead++;
    }

    // Retired slots are nulled immediately; compacting in batches keeps the
    // eviction path O(1) amortised instead of O(n) per chunk.
    if (this.logHead >= LOG_COMPACT_THRESHOLD) {
      this.logChunks = this.logChunks.slice(this.logHead);
      this.logHead = 0;
    }
  }

  /**
   * Queue text for the next frame's terminal write.
   * @param {string} text - Text to display
   * @private
   */
  queueWrite(text) {
    this.pending.push(text);
    this.pendingLength += text.length;

    // More queued than any viewport can show means rendering is behind the
    // device; the oldest queued output would scroll past unread anyway.
    while (this.pendingLength > MAX_PENDING_CHARS && this.pending.length > 1) {
      const dropped = this.pending.shift().length;
      this.pendingLength -= dropped;
      this.pendingDropped += dropped;
    }

    this.scheduleFlush();
  }

  /**
   * Schedule a flush on the next frame.
   * @private
   */
  scheduleFlush() {
    if (this.flushScheduled || this.writeInFlight) return;
    this.flushScheduled = true;

    // requestAnimationFrame stops firing in a background tab, which would let
    // the pending queue grow until the user returns.
    if (typeof document !== "undefined" && document.hidden) {
      setTimeout(() => this.flush(), 0);
    } else {
      requestAnimationFrame(() => this.flush());
    }
  }

  /**
   * Flush queued text to xterm as a single write.
   * @private
   */
  flush() {
    this.flushScheduled = false;
    if (this.writeInFlight || this.pending.length === 0) return;

    let chunk = this.pending.join("");
    this.pending.length = 0;
    this.pendingLength = 0;

    if (this.pendingDropped > 0) {
      const kb = Math.round(this.pendingDropped / 1024);
      chunk = `\r\n\x1b[1;33m[… ${kb} KB dropped to keep up …]\x1b[0m\r\n${chunk}`;
      this.pendingDropped = 0;
    }

    this.writeInFlight = true;
    // xterm's completion callback is the only backpressure signal available;
    // without it xterm's own write queue grows without limit.
    this.term.write(chunk, () => {
      this.writeInFlight = false;
      if (this.pendingLength > 0) this.scheduleFlush();
    });
  }

  /**
   * Clear the terminal display and buffer
   */
  clear() {
    this.term.clear();
    this.logChunks = [];
    this.logHead = 0;
    this.logLength = 0;
    this.logDropped = 0;
    this.pending.length = 0;
    this.pendingLength = 0;
    this.pendingDropped = 0;
  }

  /**
   * Download the terminal log as a text file
   */
  downloadLog() {
    const parts = this.logChunks.slice(this.logHead);
    if (this.logDropped > 0) {
      const mb = (this.logDropped / 1_048_576).toFixed(1);
      parts.unshift(
        `[Bridge] Log truncated: ${mb} MB of earlier output was discarded to limit memory use.\n\n`,
      );
    }

    const blob = new Blob(parts, { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `serial-log-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Register callback for terminal input data
   * @param {function} callback - Callback function receiving input data
   */
  onData(callback) {
    this.term.onData(callback);
  }

  /**
   * Fit the terminal to its container size
   */
  fit() {
    this.fitAddon.fit();
  }
}
