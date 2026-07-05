/**
 * IntelliSense Robustness Tests
 *
 * Guards against false "identifier is undefined" errors on built-in Arduino
 * code. The strategy: build the exact c_cpp_properties.json configuration the
 * extension generates (same shared module), then compile test code with the
 * REAL cross compiler using precisely the config's compiler, args, defines,
 * includes and forced include (-fsyntax-only). If the compiler resolves every
 * built-in symbol under those settings, cpptools will too.
 *
 * Test groups:
 *   1. Config sanity      - every generated path exists on disk
 *   2. Built-in symbols   - pinMode, Serial, String, math, interrupts, etc.
 *   3. Platform libraries - Wire, SPI, EEPROM, SoftwareSerial headers resolve
 *   4. Demo sketches      - the repo's demo .ino files compile cleanly
 *   5. Real errors        - a genuine mistake still fails (no false negatives)
 *
 * Usage: npm run test:intellisense   (requires arduino-cli + arduino:avr core)
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXTENSION_ROOT, "..");
const FQBN = process.env.TEST_FQBN || "arduino:avr:uno";

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Setup: bundle the shared config builder and get real board properties
// ---------------------------------------------------------------------------

function bundleConfigModule() {
  const outFile = path.join(
    os.tmpdir(),
    `intellisenseConfig-${Date.now()}.mjs`,
  );
  execFileSync(
    "npx",
    [
      "esbuild",
      path.join(EXTENSION_ROOT, "src", "config", "intellisenseConfig.ts"),
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--outfile=${outFile}`,
    ],
    { cwd: EXTENSION_ROOT, stdio: "pipe" },
  );
  return outFile;
}

function getBoardDetails(fqbn) {
  const stdout = execFileSync(
    "arduino-cli",
    ["board", "details", "--fqbn", fqbn, "--format", "json"],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

/**
 * Expand config includePath entries into concrete -I directories:
 * - drops ${workspaceFolder} entries (workspace sources, not needed here)
 * - expands "<dir>/**" globs one level, preferring each library's src/
 *   (or utility/) folder like the Arduino build system does
 */
