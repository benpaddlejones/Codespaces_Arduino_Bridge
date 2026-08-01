/**
 * Compile Feedback Tests
 *
 * Validates the compile-error analyzer that turns a raw arduino-cli / avr-gcc
 * build log into a single, clearly-formatted diagnosis (the improvement over
 * the compiler's generic "Error during build: exit status 1" final line).
 *
 * Three layers of validation:
 *   1. Unit      - a wide range of captured REAL compiler logs are classified
 *                  into the correct category with the right file/line/column
 *                  and an actionable suggestion. Runs everywhere (no hardware).
 *   2. Parity    - the shipped TypeScript analyzer
 *                  (src/server/compileErrorAnalyzer.ts) and the dev-server
 *                  ESM mirror (web-client/src/server/compile-analyzer.js) agree
 *                  on every case, so the two copies never drift.
 *   3. Integration - buggy fixture sketches are compiled with the bundled
 *                  arduino-cli and the analyzer is run on the live output.
 *                  Skipped with a notice when arduino-cli / the AVR core is
 *                  unavailable.
 *
 * Usage: npm run test:compile-feedback
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures", "compile-errors");
const FQBN = process.env.TEST_FQBN || "arduino:avr:uno";
const CLI = path.join(EXTENSION_ROOT, "bin", "arduino-cli");

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Load both analyzer implementations
// ---------------------------------------------------------------------------

/** Bundle the shipped TypeScript analyzer to a temp ESM file and import it. */
async function loadTsAnalyzer() {
  const outFile = path.join(
    os.tmpdir(),
    `compileErrorAnalyzer-${Date.now()}.mjs`,
  );
  execFileSync(
    "npx",
    [
      "esbuild",
      path.join(EXTENSION_ROOT, "src", "server", "compileErrorAnalyzer.ts"),
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--outfile=${outFile}`,
    ],
    { cwd: EXTENSION_ROOT, stdio: "pipe" },
  );
  return import(outFile);
}

/** Import the dev-server ESM mirror directly. */
async function loadJsMirror() {
  const p = path.join(
    EXTENSION_ROOT,
    "web-client",
    "src",
    "server",
    "compile-analyzer.js",
  );
  return import(p);
}

// ---------------------------------------------------------------------------
// Captured REAL arduino-cli 1.4.0 / arduino:avr 1.8.8 output (edited for length)
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: "missing semicolon (expected ',' or ';')",
    category: "missing_semicolon",
    file: "semicolon.ino",
    line: 3,
    column: 3,
    suggestionIncludes: "line 2",
    log: [
      "/tmp/x/semicolon.ino: In function 'void setup()':",
      "/tmp/x/semicolon.ino:3:3: error: expected ',' or ';' before 'Serial'",
      "   Serial.begin(9600);",
      "   ^~~~~~",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing semicolon (expected ';' before '}')",
    category: "missing_semicolon",
    file: "sketch.ino",
    line: 35,
    log: [
      "/tmp/x/sketch.ino: In function 'void setup()':",
      "/tmp/x/sketch.ino:35:1: error: expected ';' before '}' token",
      " }",
      " ^",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "undeclared identifier",
    category: "undeclared_identifier",
    file: "undeclared.ino",
    line: 3,
    column: 18,
    suggestionIncludes: "counter",
    log: [
      "/tmp/x/undeclared.ino: In function 'void setup()':",
      "/tmp/x/undeclared.ino:3:18: error: 'counter' was not declared in this scope",
      "   Serial.println(counter);",
      "                  ^~~~~~~",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "unmatched brace",
    category: "unmatched_brace",
    file: "brace.ino",
    line: 3,
    log: [
      "/tmp/x/brace.ino: In function 'void setup()':",
      "/tmp/x/brace.ino:3:13: error: a function-definition is not allowed here before '{' token",
      " void loop() {}",
      "             ^",
      "/tmp/x/brace.ino:3:14: error: expected '}' at end of input",
      " void loop() {}",
      "              ^",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "redefinition of setup()",
    category: "redefinition",
    file: "redef.ino",
    line: 2,
    column: 6,
    suggestionIncludes: "void setup()",
    log: [
      "/tmp/x/redef.ino: In function 'void setup()':",
      "/tmp/x/redef.ino:2:6: error: redefinition of 'void setup()'",
      " void setup() {}",
      "      ^~~~~",
      "/tmp/x/redef.ino:1:6: note: 'void setup()' previously defined here",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing header / library",
    category: "missing_header",
    file: "header.ino",
    line: 1,
    column: 10,
    suggestionIncludes: "NonexistentLib.h",
    log: [
      "/tmp/x/header.ino:1:10: fatal error: NonexistentLib.h: No such file or directory",
      " #include <NonexistentLib.h>",
      "          ^~~~~~~~~~~~~~~~~~",
      "compilation terminated.",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing library (DHT sensor)",
    category: "missing_header",
    file: "sketch.ino",
    line: 1,
    column: 10,
    suggestionIncludes: "DHT.h",
    log: [
      "/tmp/x/sketch.ino:1:10: fatal error: DHT.h: No such file or directory",
      " #include <DHT.h>",
      "          ^~~~~~~",
      "compilation terminated.",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing library (Adafruit_GFX)",
    category: "missing_header",
    file: "sketch.ino",
    line: 1,
    column: 10,
    suggestionIncludes: "Adafruit_GFX.h",
    log: [
      "/tmp/x/sketch.ino:1:10: fatal error: Adafruit_GFX.h: No such file or directory",
      " #include <Adafruit_GFX.h>",
      "          ^~~~~~~~~~~~~~~~~",
      "compilation terminated.",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing required loop()",
    category: "missing_required_function",
    suggestionIncludes: "void loop()",
    log: [
      "/tmp/ccjOTZic.ltrans0.ltrans.o: In function `main':",
      "/home/node/.arduino15/packages/arduino/hardware/avr/1.8.8/cores/arduino/main.cpp:46: undefined reference to `loop'",
      "collect2: error: ld returned 1 exit status",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "missing required setup()",
    category: "missing_required_function",
    suggestionIncludes: "void setup()",
    log: [
      "/tmp/y.ltrans.o: In function `main':",
      "main.cpp:44: undefined reference to `setup'",
      "collect2: error: ld returned 1 exit status",
    ].join("\n"),
  },
  {
    name: "generic linker error",
    category: "linker_error",
    log: [
      "/tmp/z.o: In function `setup':",
      "sketch.ino:5: undefined reference to `computeChecksum()'",
      "collect2: error: ld returned 1 exit status",
    ].join("\n"),
  },
  {
    name: "flash overflow (sketch too big)",
    category: "flash_overflow",
    suggestionIncludes: "flash",
    explanationIncludes: "129%",
    log: [
      "Sketch uses 41806 bytes (129%) of program storage space. Maximum is 32256 bytes.",
      "Global variables use 188 bytes (9%) of dynamic memory, leaving 1860 bytes for local variables. Maximum is 2048 bytes.",
      "Sketch too big; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing it.",
      "Error during build: text section exceeds available space in board",
    ].join("\n"),
  },
  {
    name: "RAM overflow (not enough memory)",
    category: "ram_overflow",
    suggestionIncludes: "RAM",
    explanationIncludes: "155%",
    log: [
      "Sketch uses 4746 bytes (14%) of program storage space. Maximum is 32256 bytes.",
      "Global variables use 3188 bytes (155%) of dynamic memory, leaving -1140 bytes for local variables. Maximum is 2048 bytes.",
      "Not enough memory; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing your footprint.",
      "Error during build: data section exceeds available space in board",
    ].join("\n"),
  },
  {
    name: "array too large",
    category: "array_too_large",
    file: "flashbig.ino",
    line: 2,
    suggestionIncludes: "PROGMEM",
    log: [
      "/tmp/x/flashbig.ino:2:38: error: size of array 'big' is too large",
      " const PROGMEM unsigned char big[40000] = {1};",
      "                                      ^",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "generic C++ error with location",
    category: "compile_error",
    file: "types.ino",
    line: 3,
    column: 15,
    log: [
      "/tmp/x/types.ino: In function 'void setup()':",
      "/tmp/x/types.ino:3:15: error: invalid conversion from 'const char*' to 'int' [-fpermissive]",
      '   int value = "not a number";',
      "               ^~~~~~~~~~~~~~",
      "Error during build: exit status 1",
    ].join("\n"),
  },
  {
    name: "unrecognised failure (has 'error' word only)",
    category: "unknown",
    log: "avrdude: error: something went sideways during build",
  },
  {
    name: "error inside an included local header (.h), not the .ino",
    category: "undeclared_identifier",
    file: "helper.h",
    line: 6,
    column: 15,
    suggestionIncludes: "notDeclaredInHeader",
    log: [
      "/tmp/impcap/imported_error/imported_error.ino:1:0: In file included from imported_error.ino:1:",
      "/tmp/impcap/imported_error/helper.h: In function 'void helperInit()':",
      "/tmp/impcap/imported_error/helper.h:6:15: error: 'notDeclaredInHeader' was not declared in this scope",
      "   int value = notDeclaredInHeader + 1;",
      "               ^~~~~~~~~~~~~~~~~~~",
      "Error during build: exit status 1",
    ].join("\n"),
  },
];

const NULL_CASES = [
  { name: "empty log", log: "" },
  { name: "whitespace only", log: "   \n  \t\n" },
  {
    name: "successful build",
    log: [
      "Sketch uses 1030 bytes (3%) of program storage space. Maximum is 32256 bytes.",
      "Global variables use 9 bytes (0%) of dynamic memory.",
    ].join("\n"),
  },
];

// ---------------------------------------------------------------------------
// Multi-error cases: analyzeCompileErrors (plural) must surface EVERY distinct
// problem, not just the first, so a sketch with several independent mistakes
// shows a complete list. Parse errors cascade, so these use independent
// semantic errors (captured from a real avr-gcc run of the multiple_errors
// fixture).
// ---------------------------------------------------------------------------

const MULTI_CASES = [
  {
    name: "four independent errors (3 undeclared + 1 bad call)",
    log: [
      "/tmp/m/multiple_errors.ino: In function 'void setup()':",
      "/tmp/m/multiple_errors.ino:5:18: error: 'firstMissing' was not declared in this scope",
      "   Serial.println(firstMissing);",
      "                  ^~~~~~~~~~~~",
      "/tmp/m/multiple_errors.ino:6:16: error: 'secondMissing' was not declared in this scope",
      "   digitalWrite(secondMissing, HIGH);",
      "                ^~~~~~~~~~~~~",
      "/tmp/m/multiple_errors.ino:7:3: error: too few arguments to function 'void pinMode(uint8_t, uint8_t)'",
      "   pinMode(13);",
      "   ^~~~~~~",
      "/tmp/m/multiple_errors.ino: In function 'void loop()':",
      "/tmp/m/multiple_errors.ino:10:11: error: 'notDeclaredHere' was not declared in this scope",
      "   int x = notDeclaredHere + 1;",
      "           ^~~~~~~~~~~~~~~",
      "Error during build: exit status 1",
    ].join("\n"),
    // Order preserved; classified per line.
    expect: [
      { category: "undeclared_identifier", line: 5 },
      { category: "undeclared_identifier", line: 6 },
      { category: "compile_error", line: 7 },
      { category: "undeclared_identifier", line: 10 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function checkCase(analyze, label, c) {
  const d = analyze(c.log);
  if (!d) {
    ok(`${label}: ${c.name}`, false, "expected a diagnosis, got null");
    return;
  }
  const details = [];
  if (d.category !== c.category)
    details.push(`category ${d.category} != ${c.category}`);
  if (c.file !== undefined && d.file !== c.file)
    details.push(`file ${d.file} != ${c.file}`);
  if (c.line !== undefined && d.line !== c.line)
    details.push(`line ${d.line} != ${c.line}`);
  if (c.column !== undefined && d.column !== c.column)
    details.push(`column ${d.column} != ${c.column}`);
  if (c.suggestionIncludes && !d.suggestion.includes(c.suggestionIncludes))
    details.push(`suggestion missing "${c.suggestionIncludes}"`);
  if (c.explanationIncludes && !d.explanation.includes(c.explanationIncludes))
    details.push(`explanation missing "${c.explanationIncludes}"`);
  if (!d.headline || !d.headline.includes(d.title))
    details.push("headline missing title");
  ok(`${label}: ${c.name}`, details.length === 0, details.join("; "));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ts = await loadTsAnalyzer();
  const js = await loadJsMirror();
  const analyzeTs = ts.analyzeCompileError;
  const analyzeJs = js.analyzeCompileError;

  section("Unit: shipped TypeScript analyzer classifies real logs");
  for (const c of CASES) checkCase(analyzeTs, "ts", c);

  section("Unit: logs with no actionable error return null");
  for (const c of NULL_CASES) {
    ok(`ts: ${c.name}`, analyzeTs(c.log) === null);
    ok(`js: ${c.name}`, analyzeJs(c.log) === null);
  }

  section("Unit: dev-server mirror classifies real logs");
  for (const c of CASES) checkCase(analyzeJs, "js", c);

  section("Parity: TypeScript and mirror agree on every case");
  for (const c of CASES) {
    const a = analyzeTs(c.log) || {};
    const b = analyzeJs(c.log) || {};
    const same =
      a.category === b.category &&
      a.title === b.title &&
      a.file === b.file &&
      a.line === b.line &&
      a.column === b.column &&
      a.suggestion === b.suggestion &&
      a.explanation === b.explanation;
    ok(`parity: ${c.name}`, same, `${a.category} vs ${b.category}`);
  }

  section("Format: boxed diagnosis block is clearly the issue");
  const block = ts.formatDiagnosisBlock(analyzeTs(CASES[0].log));
  ok(
    "block announces COMPILATION FAILED",
    block.includes("COMPILATION FAILED"),
  );
  ok("block shows the title", block.includes("Missing semicolon"));
  ok("block shows a fix arrow", block.includes("\ud83d\udc49"));
  ok("block shows the location", /line 3/.test(block));

  // -------------------------------------------------------------------------
  // Multiple errors: analyzeCompileErrors must return EVERY distinct problem.
  // -------------------------------------------------------------------------
  section("Multi: analyzeCompileErrors surfaces every distinct problem");
  for (const c of MULTI_CASES) {
    for (const [label, analyzeAll] of [
      ["ts", ts.analyzeCompileErrors],
      ["js", js.analyzeCompileErrors],
    ]) {
      const list = analyzeAll(c.log);
      const cats = list.map((d) => `${d.category}@${d.line}`).join(", ");
      const want = c.expect.map((e) => `${e.category}@${e.line}`).join(", ");
      ok(
        `${label} multi: ${c.name}`,
        list.length === c.expect.length &&
          c.expect.every(
            (e, i) =>
              list[i].category === e.category && list[i].line === e.line,
          ),
        `got [${cats}] want [${want}]`,
      );
    }
    // Parity: both analyzers produce the same ordered category/line list.
    const a = ts
      .analyzeCompileErrors(c.log)
      .map((d) => `${d.category}@${d.line}`);
    const b = js
      .analyzeCompileErrors(c.log)
      .map((d) => `${d.category}@${d.line}`);
    ok(
      `parity multi: ${c.name}`,
      a.length === b.length && a.every((v, i) => v === b[i]),
      `${a.join(",")} vs ${b.join(",")}`,
    );
    // The single-diagnosis wrapper returns the first of the list.
    const first = ts.analyzeCompileError(c.log);
    ok(
      `single wrapper returns first of: ${c.name}`,
      !!first && first.category === c.expect[0].category,
    );
  }

  // -------------------------------------------------------------------------
  // Integration: compile real buggy fixtures and analyze the live output
  // -------------------------------------------------------------------------
  section("Integration: compile buggy AVR fixtures and validate diagnosis");
  const cliOk = fs.existsSync(CLI) && avrCoreInstalled();
  if (!cliOk) {
    console.log(
      "  \u26a0 skipped \u2014 bundled arduino-cli or arduino:avr core not available",
    );
  } else {
    const expected = {
      missing_semicolon: "missing_semicolon",
      undeclared_identifier: "undeclared_identifier",
      unmatched_brace: "unmatched_brace",
      redefinition: "redefinition",
      missing_header: "missing_header",
      missing_required_function: "missing_required_function",
      flash_overflow: "flash_overflow",
      ram_overflow: "ram_overflow",
      array_too_large: "array_too_large",
      generic_error: "compile_error",
      missing_library_dht: "missing_header",
      missing_library_gfx: "missing_header",
    };
    for (const [dir, category] of Object.entries(expected)) {
      const log = compileFixture(dir);
      const d = analyzeTs(log);
      const detail = d ? `got ${d.category}` : "got null";
      ok(
        `fixture ${dir} \u2192 ${category}`,
        !!d && d.category === category,
        detail,
      );
      // Location-bearing categories must report a sketch file + a line number.
      if (d && d.file !== undefined) {
        ok(
          `fixture ${dir} reports ${d.file}:${d.line}`,
          d.file.endsWith(".ino") && Number.isInteger(d.line) && d.line > 0,
        );
      }
    }

    // Missing-library fixtures must name the exact header students need to add.
    const dhtLog = compileFixture("missing_library_dht");
    ok(
      "fixture missing_library_dht names DHT.h",
      /DHT\.h/.test(analyzeTs(dhtLog).suggestion),
    );
    const gfxLog = compileFixture("missing_library_gfx");
    ok(
      "fixture missing_library_gfx names Adafruit_GFX.h",
      /Adafruit_GFX\.h/.test(analyzeTs(gfxLog).suggestion),
    );

    // Multiple independent mistakes must all be reported, not just the first.
    const multiLog = compileFixture("multiple_errors");
    const multi = ts.analyzeCompileErrors(multiLog);
    ok(
      "fixture multiple_errors reports at least 3 problems",
      multi.length >= 3,
      `got ${multi.length}`,
    );
    ok(
      "fixture multiple_errors includes an undeclared identifier",
      multi.some((d) => d.category === "undeclared_identifier"),
    );
    ok(
      "fixture multiple_errors includes the bad pinMode() call",
      multi.some((d) => d.category === "compile_error"),
    );

    // Error lives in an included local header: the analyzer must blame the
    // header (helper.h), NOT the main .ino that included it.
    const importLog = compileFixture("imported_error");
    const importDiag = analyzeTs(importLog);
    ok(
      "fixture imported_error blames the included header, not the .ino",
      !!importDiag &&
        importDiag.file === "helper.h" &&
        importDiag.category === "undeclared_identifier",
      importDiag ? `got ${importDiag.file} (${importDiag.category})` : "null",
    );
    ok(
      "fixture imported_error does not point at the main .ino",
      !!importDiag && !/imported_error\.ino$/.test(importDiag.file || ""),
    );

    // A correct sketch must compile cleanly and yield no diagnosis.
    const goodLog = compileFixture("valid_sketch");
    ok(
      "fixture valid_sketch compiles with no diagnosis",
      analyzeTs(goodLog) === null,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** True when the arduino:avr core is installed for the bundled CLI. */
function avrCoreInstalled() {
  try {
    const out = execFileSync(CLI, ["core", "list"], { encoding: "utf8" });
    return /arduino:avr/.test(out);
  } catch {
    return false;
  }
}

/** Compile a fixture sketch and return the combined stdout+stderr log. */
function compileFixture(dir) {
  const sketchDir = path.join(FIXTURES, dir);
  const buildDir = path.join(os.tmpdir(), `compile-feedback-${dir}`);
  try {
    return execFileSync(
      CLI,
      ["compile", "-b", FQBN, "--build-path", buildDir, sketchDir],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (err) {
    // A failed compile is expected; the diagnostic text is on stdout/stderr.
    return `${err.stdout || ""}\n${err.stderr || ""}`;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
