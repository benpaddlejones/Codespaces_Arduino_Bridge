/**
 * Serial Flow-Control Tests
 *
 * Guards the two failure modes that made the serial monitor unusable:
 *
 *   1. No way to stop a stream short of disconnecting
 *   2. A spamming sketch growing buffers / render cost until the tab died
 *
 * Group A runs SerialManager for real (it is DOM-free and importable in
 * Node). Groups B-D are static tripwires over the DOM-bound modules
 * (TerminalUI/PlotterUI need xterm + Chart.js + a document).
 *
 * Usage: npm run test:serial-flow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { SerialManager } from "../web-client/src/client/services/SerialManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");

/** Mirrors MAX_LINE_BUFFER_CHARS in SerialManager.js */
const LINE_BUFFER_CAP = 65_536;

let passed = 0;
let failed = 0;

/**
 * Record the outcome of a single assertion.
 * @param {string} name - Human-readable description
 * @param {boolean} condition - Whether the assertion passed
 * @param {string} [detail] - Extra context shown on failure
 */
function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

/**
 * Print a section heading.
 * @param {string} title - The section title
 */
function section(title) {
  console.log(`\n${title}`);
}

/**
 * Read a file relative to the extension root.
 * @param {string} relPath - Path relative to the extension root
 * @returns {string} File contents
 */
function read(relPath) {
  return fs.readFileSync(path.join(EXTENSION_ROOT, relPath), "utf8");
}

/**
 * Build a SerialManager wired to capture every emitted line.
 * @returns {{manager: SerialManager, lines: string[]}}
 */
function makeManager() {
  const manager = new SerialManager();
  const lines = [];
  manager.on("line", (line) => lines.push(line));
  return { manager, lines };
}

/**
 * Force the throughput meter's sampling window to close on the next chunk.
 * @param {SerialManager} manager - Manager under test
 */
function expireRateWindow(manager) {
  manager.rateWindowStart = performance.now() - 1000;
}

// ---------------------------------------------------------------------------
// A. Stopping the stream
// ---------------------------------------------------------------------------
section("A. Stopping the stream");

{
  const { manager, lines } = makeManager();
  manager.handleData("alpha\nbeta\npartial");
  ok(
    "complete lines are emitted and the partial line is retained",
    lines.length === 2 &&
      lines[0] === "alpha" &&
      lines[1] === "beta" &&
      manager.buffer === "partial",
    JSON.stringify({ lines, buffer: manager.buffer }),
  );
}

{
  const { manager, lines } = makeManager();
  manager.stopOutput();
  manager.handleData("ignored\nalso ignored\n");
  ok(
    "stopOutput discards incoming data without emitting lines",
    lines.length === 0 && manager.buffer === "",
  );
  ok("stopOutput reports as stopped", manager.isStopped() === true);
  ok("stopOutput silences the terminal path", manager.isSilenced() === true);

  manager.resumeOutput();
  manager.handleData("back\n");
  ok(
    "resumeOutput restores delivery",
    manager.isStopped() === false && lines.length === 1 && lines[0] === "back",
  );
}

{
  const { manager, lines } = makeManager();
  manager.stopOutput();
  // An upload pauses and resumes around the transfer; that must not undo a
  // stop the user asked for.
  manager.pause();
  manager.resume();
  manager.handleData("still stopped\n");
  ok(
    "an upload's pause/resume cycle does not cancel a user stop",
    manager.isStopped() === true && lines.length === 0,
  );
}

{
  const { manager } = makeManager();
  manager.pause();
  ok("a compile/upload pause silences output", manager.isSilenced() === true);
  manager.resume();
  ok("balanced resume un-silences output", manager.isSilenced() === false);
}

// ---------------------------------------------------------------------------
// B. Bounded memory under spam
// ---------------------------------------------------------------------------
section("B. Bounded memory under spam");

{
  const { manager, lines } = makeManager();
  // A sketch that never emits a newline used to grow this string forever.
  const chunk = "x".repeat(50_000);
  let maxBuffer = 0;
  for (let i = 0; i < 40; i++) {
    manager.handleData(chunk);
    maxBuffer = Math.max(maxBuffer, manager.buffer.length);
  }
  ok(
    "newline-free output cannot grow the line buffer without limit",
    maxBuffer <= LINE_BUFFER_CAP + chunk.length,
    `peak buffer ${maxBuffer}`,
  );
  ok("over-long output is force-emitted rather than hoarded", lines.length > 0);
}

{
  const { manager, lines } = makeManager();
  const burst = `${"line\n".repeat(50_000)}`;
  const started = performance.now();
  manager.handleData(burst);
  const elapsed = performance.now() - started;
  ok(
    "a 50k-line burst dispatches without quadratic slowdown",
    lines.length === 50_000 && elapsed < 1000,
    `${lines.length} lines in ${elapsed.toFixed(0)} ms`,
  );
}

