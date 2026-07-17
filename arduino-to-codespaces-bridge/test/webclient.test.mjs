/**
 * Web-Client Meta / Stability Tests
 *
 * Deep static checks over the web client (web-client/src) and its contracts
 * with the rest of the repository. Each group guards an invariant that has
 * actually broken during development:
 *
 *   1. boards.json integrity   - both copies in sync, schema valid, SAMD
 *                                boards list their bootloader-mode PIDs
 *   2. Protocol config         - BOARD_PROTOCOL_MAP entries agree with
 *                                boards.json (imported as a real ES module)
 *   3. BOSSA regressions       - tripwires for the orphaned-read bug, the
 *                                SAMD SRAM+Y# write flow, AIRCR reset and
 *                                device-loss-tolerant reset()
 *   4. DOM contract            - every getElementById() literal resolves to
 *                                an id in index.html (or is knowingly
 *                                created at runtime)
 *   5. Syntax                  - every web-client source file parses
 *   6. API route coverage      - every client fetch("/api/...") has a route
 *                                in BOTH the extension server and dev server
 *
 * Static and dependency-free: no browser, server boot, arduino-cli or
 * hardware required.
 *
 * Usage: npm run test:webclient
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const WEB_SRC = path.join(EXTENSION_ROOT, "web-client", "src");
const CLIENT_SRC = path.join(WEB_SRC, "client");

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
 * Recursively collect .js files under a directory.
 * @param {string} dir - Directory to walk
 * @returns {string[]} Absolute file paths
 */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(EXTENSION_ROOT, p);

console.log("Web-client meta / stability tests");

// ---------------------------------------------------------------------------
// 1. boards.json integrity
// ---------------------------------------------------------------------------
section("1. boards.json integrity");

const resourcesBoardsRaw = read("resources/boards.json");
const publicBoardsRaw = read("web-client/public/boards.json");

ok(
  "resources/boards.json and web-client/public/boards.json are identical",
  resourcesBoardsRaw === publicBoardsRaw,
  "run: cp resources/boards.json web-client/public/boards.json",
);

let boards = [];
try {
  boards = JSON.parse(resourcesBoardsRaw).boards;
  ok("boards.json parses and has a boards array", Array.isArray(boards));
} catch (e) {
  ok("boards.json parses and has a boards array", false, e.message);
}

const HEX_RE = /^0x[0-9a-fA-F]{1,4}$/;
const FQBN_RE = /^[\w-]+:[\w-]+:[\w-]+$/;
let schemaOk = true;
let schemaDetail = "";
for (const b of boards) {
  // vid/pid may be EMPTY arrays for boards detected by other means (e.g.
  // ESP8266 entries carrying only a note), but present entries must be hex
  const valid =
    typeof b.name === "string" &&
    b.name.length > 0 &&
    FQBN_RE.test(b.fqbn || "") &&
    Array.isArray(b.vid) &&
    b.vid.every((v) => HEX_RE.test(v)) &&
    Array.isArray(b.pid) &&
    b.pid.every((p) => HEX_RE.test(p));
  if (!valid) {
    schemaOk = false;
    schemaDetail = `invalid entry: ${JSON.stringify(b).slice(0, 120)}`;
    break;
  }
}
ok(
  "every board has name, vendor:arch:board fqbn, hex vid[] and pid[]",
  schemaOk,
  schemaDetail,
);

const fqbns = boards.map((b) => b.fqbn);
const dupFqbns = fqbns.filter((f, i) => fqbns.indexOf(f) !== i);
ok(
  "no duplicate FQBNs",
  dupFqbns.length === 0,
  `duplicates: ${dupFqbns.join(", ")}`,
);

// SAMD native-USB boards re-enumerate in bootloader mode as app PID - 0x8000.
// A board with no valid sketch stays in the bootloader permanently, so
// auto-detect MUST know both PIDs (bit us on the MKR WiFi 1010).
const samdBoards = boards.filter((b) => b.fqbn.startsWith("arduino:samd:"));
ok("boards.json lists arduino:samd boards", samdBoards.length >= 11);
let samdPidOk = true;
let samdPidDetail = "";
for (const b of samdBoards) {
  const pids = b.pid.map((p) => parseInt(p, 16));
  const appPids = pids.filter((p) => (p & 0x8000) !== 0 && p < 0x8200);
  for (const app of appPids) {
    if (!pids.includes(app - 0x8000)) {
      samdPidOk = false;
      samdPidDetail = `${b.fqbn}: app PID 0x${app.toString(16)} has no bootloader PID 0x${(app - 0x8000).toString(16)}`;
    }
  }
}
ok(
  "every SAMD app PID (0x8xxx) is paired with its bootloader PID (app - 0x8000)",
  samdPidOk,
  samdPidDetail,
);

// ---------------------------------------------------------------------------
// 2. Protocol config consistency (real module import)
// ---------------------------------------------------------------------------
section("2. boardProtocols.js \u2194 boards.json consistency");

const protocols =
  await import("../web-client/src/client/config/boardProtocols.js");
const MAP = protocols.BOARD_PROTOCOL_MAP;

