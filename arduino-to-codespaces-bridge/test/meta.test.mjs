/**
 * Meta / Code-Quality Tests
 *
 * Enforces project-wide standards on the extension's own TypeScript source
 * (`src/**`) rather than runtime behaviour:
 *
 *   1. Lints clean     - `eslint src` reports no errors
 *   2. Type-checks     - `tsc --noEmit` reports no errors
 *   3. Docstrings      - every file, exported declaration and public class
 *                        method carries a Google-style JSDoc block
 *   4. Extension best  - strict TS, activate/deactivate exported, every
 *      practices         contributed command is registered in code, no stray
 *                        console.log, correct main/engines fields
 *
 * These guard the "self-documenting, lints, idiomatic VS Code extension"
 * conventions so regressions fail fast in CI.
 *
 * Usage: npm run test:meta   (no arduino-cli or hardware required)
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(EXTENSION_ROOT, "src");

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

/** Recursively collect authored .ts files (excludes .d.ts). */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(EXTENSION_ROOT, p);

/**
 * Return true if the non-blank line immediately above `index` closes a JSDoc
 * block comment (`*/`). Decorator lines (@Something) are skipped.
 */
function hasJsDocAbove(lines, index) {
  let i = index - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("@")) {
      i--;
      continue;
    }
    return trimmed.endsWith("*/");
  }
  return false;
}

// Control-flow keywords that look like a call but are not methods.
const NON_METHOD_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "else",
  "do",
  "case",
  "new",
  "delete",
  "typeof",
  "void",
  "await",
  "yield",
  "super",
  "this",
  "function",
  "constructor",
]);

// Framework interface methods that are self-evident overrides.
const METHOD_DOC_ALLOWLIST = new Set([
  "getTreeItem",
  "getChildren",
  "getParent",
  "resolveTreeItem",
  "dispose",
]);

const METHOD_RE =
  /^ {2}(?:public |private |protected |static |readonly |abstract |override |async |get |set )*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;

const EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|const|type|enum)\s+([A-Za-z_$][\w$]*)/;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("Meta / code-quality tests (src/**)");

const tsFiles = collectTsFiles(SRC_ROOT);

// 1. Lint -------------------------------------------------------------------
section("1. Source lints clean");
{
  let lintOk = true;
  let detail = "";
  try {
    execFileSync("npx", ["eslint", "src", "--ext", "ts", "--max-warnings=0"], {
      cwd: EXTENSION_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    lintOk = false;
    detail = (error.stdout || error.stderr || error.message)
      .toString()
      .split("\n")
      .filter(Boolean)
      .slice(0, 12)
      .join("\n");
  }
  ok("eslint src --max-warnings=0 passes", lintOk, detail);
}

// 2. Type-check -------------------------------------------------------------
section("2. Source type-checks");
{
  let tscOk = true;
  let detail = "";
  try {
    execFileSync("npx", ["tsc", "-p", ".", "--noEmit"], {
      cwd: EXTENSION_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    tscOk = false;
    detail = (error.stdout || error.stderr || error.message)
      .toString()
      .split("\n")
      .filter(Boolean)
      .slice(0, 12)
      .join("\n");
  }
  ok("tsc --noEmit passes", tscOk, detail);
}

// 3. Docstrings -------------------------------------------------------------
section("3. Google-style JSDoc coverage");

const missingHeaders = [];
const missingExportDocs = [];
const missingMethodDocs = [];

for (const file of tsFiles) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  // 3a. File-header docstring: first non-blank line opens a block comment.
  const firstCode = lines.find((l) => l.trim() !== "");
  if (!firstCode || !firstCode.trim().startsWith("/**")) {
    missingHeaders.push(rel(file));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 3b. Exported declarations.
    const exportMatch = EXPORT_RE.exec(line);
    if (exportMatch && !hasJsDocAbove(lines, i)) {
      missingExportDocs.push(`${rel(file)}:${i + 1} ${exportMatch[1]}`);
    }

    // 3c. Public class methods (implementations, not interface signatures).
    const methodMatch = METHOD_RE.exec(line);
    if (methodMatch) {
      const name = methodMatch[1];
      const trimmed = line.trim();
      const isSignatureOnly = trimmed.endsWith(";");
      if (
        !isSignatureOnly &&
        !NON_METHOD_KEYWORDS.has(name) &&
        !METHOD_DOC_ALLOWLIST.has(name) &&
        !hasJsDocAbove(lines, i)
      ) {
        missingMethodDocs.push(`${rel(file)}:${i + 1} ${name}()`);
      }
    }
  }
}

ok(
  "every source file has a header docstring",
  missingHeaders.length === 0,
  missingHeaders.join(", "),
);
ok(
  "every exported declaration has a JSDoc block",
  missingExportDocs.length === 0,
  missingExportDocs.join("\n     "),
);
ok(
  "every public class method has a JSDoc block",
  missingMethodDocs.length === 0,
  missingMethodDocs.join("\n     "),
);

// 4. VS Code extension best practices ---------------------------------------
section("4. VS Code extension best practices");

const tsconfig = JSON.parse(
  fs.readFileSync(path.join(EXTENSION_ROOT, "tsconfig.json"), "utf8"),
);
ok(
  'tsconfig has "strict": true',
  tsconfig.compilerOptions?.strict === true,
  "enable strict type-checking",
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8"),
);
ok(
  'package.json "main" points to ./dist/extension.js',
  pkg.main === "./dist/extension.js",
  `found ${pkg.main}`,
);
ok(
  "package.json declares an engines.vscode range",
  typeof pkg.engines?.vscode === "string" && pkg.engines.vscode.length > 0,
);

const extensionTs = fs.readFileSync(
  path.join(SRC_ROOT, "extension.ts"),
  "utf8",
);
ok(
  "extension.ts exports activate()",
  /export\s+(?:async\s+)?function\s+activate\b/.test(extensionTs),
);
ok(
  "extension.ts exports deactivate()",
  /export\s+function\s+deactivate\b/.test(extensionTs),
);

// Every contributed command must be registered somewhere in src.
const contributedCommands = (pkg.contributes?.commands || []).map(
  (c) => c.command,
);
const allSrc = tsFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const unregistered = contributedCommands.filter(
  (id) => !allSrc.includes(`registerCommand("${id}"`),
);
ok(
  "every contributed command is registered in code",
  unregistered.length === 0,
  unregistered.join(", "),
);

// Extensions should log via an OutputChannel, not console.log.
const consoleLogHits = [];
for (const file of tsFiles) {
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, idx) => {
      if (/\bconsole\.log\s*\(/.test(line)) {
        consoleLogHits.push(`${rel(file)}:${idx + 1}`);
      }
    });
}
ok(
  "no console.log in source (use OutputChannel)",
  consoleLogHits.length === 0,
  consoleLogHits.join(", "),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