{
  const src = read("web-client/src/client/ui/TerminalUI.js");
  ok(
    "the terminal log is a capped ring, not an unbounded string",
    /MAX_LOG_CHARS/.test(src) &&
      /this\.logDropped/.test(src) &&
      !/this\.buffer \+= data/.test(src),
  );
  ok(
    "the pending render queue is capped",
    /MAX_PENDING_CHARS/.test(src) && /this\.pendingDropped/.test(src),
  );
  ok(
    "log download streams chunks instead of one concatenated string",
    /new Blob\(parts/.test(src),
  );
}

// ---------------------------------------------------------------------------
// C. Bounded render cost
// ---------------------------------------------------------------------------
section("C. Bounded render cost");

{
  const src = read("web-client/src/client/ui/TerminalUI.js");
  ok(
    "terminal writes are coalesced to one per frame",
    /requestAnimationFrame\(\(\) => this\.flush\(\)\)/.test(src),
  );
  ok(
    "a hidden tab falls back to a timer (rAF stops firing when hidden)",
    /document\.hidden/.test(src) &&
      /setTimeout\(\(\) => this\.flush\(\)/.test(src),
  );
  ok(
    "xterm's write callback is used as the backpressure signal",
    /this\.writeInFlight = true/.test(src) &&
      /this\.term\.write\(chunk, \(\) => \{/.test(src),
  );
  ok(
    "timestamps no longer walk the chunk character by character",
    !/for \(let i = 0; i < data\.length; i\+\+\)/.test(src),
  );
  ok(
    "scrollback is bounded explicitly",
    /scrollback: SCROLLBACK_LINES/.test(src),
  );
}

{
  const src = read("web-client/src/client/ui/PlotterUI.js");
  ok(
    "the plotter redraws once per frame, not once per line",
    /scheduleUpdate\(\)/.test(src) &&
      /requestAnimationFrame\(\(\) => \{/.test(src) &&
      /this\.chart\.update\("none"\)/.test(src),
  );
  ok(
    "the plotter skips rendering while hidden",
    /setVisible\(visible\)/.test(src) && /if \(!this\.visible\)/.test(src),
  );
}

{
  const src = read("web-client/src/client/main.js");
  ok(
    "the plotter is told when it becomes visible",
    /plotter\.setVisible\(isPlotterMode\)/.test(src),
  );
  ok(
    "the terminal data path honours every silencing reason",
    /serialManager\.isSilenced\(\)/.test(src) &&
      !/if \(serialManager\.paused\) \{/.test(src),
  );
}

// ---------------------------------------------------------------------------
// D. Flood guard and controls
// ---------------------------------------------------------------------------
section("D. Flood guard and controls");

{
  const { manager } = makeManager();
  let reported = null;
  manager.on("rate", (bytesPerSecond) => {
    reported = bytesPerSecond;
  });
  expireRateWindow(manager);
  manager.handleData("y".repeat(10_000));
  ok(
    "throughput is measured and reported",
    typeof reported === "number" && reported > 0,
    `reported ${reported}`,
  );
}

{
  const { manager } = makeManager();
  let floodedAt = null;
  manager.on("flood", (bytesPerSecond) => {
    floodedAt = bytesPerSecond;
  });

  // Six consecutive windows well above the threshold.
  for (let i = 0; i < 6; i++) {
    expireRateWindow(manager);
    manager.handleData("z".repeat(400_000));
  }
  ok(
    "a sustained flood stops output automatically",
    manager.isStopped() === true && floodedAt !== null,
    `flooded at ${floodedAt}`,
  );
}

{
  const { manager } = makeManager();
  let flooded = false;
  manager.on("flood", () => {
    flooded = true;
  });
  // Ordinary 115200-baud logging (~11.5 KB/s) must never trip the guard.
  for (let i = 0; i < 20; i++) {
    expireRateWindow(manager);
    manager.handleData("m".repeat(11_500));
  }
  ok(
    "ordinary high-speed logging does not trip the flood guard",
    flooded === false && manager.isStopped() === false,
  );
}

{
  const html = read("web-client/index.html");
  const main = read("web-client/src/client/main.js");
  ok(
    "the stop control and rate readout exist in the DOM",
    /id="stopOutputBtn"/.test(html) && /id="serialRate"/.test(html),
  );
  ok(
    "the stop control is wired to the manager",
    /serialManager\.stopOutput\(\)/.test(main) &&
      /serialManager\.resumeOutput\(\)/.test(main),
  );
  ok(
    "an auto-stop is announced rather than silently dropping data",
    /serialManager\.on\("flood"/.test(main) &&
      /Serial flood detected/.test(main),
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
