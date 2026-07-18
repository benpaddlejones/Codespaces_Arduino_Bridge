/**
 * Upload Reporter - consistent, quiet terminal output for uploads.
 *
 * The terminal shows only fixed phases (one line each) plus a single
 * success/failure summary; the full protocol trace (CMD/RSP/timing from
 * UploadLogger) stays in the browser console. All boards go through this
 * one reporter so the output is identical across BOSSA/DFU/AVR/ESP flows.
 *
 * Pure module (writer injected) so tests can drive it under Node.
 */

/** Fixed phase order shown to the user. */
export const UPLOAD_PHASES = [
  "compile",
  "prepare",
  "erase",
  "write",
  "verify",
  "reset",
  "reconnect",
];

/**
 * Reports upload progress to the user terminal in a fixed-phase format.
 */
export class UploadReporter {
  /**
   * @param {(text: string) => void} write - Terminal write function
   */
  constructor(write) {
    /** @type {(text: string) => void} */
    this.write = write;
    /** @type {number} Index of the current phase (-1 = not started) */
    this.phaseIndex = -1;
    /** @type {number} Upload start timestamp */
    this.startTime = Date.now();
    /** @type {boolean} A summary (success/failure) has been emitted */
    this.finished = false;
  }

  /**
   * Begin a new upload report.
   * @param {string} [target] - Description, e.g. "demo_blink -> MKR WiFi 1010"
   */
  start(target) {
    this.phaseIndex = -1;
    this.startTime = Date.now();
    this.finished = false;
    this.write(
      `\r\n\u2500\u2500 Upload${target ? `: ${target}` : ""} \u2500\u2500\r\n`,
    );
  }

  /**
   * Announce a phase (one line, never repeated, never backwards).
   * @param {string} id - One of UPLOAD_PHASES
   * @param {string} [label] - Human label (defaults to the id)
   */
  phase(id, label) {
    const idx = UPLOAD_PHASES.indexOf(id);
    if (idx === -1) {
      console.warn(`UploadReporter: unknown phase "${id}"`);
      return;
    }
    if (idx <= this.phaseIndex) return;
    this.phaseIndex = idx;
    this.write(`\r\n[${idx + 1}/${UPLOAD_PHASES.length}] ${label || id}\r\n`);
  }

  /**
   * Update the single self-overwriting progress line. The line is fully
   * erased (ANSI \x1b[2K) before each rewrite - a bare \r left stale
   * characters behind whenever the new text was shorter than the old one
   * (e.g. "Finalizing...: 100%   ode...: 0%").
   * @param {number} percent - 0-100
   * @param {string} [note] - Short status, e.g. "Chunk 3/22"
   */
  progress(percent, note) {
    this.write(`\r\x1b[2K${note ? `${note}: ` : ""}${percent}%`);
  }

  /**
   * Emit the success summary (once).
   * @param {string} [message] - Override summary text
   */
  success(message) {
    if (this.finished) return;
    this.finished = true;
    const secs = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.write(`\r\n\u2705 ${message || "Upload complete"} (${secs}s)\r\n`);
  }

  /**
   * Emit the failure summary (once) with the console pointer.
   * @param {Error|string} error - The failure
   * @param {string} [hint] - Optional actionable hint shown before the pointer
   */
  failure(error, hint) {
    if (this.finished) return;
    this.finished = true;
    const secs = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const message = error?.message || String(error || "unknown error");
    this.write(`\r\n\u274c Upload failed after ${secs}s: ${message}\r\n`);
    if (hint) {
      this.write(`   ${hint}\r\n`);
    }
    this.write(`   Full protocol log: browser console (F12)\r\n`);
  }
}
