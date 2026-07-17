/**
 * API contract tests.
 *
 * The web client (web-client/src/client/main.js) and the extension server
 * (src/server/index.ts) talk over HTTP with no shared type definitions, so a
 * field rename on one side silently breaks the other. This is exactly what
 * happened when the client read `sketch.relativePath` while the server returned
 * `sketch.path`: every option value became the string "undefined" and compiles
 * failed with `Compiling sketch: 'undefined'`.
 *
 * These tests assert the contracts are absolute: for every server response the
 * client iterates, every property the client reads MUST be a field the server
 * actually emits (the server DTO interface) or a field the client explicitly
 * synthesises itself. They also assert the request bodies line up.
 *
 * Static, dependency-free analysis (no server boot required).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SERVER_SRC = path.join(ROOT, "src", "server", "index.ts");
const CLIENT_SRC = path.join(ROOT, "web-client", "src", "client", "main.js");

const server = fs.readFileSync(SERVER_SRC, "utf8");
const client = fs.readFileSync(CLIENT_SRC, "utf8");

let passed = 0;
let failed = 0;

/**
 * Record the outcome of a single assertion.
 *
 * @param name Human-readable description of the assertion.
 * @param condition Whether the assertion passed.
 * @param detail Optional extra context shown when the assertion fails.
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
 *
 * @param title The section title.
 */
function section(title) {
  console.log(`\n${title}`);
}

/**
 * Parse the field names declared by a TypeScript interface in the given source.
 *
 * @param src TypeScript source text.
 * @param name The interface name to parse.
 * @returns The declared field names, or null if the interface is not found.
 */
function parseInterfaceFields(src, name) {
  const match = src.match(new RegExp(`interface\\s+${name}\\s*\\{([^}]*)\\}`));
  if (!match) {
    return null;
  }
  return [...match[1].matchAll(/^\s*([A-Za-z_][\w]*)\??\s*:/gm)].map(
    (m) => m[1],
  );
}

/**
 * Extract every `.forEach(...)`/`.map(...)` call span iterating an array.
 *
 * Scans from the iterator's opening parenthesis to its balanced close, so the
 * returned text covers the whole callback body.
 *
 * @param src Source text to scan.
 * @param arrayVar The array expression before `.forEach`/`.map`.
 * @returns The text of each iterator call, including the callback body.
 */
function iteratorSpans(src, arrayVar) {
  const spans = [];
  const header = new RegExp(
    `${arrayVar}\\s*\\.\\s*(?:forEach|map)\\s*\\(`,
    "g",
  );
  let m;
  while ((m = header.exec(src))) {
    let depth = 0;
    const start = header.lastIndex - 1; // index of the opening '('
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          spans.push(src.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * Collect the property names read from an object alias within some source.
 *
 * @param src Source text to scan.
 * @param alias The object variable name (e.g. "sketch").
 * @returns The set of property names accessed as `alias.<prop>`.
 */
function propsAccessed(src, alias) {
  const props = new Set();
  const re = new RegExp(`\\b${alias}\\.([A-Za-z_][\\w]*)`, "g");
  let m;
  while ((m = re.exec(src))) {
    props.add(m[1]);
  }
  return props;
}

/**
 * Collect the property names the client assigns onto an object alias
 * (`alias.<prop> = ...`), i.e. fields the client synthesises itself.
 *
 * @param src Source text to scan.
 * @param alias The object variable name.
 * @returns The set of assigned property names.
 */
function propsAssigned(src, alias) {
  const props = new Set();
  const re = new RegExp(`\\b${alias}\\.([A-Za-z_][\\w]*)\\s*=(?!=)`, "g");
  let m;
  while ((m = re.exec(src))) {
    props.add(m[1]);
  }
  return props;
}

// ---------------------------------------------------------------------------
// Response contracts: what the client reads must be what the server emits.
// ---------------------------------------------------------------------------

/**
 * Response DTO contracts. Each entry pins a server response element type to the
 * client aliases that iterate it. `fields` overrides interface parsing for
 * responses assembled inline (not declared as an interface).
 */
const RESPONSE_CONTRACTS = [
  {
    label: "/api/sketches items (SketchInfo)",
    serverInterface: "SketchInfo",
    fields: null,
    aliases: ["sketch"],
  },
  {
    label: "/api/boards items (BoardInfo + client merge)",
    serverInterface: "BoardInfo",
    fields: null,
    aliases: ["board", "selectedBoard", "connectedBoard"],
  },
  {
    label: "/api/cli/libraries/:name/examples items",
    serverInterface: null,
    fields: ["name", "path"],
    aliases: ["example"],
  },
];

section("1. Response contracts (client reads \u2286 server emits)");

for (const contract of RESPONSE_CONTRACTS) {
  const serverFields = contract.serverInterface
    ? parseInterfaceFields(server, contract.serverInterface)
    : contract.fields;

  ok(
    `${contract.label}: server declares its fields`,
    Array.isArray(serverFields) && serverFields.length > 0,
    contract.serverInterface
      ? `interface ${contract.serverInterface} not found`
      : "no fields configured",
  );

  if (!Array.isArray(serverFields)) {
    continue;
  }

  // Fields the client legitimately synthesises after receiving the response
  // (e.g. merging VID/PID from boards.json onto a board object).
  const clientAdded = new Set();
  for (const alias of contract.aliases) {
    for (const p of propsAssigned(client, alias)) {
      clientAdded.add(p);
    }
  }

  const allowed = new Set([...serverFields, ...clientAdded]);

  const violations = [];
  for (const alias of contract.aliases) {
    for (const prop of propsAccessed(client, alias)) {
      if (!allowed.has(prop)) {
        violations.push(`${alias}.${prop}`);
      }
    }
  }

  ok(
    `${contract.label}: client only reads emitted fields`,
    violations.length === 0,
    violations.length
      ? `unknown field(s): ${violations.join(", ")} (allowed: ${[...allowed].join(", ")})`
      : "",
  );
}

// ---------------------------------------------------------------------------
// Request contracts: the body the client posts must be what the server reads.
// ---------------------------------------------------------------------------

section("2. Request contracts (client sends \u2286 server reads)");

// /api/compile: client sends { path, fqbn }; server reads req.body.path
// (or sketchPath) and fqbn.
ok(
  "/api/compile: client posts a `path` field",
  /JSON\.stringify\(\{\s*path\s*:/.test(client),
);
ok(
  "/api/compile: server reads `req.body.path`",
  server.includes("req.body.path"),
);
ok(
  "/api/compile: client posts an `fqbn` field",
  /JSON\.stringify\(\{[^}]*fqbn/.test(client),
);
ok(
  "/api/compile: server reads `fqbn` from the body",
  /const\s*\{\s*fqbn\s*\}\s*=\s*req\.body/.test(server),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