ok(
  "boardProtocols.js imports cleanly under Node",
  MAP && typeof MAP === "object",
);

let samdMapOk = true;
let samdMapDetail = "";
for (const b of samdBoards) {
  if (!MAP[b.fqbn]) {
    samdMapOk = false;
    samdMapDetail += `${b.fqbn} missing from BOARD_PROTOCOL_MAP; `;
  }
}
ok(
  "every arduino:samd board in boards.json has an explicit protocol entry",
  samdMapOk,
  samdMapDetail,
);

let samdCfgOk = true;
let samdCfgDetail = "";
for (const b of samdBoards) {
  const cfg = MAP[b.fqbn];
  if (!cfg) continue;
  const bootPidsJson = b.pid
    .map((p) => parseInt(p, 16))
    .filter((p) => (p & 0x8000) === 0);
  const problems = [];
  if (cfg.variant !== "samd21") problems.push(`variant=${cfg.variant}`);
  if (cfg.memory?.sketchOffset !== 0x2000)
    problems.push(`sketchOffset=0x${cfg.memory?.sketchOffset?.toString(16)}`);
  if (!Array.isArray(cfg.bootloaderPids) || cfg.bootloaderPids.length === 0)
    problems.push("no bootloaderPids");
  else {
    for (const pid of cfg.bootloaderPids) {
      if (!bootPidsJson.includes(pid))
        problems.push(
          `bootloader PID 0x${pid.toString(16)} not in boards.json pid list`,
        );
    }
  }
  if (problems.length) {
    samdCfgOk = false;
    samdCfgDetail += `${b.fqbn}: ${problems.join(", ")}; `;
  }
}
ok(
  "every SAMD config: variant samd21, sketch at 0x2000, bootloader PIDs match boards.json",
  samdCfgOk,
  samdCfgDetail,
);

// Routing: exact entries must win, and a SAMD board never inherits the R4
// (renesas) config through the prefix fallback (bit us before 1.2.31)
const probe = protocols.getProtocolConfig("arduino:samd:mkrwifi1010");
ok(
  "getProtocolConfig(mkrwifi1010) resolves the samd21 variant",
  probe?.variant === "samd21" &&
    Array.isArray(probe.bootloaderPids) &&
    probe.bootloaderPids.includes(0x0054),
);
const r4 = protocols.getProtocolConfig("arduino:renesas_uno:unor4wifi");
ok(
  "getProtocolConfig(unor4wifi) still resolves the renesas config",
  r4?.variant === "renesas-ra4m1",
);

// ---------------------------------------------------------------------------
// 3. BOSSA protocol regression tripwires
// ---------------------------------------------------------------------------
section("3. BOSSA regression tripwires");

const bossa = read("web-client/src/client/services/protocols/Bossa.js");
const strategy = read(
  "web-client/src/client/services/strategies/BOSSAStrategy.js",
);

