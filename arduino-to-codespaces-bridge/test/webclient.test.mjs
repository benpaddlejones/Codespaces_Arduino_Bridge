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

// The same FQBN may appear in several entries across tiers (e.g. the
// official Uno in tier 1 plus a CH340 clone entry in tier 2), but tier 1
// itself must stay canonical: one entry per board
const tier1Fqbns = boards.filter((b) => b.tier === 1).map((b) => b.fqbn);
const dupFqbns = tier1Fqbns.filter((f, i) => tier1Fqbns.indexOf(f) !== i);
ok(
  "no duplicate FQBNs within tier 1",
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
// 1b. Three-tier board identification (see TODOS'md spec)
// ---------------------------------------------------------------------------
section("1b. Board tiers (tier field, uniqueness, resolver policy)");

ok(
  "every board has tier 1, 2 or 3",
  boards.every((b) => [1, 2, 3].includes(b.tier)),
  boards
    .filter((b) => ![1, 2, 3].includes(b.tier))
    .map((b) => b.fqbn)
    .join(", "),
);

ok(
  "every arduino:* board entry with official VID 0x2341/0x2a03 is tier 1",
  boards
    .filter(
      (b) =>
        b.fqbn.startsWith("arduino:") &&
        b.vid.some((v) => [0x2341, 0x2a03].includes(parseInt(v, 16))),
    )
    .every((b) => b.tier === 1),
);

// THE invariant the auto-picker depends on: within tiers 1+2 combined, no
// VID:PID pair may appear twice (tier 2 = exactly one board per chip)
const pairOwners = new Map();
let tierUniqueOk = true;
let tierUniqueDetail = "";
for (const b of boards.filter((x) => x.tier === 1 || x.tier === 2)) {
  for (const v of b.vid) {
    for (const p of b.pid) {
      const key = `${parseInt(v, 16)}:${parseInt(p, 16)}`;
      if (pairOwners.has(key) && pairOwners.get(key) !== b.name) {
        tierUniqueOk = false;
        tierUniqueDetail += `${key} owned by both "${pairOwners.get(key)}" and "${b.name}"; `;
      }
      pairOwners.set(key, b.name);
    }
  }
}
ok(
  "no VID:PID pair appears twice within tiers 1+2 (auto-picker uniqueness)",
  tierUniqueOk,
  tierUniqueDetail,
);

// Tier 3 = duplicates by definition: every tier-3 pair must also be owned
// by a tier-1 or tier-2 entry
let tier3Ok = true;
let tier3Detail = "";
for (const b of boards.filter((x) => x.tier === 3)) {
  for (const v of b.vid) {
    for (const p of b.pid) {
      const key = `${parseInt(v, 16)}:${parseInt(p, 16)}`;
      if (!pairOwners.has(key)) {
        tier3Ok = false;
        tier3Detail += `${b.fqbn} pair ${v}:${p} has no tier-1/2 owner; `;
      }
    }
  }
}
ok(
  "every tier-3 VID:PID pair is also owned by a tier-1/2 entry (duplicates only)",
  tier3Ok,
  tier3Detail,
);

// Resolver policy (real module import)
const resolver =
  await import("../web-client/src/client/services/boardResolver.js");
const { resolveBoardForDevice, shouldWarnMismatch, devicePairKey } = resolver;

// tier 1 wins: official Uno pair
const unoHit = resolveBoardForDevice(0x2341, 0x0043, boards, new Map());
ok(
  "resolver: official Uno pair (2341:0043) resolves via tier 1",
  unoHit?.fqbn === "arduino:avr:uno" && unoHit.source === "tier1",
);

// tier 2 fallback: CH340 pair resolves to the Uno clone entry
const ch340Hit = resolveBoardForDevice(0x1a86, 0x7523, boards, new Map());
ok(
  "resolver: CH340 pair (1a86:7523) falls back to tier 2 (Uno compatible)",
  ch340Hit?.fqbn === "arduino:avr:uno" && ch340Hit.source === "tier2",
);

// tier 3 never auto-selected: PJRC pair goes to the tier-2 Teensy 4.1,
// never the tier-3 Teensy 4.0
const teensyHit = resolveBoardForDevice(0x16c0, 0x0483, boards, new Map());
ok(
  "resolver: PJRC pair resolves to tier-2 Teensy 4.1, never tier-3 4.0",
  teensyHit?.fqbn === "teensy:avr:teensy41" && teensyHit.source === "tier2",
);

// learned mapping beats everything (Uno kit swapped for R4 Minima scenario)
const learned = new Map([
  [devicePairKey(0x2341, 0x0043), "arduino:renesas_uno:minima"],
]);
const learnedHit = resolveBoardForDevice(0x2341, 0x0043, boards, learned);
ok(
  "resolver: learned mapping overrides a confident tier-1 match",
  learnedHit?.fqbn === "arduino:renesas_uno:minima" &&
    learnedHit.source === "learned",
);

// unknown pair -> null
ok(
  "resolver: unknown VID:PID resolves to null",
  resolveBoardForDevice(0xdead, 0xbeef, boards, new Map()) === null,
);

// mismatch policy: device = official Uno, selected = MKR WiFi 1010 -> WARN
const warn1 = shouldWarnMismatch(
  0x2341,
  0x0043,
  "arduino:samd:mkrwifi1010",
  boards,
  new Map(),
);
ok(
  "mismatch: official Uno device vs selected MKR WiFi 1010 warns",
  warn1.warn === true && /uno/i.test(warn1.detectedName || ""),
);

// mismatch: CH340 device with ANY tier-2/3 board selected -> silent
const warn2 = shouldWarnMismatch(
  0x1a86,
  0x7523,
  "esp8266:esp8266:d1",
  boards,
  new Map(),
);
ok(
  "mismatch: CH340 device vs selected tier-3 board (d1) is silent",
  warn2.warn === false,
);

// mismatch: learned pair never warns even against a tier-1 identity
const warn3 = shouldWarnMismatch(
  0x2341,
  0x0043,
  "arduino:renesas_uno:minima",
  boards,
  learned,
);
ok("mismatch: learned pair never warns", warn3.warn === false);

// mismatch: unknown device pair is ambiguous -> silent
const warn4 = shouldWarnMismatch(
  0xdead,
  0xbeef,
  "arduino:avr:uno",
  boards,
  new Map(),
);
ok("mismatch: unknown VID:PID never warns (ambiguous)", warn4.warn === false);

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
// 7. Learned-device tracking contracts (see TODOS'md spec)
// ---------------------------------------------------------------------------
section("7. Learned-device tracking");

const mainSrc = read("web-client/src/client/main.js");
const envConfig = read("src/config/environmentConfig.ts");
const envSync = read("src/services/environmentSync.ts");

// Request contract: client POSTs vid/pid/fqbn; the extension server reads them
ok(
  "client records uploads via POST /api/devices/learned with vid/pid/fqbn",
  /recordLearnedDevice/.test(mainSrc) &&
    /vid: info\.usbVendorId,\s*\n\s*pid: info\.usbProductId,\s*\n\s*fqbn,/.test(
      mainSrc,
    ),
);
ok(
  "extension server reads vid/pid/fqbn from the POST body",
  /const \{ vid, pid, fqbn \} = req\.body/.test(tsServer),
);
ok(
  "extension server validates the FQBN before storing (injection guard)",
  /isSafeCliArg\(fqbn\)/.test(tsServer),
);

// Upload success paths both record the mapping
const recordCalls = (
  mainSrc.match(/void recordLearnedDevice\(port, fqbn\)/g) || []
).length;
ok(
  "both upload success paths record the learned mapping",
  recordCalls === 2,
  `found ${recordCalls} recordLearnedDevice call(s)`,
);

// Persistence format: parser and serializer agree on the device line syntax
ok(
  "environmentConfig parses `device 0xVVVV:0xPPPP <fqbn>` lines",
  /0x\[0-9a-fA-F\]\{4\}:0x\[0-9a-fA-F\]\{4\}/.test(envConfig) &&
    /trimmed\.startsWith\("device "\)/.test(envConfig),
);
ok(
  "environmentConfig serializes the `# Devices` section",
  /# Devices \(learned from successful uploads\)/.test(envConfig) &&
    /device \$\{d\.key\} \$\{d\.fqbn\}/.test(envConfig),
);
ok(
  "dev server uses the same device line format",
  /0x\[0-9a-fA-F\]\{4\}:0x\[0-9a-fA-F\]\{4\}/.test(devServer) &&
    /# Devices \(learned from successful uploads\)/.test(devServer),
);

// Lifecycle: env sync seeds the server map from the file and persists back
ok(
  "environment sync seeds the server's learned map from the file",
  /seedLearnedDevices\(config\.devices/.test(envSync),
);
ok(
  "environment sync persists learned devices back to the file",
  /getLearnedDevices\(\)/.test(envSync) && /config\.devices =/.test(envSync),
);

// Client startup loads the learned map (resolver override source)
ok(
  "client loads learned devices at startup into the resolver map",
  /loadLearnedDevices\(\)/.test(mainSrc) &&
    /learnedDeviceMap\.set\(d\.key\.toLowerCase\(\), d\.fqbn\)/.test(mainSrc),
);

// ---------------------------------------------------------------------------
// 8. Upload reporter (quiet terminal, trace to console only)
// ---------------------------------------------------------------------------
section("8. Upload reporter");

const reporterMod =
  await import("../web-client/src/client/services/utils/UploadReporter.js");
const { UploadReporter, UPLOAD_PHASES } = reporterMod;

ok(
  "fixed phase order: compile,prepare,erase,write,verify,reset,reconnect",
  JSON.stringify(UPLOAD_PHASES) ===
    JSON.stringify([
      "compile",
      "prepare",
      "erase",
      "write",
      "verify",
      "reset",
      "reconnect",
    ]),
);

// Drive a full report through a captured writer
{
  let out = "";
  const r = new UploadReporter((t) => (out += t));
  r.start("blink \u2192 Uno");
  r.phase("compile", "Compiling\u2026");
  r.phase("compile", "Compiling again\u2026"); // repeat - must not duplicate
  r.phase("write", "Flashing\u2026");
  r.phase("prepare", "Backwards\u2026"); // regression - must be ignored
  r.progress(50, "Chunk 1/2");
  r.success();
  r.success(); // second summary must be suppressed
  const compileLines = (out.match(/Compiling/g) || []).length;
  ok("phase lines never repeat", compileLines === 1);
  ok("phases never go backwards", !out.includes("Backwards"));
  ok(
    "progress renders as a self-overwriting line",
    out.includes("\rChunk 1/2: 50%"),
  );
  const summaries = (out.match(/\u2705/g) || []).length;
  ok("exactly one success summary", summaries === 1);
}

{
  let out = "";
  const r = new UploadReporter((t) => (out += t));
  r.start();
  r.failure(new Error("Bootloader did not respond"), "Double-tap RESET.");
  ok(
    "failure summary includes the error and the console pointer",
    out.includes("Bootloader did not respond") &&
      out.includes("browser console (F12)") &&
      out.includes("Double-tap RESET."),
  );
}

// Console-only trace tripwires: the console-to-terminal mirror is gone and
// the protocol logger never touches the terminal
ok(
  "the console-to-terminal mirror (setupConsoleBridge) is removed",
  !mainSrc.includes("setupConsoleBridge"),
);
const uploadLoggerSrc = read(
  "web-client/src/client/services/utils/UploadLogger.js",
);
ok(
  "UploadLogger writes to the console only (never terminal.write)",
  !uploadLoggerSrc.includes("terminal.write"),
);
ok(
  "upload flows route through the shared UploadReporter",
  /uploadReporter\.start\(/.test(mainSrc) &&
    /uploadReporter\.success\(/.test(mainSrc) &&
    /uploadReporter\.failure\(/.test(mainSrc) &&
    /uploadReporter\.progress\(progress, status/.test(mainSrc),
);

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