function expandIncludeDirs(includePath) {
  const dirs = [];
  for (const entry of includePath) {
    if (entry.startsWith("${workspaceFolder}")) continue;
    if (entry.endsWith(`${path.sep}**`) || entry.endsWith("/**")) {
      const base = entry.replace(/[\/\\]\*\*$/, "");
      if (!fs.existsSync(base)) continue;
      for (const child of fs.readdirSync(base, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const libDir = path.join(base, child.name);
        const srcDir = path.join(libDir, "src");
        dirs.push(fs.existsSync(srcDir) ? srcDir : libDir);
        const utilityDir = path.join(libDir, "utility");
        if (fs.existsSync(utilityDir)) dirs.push(utilityDir);
      }
    } else if (fs.existsSync(entry)) {
      dirs.push(entry);
    }
  }
  return dirs;
}

/** Run the config's compiler in syntax-only mode over a source string. */
function syntaxCheck(cfg, source, { extraArgs = [] } = {}) {
  const tmpFile = path.join(os.tmpdir(), `intellisense-test-${Date.now()}.cpp`);
  fs.writeFileSync(tmpFile, source);
  const args = [
    ...cfg.compilerArgs,
    ...cfg.defines.map((d) => `-D${d}`),
    ...expandIncludeDirs(cfg.includePath).map((d) => `-I${d}`),
    ...cfg.forcedInclude.map((f) => `-include${f}`),
    "-x",
    "c++",
    "-std=gnu++11",
    "-fsyntax-only",
    ...extraArgs,
    tmpFile,
  ];
  try {
    execFileSync(cfg.compilerPath, args, { encoding: "utf8", stdio: "pipe" });
    return { success: true, output: "" };
  } catch (error) {
    return {
      success: false,
      output: (error.stderr || error.stdout || error.message).toString(),
    };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Test sources
// ---------------------------------------------------------------------------

// Exercises the Arduino language reference built-ins. No #include on
// purpose: the forced include must provide Arduino.h, as it does for .ino.
const BUILTIN_SYMBOLS_SOURCE = `
void isrHandler() {}

void setup() {
  // Digital I/O
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  int v = digitalRead(2);

  // Analog I/O
  int a = analogRead(A0);
  analogWrite(3, 128);
  analogReference(DEFAULT);

  // Serial (register-guarded on AVR - the regression this suite exists for)
  Serial.begin(115200);
  Serial.print("value: ");
  Serial.println(a);
  Serial.write('!');
  Serial.flush();

  // Time
  delay(1);
  delayMicroseconds(10);
  unsigned long t = millis() + micros();

  // Tone / pulse / shift
  tone(4, 440, 100);
  noTone(4);
  unsigned long p = pulseIn(5, HIGH, 1000);
  shiftOut(6, 7, MSBFIRST, 0x55);
  byte sIn = shiftIn(6, 7, LSBFIRST);

  // Math
  long m = map(v, 0, 1023, 0, 255);
  int c = constrain(v, 0, 100);
  int lo = min(1, 2);
  int hi = max(1, 2);
  double num = sin(1.0) + cos(1.0) + tan(1.0) + sqrt(2.0) + pow(2.0, 3.0);
  int absolute = abs(-5);
  long squared = sq(4);

  // Random
  randomSeed(a);
  long r = random(10) + random(1, 10);

  // Bits and bytes
  int bits = bitRead(v, 1);
  bitWrite(v, 1, 1);
  bitSet(v, 2);
  bitClear(v, 2);
  int lb = lowByte(m);
  int hb = highByte(m);
  unsigned int b = bit(3);
  word w = word(1, 2);

  // Characters
  bool chars = isAlpha('a') && isDigit('1') && isSpace(' ') &&
               isAlphaNumeric('b') && isUpperCase('C') && isLowerCase('d');

  // Interrupts
  attachInterrupt(digitalPinToInterrupt(2), isrHandler, RISING);
  detachInterrupt(digitalPinToInterrupt(2));
  noInterrupts();
  interrupts();

  // String class
  String s = String("hello ") + String(42) + String(3.14, 2);
  s.toUpperCase();
  s.trim();
  unsigned int len = s.length();
  int idx = s.indexOf('l');
  bool eq = s.equals("HELLO 423.14");
  char buf[32];
  s.toCharArray(buf, sizeof(buf));

  // Suppress unused warnings
  (void)v; (void)a; (void)t; (void)p; (void)sIn; (void)m; (void)c; (void)lo;
  (void)hi; (void)num; (void)absolute; (void)squared; (void)r; (void)bits;
  (void)lb; (void)hb; (void)b; (void)w; (void)chars; (void)len; (void)idx;
  (void)eq; (void)buf;
}

void loop() {
  if (Serial.available() > 0) {
    int inByte = Serial.read();
    int peeked = Serial.peek();
    (void)inByte; (void)peeked;
  }
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
}
`;

// Platform-bundled libraries must resolve through the libraries/** glob.
const PLATFORM_LIBS_SOURCE = `
#include <Wire.h>
#include <SPI.h>
#include <EEPROM.h>
#include <SoftwareSerial.h>

SoftwareSerial softSerial(10, 11);

void setup() {
  Wire.begin();
  Wire.beginTransmission(0x3C);
  Wire.endTransmission();
  SPI.begin();
  SPI.transfer(0x00);
  SPI.end();
  byte stored = EEPROM.read(0);
  EEPROM.write(0, stored);
  softSerial.begin(9600);
}

void loop() {}
`;

// A genuine error MUST still be reported (guards against configs so
// permissive they hide real mistakes).
const REAL_ERROR_SOURCE = `
void setup() {
  thisFunctionDoesNotExistAnywhere(42);
}
void loop() {}
`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log(`IntelliSense robustness tests (${FQBN})`);

  // Preflight: missing dependencies are a hard failure. A suite that
  // "passes" without testing anything gives false confidence in CI.
  try {
    execSync("arduino-cli version", { stdio: "pipe" });
  } catch {
    console.error(
      "FAIL: arduino-cli is not installed or not on PATH.\n" +
        "Install it first, e.g.:\n" +
        "  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh -s -- --dest-dir /usr/local/bin",
    );
    process.exit(1);
  }

  let details;
  try {
    details = getBoardDetails(FQBN);
  } catch (error) {
    console.error(
      `FAIL: 'arduino-cli board details --fqbn ${FQBN}' failed — the platform core is not installed.\n` +
        `Install it first, e.g.:\n` +
        `  arduino-cli core update-index && arduino-cli core install ${FQBN.split(":").slice(0, 2).join(":")}`,
    );
    process.exit(1);
  }

  const moduleFile = bundleConfigModule();
  const { buildIntelliSenseConfig } = await import(moduleFile);
  const { config, error } = buildIntelliSenseConfig(
    details.build_properties || [],
    { homeDir: os.homedir() },
  );

  section("1. Config generation");
  ok("config builds without error", !!config, error);
  if (!config) process.exit(1);
  const cfg = config.configurations[0];

  section("2. Config paths exist");
  ok(
    `compilerPath exists: ${cfg.compilerPath}`,
    fs.existsSync(cfg.compilerPath),
  );
  ok(
    `forcedInclude (Arduino.h) exists`,
    cfg.forcedInclude.every((f) => fs.existsSync(f)),
    cfg.forcedInclude.join(", "),
  );
  for (const entry of cfg.includePath) {
    if (entry.startsWith("${workspaceFolder}")) continue;
    const base = entry.replace(/[\/\\]\*\*$/, "");
    // The user sketchbook (~/Arduino/libraries) is created lazily on the
    // first library install; a missing dir is fine (cpptools ignores it).
    if (base === path.join(os.homedir(), "Arduino", "libraries")) {
      console.log(
        `  - include path optional (created on first lib install): ${entry}`,
      );
      continue;
    }
    ok(`include path exists: ${entry}`, fs.existsSync(base));
  }
  ok(
    "MCU compiler arg present (Serial regression guard)",
    cfg.compilerArgs.some(
      (a) => a.startsWith("-mmcu=") || a.startsWith("-mcpu="),
    ),
    JSON.stringify(cfg.compilerArgs),
  );

  section("3. Built-in Arduino symbols produce no errors");
  const builtins = syntaxCheck(cfg, BUILTIN_SYMBOLS_SOURCE);
  ok(
    "digital/analog/serial/time/math/string/interrupt built-ins all resolve",
    builtins.success,
    builtins.output.split("\n").slice(0, 8).join("\n"),
  );

  section("4. Platform libraries resolve");
  const libs = syntaxCheck(cfg, PLATFORM_LIBS_SOURCE);
  ok(
    "Wire / SPI / EEPROM / SoftwareSerial headers and APIs resolve",
    libs.success,
    libs.output.split("\n").slice(0, 8).join("\n"),
  );

  section("5. Demo sketches produce no errors");
  const demoDirs = fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("demo_"))
    .map((d) => path.join(REPO_ROOT, d.name));
  for (const demoDir of demoDirs) {
    const ino = fs.readdirSync(demoDir).find((f) => f.endsWith(".ino"));
    if (!ino) continue;
    const source = fs.readFileSync(path.join(demoDir, ino), "utf8");
    const result = syntaxCheck(cfg, source);
    // Missing headers are a hard failure: every demo shipped in this repo
    // must have its libraries installed for the suite to be meaningful.
    if (!result.success && /No such file or directory/.test(result.output)) {
      const missing = result.output.match(/fatal error:\s*([^:]+):/);
      ok(
        `${ino} has no false errors`,
        false,
        `missing library header ${missing ? missing[1] : "(unknown)"} — install it with: arduino-cli lib install <LibraryName>`,
      );
      continue;
    }
    ok(
      `${ino} has no false errors`,
      result.success,
      result.output.split("\n").slice(0, 5).join("\n"),
    );
  }

  section("6. Real errors are still reported");
  const realError = syntaxCheck(cfg, REAL_ERROR_SOURCE);
  ok("undefined function is flagged as an error", !realError.success);

  fs.rmSync(moduleFile, { force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Test runner crashed:", error);
  process.exit(1);
});