// Orphaned-read bug (1.2.36): racing a FRESH reader.read() against a timer
// leaks queued reads that swallow later data. All shared-reader loops must go
// through the single in-flight readChunk()/_pendingRead.
ok(
  "Bossa.js keeps a single shared in-flight read (_pendingRead + readChunk)",
  bossa.includes("this._pendingRead") && bossa.includes("readChunk("),
);
ok(
  "Bossa.js never races this.reader.read() directly against a timer",
  !/Promise\.race\(\s*\[\s*this\.reader\.read\(\)/.test(bossa),
  "use readChunk() - see the 1.2.36 orphaned-read bug",
);
ok(
  "readChunk clears the pending read when it rejects (device loss)",
  /catch\s*\(e\)\s*\{[^}]*this\._pendingRead = null;[^}]*throw e;/s.test(bossa),
);
ok(
  "BOSSAStrategy never races bossa.reader.read() directly against a timer",
  !/Promise\.race\(\s*\[\s*bossa\.reader\.read\(\)/.test(strategy),
  "use bossa.readChunk() - see the 1.2.36 orphaned-read bug",
);

// SAMD21 flow (1.2.35, from official bootloader source): SRAM buffer +
// Y#-commit writes, long blocking erase, AIRCR W# reset (old bootloaders
// have no K# command)
ok(
  "SAMD write path uses the bossac SRAM buffer (0x20004000)",
  strategy.includes("0x20004000"),
);
ok(
  "SAMD chip erase waits 30s for the blocking full-flash erase",
  /chipErase\([^)]*,\s*30000\)/.test(strategy),
);
ok(
  "SAMD reset writes SYSRESETREQ to AIRCR (W# - works on ALL SAMD bootloaders)",
  /0xe000ed0c/i.test(strategy) && /0x05fa0004/i.test(strategy),
);
ok(
  "chipErase accepts a per-call timeout parameter",
  /async chipErase\(startAddr, timeoutMs/.test(bossa),
);

// nRF52 reset (1.2.39): the board drops off USB without ACKing K# - reset()
// must swallow the resulting NetworkError as the expected success outcome
ok(
  "reset() tolerates the board dropping off USB (try/catch around K# sequence)",
  /async reset\(\)\s*\{[\s\S]*?try\s*\{[\s\S]*?writeCommand\("K#"\)[\s\S]*?catch/.test(
    bossa,
  ),
);
ok(
  "disconnect() releases locks even when cancel() throws on a dead port",
  /async disconnect\(\)\s*\{[\s\S]*?try\s*\{\s*await this\.reader\.cancel\(\);\s*\}\s*catch/.test(
    bossa,
  ),
);

// ---------------------------------------------------------------------------
// 4. DOM contract: getElementById() literals resolve to index.html ids
// ---------------------------------------------------------------------------
section("4. DOM contract (JS element ids exist in index.html)");

const indexHtml = read("web-client/index.html");
const htmlIds = new Set(
  [...indexHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
);

// Elements knowingly created at runtime rather than declared in index.html
const DYNAMIC_IDS = new Set(["health-offline-banner", "retryHealthBtn"]);

const clientFiles = collectJsFiles(CLIENT_SRC);
let domOk = true;
let domDetail = "";
let idCount = 0;
for (const file of clientFiles) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
    idCount++;
    const id = m[1];
    if (!htmlIds.has(id) && !DYNAMIC_IDS.has(id)) {
      domOk = false;
      domDetail += `${rel(file)}: #${id}; `;
    }
  }
}
ok(
  `all ${idCount} getElementById() literals resolve (or are known runtime ids)`,
  domOk,
  domDetail,
);

// The startup gate must exist in static HTML so it shows before JS loads
for (const requiredId of [
  "appLoading",
  "appLoadingStatus",
  "appLoadingRetry",
  "board-url-presets",
]) {
  ok(`index.html contains #${requiredId}`, htmlIds.has(requiredId));
}

// ---------------------------------------------------------------------------
// 5. Syntax: every web-client source file parses as a module
// ---------------------------------------------------------------------------
section("5. Web-client syntax check (node --check)");

const allWebFiles = [
  ...collectJsFiles(WEB_SRC),
  path.join(EXTENSION_ROOT, "web-client", "server.js"),
  path.join(EXTENSION_ROOT, "web-client", "vite.config.js"),
];
let syntaxFailures = [];
for (const file of allWebFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    syntaxFailures.push(rel(file));
  }
}
ok(
  `all ${allWebFiles.length} web-client files parse cleanly`,
  syntaxFailures.length === 0,
  syntaxFailures.join(", "),
);

// ---------------------------------------------------------------------------
// 6. API route coverage: client fetches exist on BOTH servers
// ---------------------------------------------------------------------------
section("6. API route coverage (client \u2192 both servers)");

const tsServer = read("src/server/index.ts");
const devServer = read("web-client/server.js");

/**
 * Extract Express route paths from a server source file.
 * @param {string} src - Server source code
 * @returns {string[]} Route path patterns
 */
function extractRoutes(src) {
  return [
    ...src.matchAll(
      /app\.(?:get|post|put|delete)\(\s*\n?\s*["'`]([^"'`]+)["'`]/g,
    ),
  ].map((m) => m[1]);
}

/**
 * Test whether a concrete path matches an Express route pattern.
 * @param {string} routePattern - e.g. "/api/hex/:sketchName"
 * @param {string} fetchPath - e.g. "/api/hex/blink"
 * @returns {boolean} True on match
 */
function routeMatches(routePattern, fetchPath) {
  const re = new RegExp(
    "^" +
      routePattern
        .split("/")
        .map((seg) =>
          seg.startsWith(":")
            ? "[^/]+"
            : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/") +
      "$",
  );
  return re.test(fetchPath);
}

const tsRoutes = extractRoutes(tsServer);
const devRoutes = extractRoutes(devServer);

// Collect literal fetch/bridgeFetch paths from the client (template literals
// with interpolation are skipped - covered by contracts.test.mjs)
const fetchPaths = new Set();
for (const file of clientFiles) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /(?:bridgeFetch|fetch)\(\s*["'`](\/api\/[^"'`$]+?)["'`]/g,
  )) {
    fetchPaths.add(m[1].split("?")[0]);
  }
}

// Endpoints intentionally absent from the extension server:
// - /api/upload: only called by ServerUploadStrategy, which is dead code
//   (never imported by UploadManager) - uploads go over Web Serial/WebUSB
const EXTENSION_SERVER_EXEMPT = new Set(["/api/upload"]);

ok(
  `found ${fetchPaths.size} distinct literal /api paths in the client`,
  fetchPaths.size >= 15,
);

let tsMissing = [];
let devMissing = [];
for (const p of fetchPaths) {
  if (
    !EXTENSION_SERVER_EXEMPT.has(p) &&
    !tsRoutes.some((r) => routeMatches(r, p))
  )
    tsMissing.push(p);
  if (!devRoutes.some((r) => routeMatches(r, p))) devMissing.push(p);
}
ok(
  "every client /api path has a route in the EXTENSION server (ships in VSIX)",
  tsMissing.length === 0,
  `missing: ${tsMissing.join(", ")}`,
);
ok(
  "every client /api path has a route in the DEV server (web-client/server.js)",
  devMissing.length === 0,
  `missing: ${devMissing.join(", ")}`,
);

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
