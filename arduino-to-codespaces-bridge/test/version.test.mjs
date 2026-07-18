/**
 * Version Consistency Tests
 *
 * The extension has a single source of truth for its version: the `version`
 * field in package.json. Everything else must either (a) contain that exact
 * literal where a literal is unavoidable (CHANGELOG entry, the VSIX filename in
 * the install task), or (b) derive the value from package.json at build/run
 * time so it can never drift (both servers, the web client, Vite).
 *
 * This suite fails if any location is stale or if a hardcoded version literal
 * is reintroduced into the server/client, which would silently defeat the
 * client<->server mismatch banner.
 *
 * Test groups:
 *   1. Canonical version  - package.json version is valid semver
 *   2. Literal locations  - CHANGELOG + install task reference the version
 *   3. Wired locations     - servers/client/Vite derive from package.json
 *
 * Usage: npm run test:version   (no arduino-cli or hardware required)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXTENSION_ROOT, "..");

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

/** Read a repo file as UTF-8, relative to the extension root. */
function read(relPath) {
  return fs.readFileSync(path.join(EXTENSION_ROOT, relPath), "utf8");
}

/** Read a repo file as UTF-8, relative to the repository root. */
function readRepo(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const pkg = JSON.parse(read("package.json"));
const VERSION = pkg.version;

console.log(`Version consistency tests (canonical: ${VERSION})`);

// 1. Canonical version -------------------------------------------------------
section("1. Canonical version");
ok(
  `package.json version is valid semver: ${VERSION}`,
  /^\d+\.\d+\.\d+$/.test(VERSION),
  "expected MAJOR.MINOR.PATCH",
);

// 2. Literal locations -------------------------------------------------------
section("2. Literal locations reference the canonical version");

// CHANGELOG must document this version, and it must be the newest entry.
// Same-day iterations may be grouped as "## [a.b.c - x.y.z]" - the current
// version must then be the END of the newest range.
const changelog = read("CHANGELOG.md");
const V = VERSION.replace(/\./g, "\\.");
ok(
  `CHANGELOG.md has a "## [${VERSION}]" (or grouped "## [... - ${VERSION}]") section`,
  new RegExp(`^##\\s*\\[(\\d+\\.\\d+\\.\\d+\\s*-\\s*)?${V}\\]`, "m").test(
    changelog,
  ),
  "add a changelog entry for the new version",
);
const firstChangelogVersion = changelog.match(
  /^##\s*\[(?:\d+\.\d+\.\d+\s*-\s*)?(\d+\.\d+\.\d+)\]/m,
);
ok(
  `newest CHANGELOG entry is ${VERSION}`,
  firstChangelogVersion && firstChangelogVersion[1] === VERSION,
  firstChangelogVersion
    ? `newest entry is ${firstChangelogVersion[1]}`
    : "no versioned entry found",
);

// The install task installs the packaged VSIX by filename.
const tasks = readRepo(".vscode/tasks.json");
ok(
  `install task references arduino-to-codespaces-bridge-${VERSION}.vsix`,
  tasks.includes(`arduino-to-codespaces-bridge-${VERSION}.vsix`),
  "update the Install Extension task's VSIX filename",
);
const staleVsix = tasks.match(
  /arduino-to-codespaces-bridge-(\d+\.\d+\.\d+)\.vsix/g,
);
ok(
  "install task has no stale VSIX filename",
  !staleVsix || staleVsix.every((m) => m.includes(`-${VERSION}.vsix`)),
  staleVsix ? staleVsix.join(", ") : "",
);

// 3. Wired locations (must derive from package.json, never hardcode) ---------
section("3. Dynamic locations derive from package.json");

// A quoted 3-part version literal assigned to a *_VERSION constant is the
// drift hazard we are guarding against.
const HARDCODED_VERSION_CONST =
  /(SERVER_VERSION|CLIENT_VERSION)\s*=\s*["']\d+\.\d+\.\d+["']/;

const extServer = read("src/server/index.ts");
ok(
  "extension server does not hardcode a SERVER_VERSION literal",
  !HARDCODED_VERSION_CONST.test(extServer),
  "read the version from package.json instead",
);
ok(
  "extension server resolves the version from package.json",
  /packageJSON\?\.version|package\.json/.test(extServer) &&
    /resolveExtensionVersion/.test(extServer),
  "expected resolveExtensionVersion() reading package.json",
);

const devServer = read("web-client/server.js");
ok(
  "dev server does not hardcode a SERVER_VERSION literal",
  !HARDCODED_VERSION_CONST.test(devServer),
  "read the version from ../package.json instead",
);
ok(
  "dev server reads the version from ../package.json",
  /SERVER_VERSION\s*=\s*JSON\.parse\([\s\S]*package\.json/.test(devServer),
  "expected SERVER_VERSION derived from ../package.json",
);

const viteConfig = read("web-client/vite.config.js");
ok(
  "vite config injects __APP_VERSION__ from package.json",
  /__APP_VERSION__/.test(viteConfig) && /package\.json/.test(viteConfig),
  "expected define.__APP_VERSION__ sourced from ../package.json",
);

const client = read("web-client/src/client/main.js");
ok(
  "client does not hardcode a CLIENT_VERSION literal",
  !HARDCODED_VERSION_CONST.test(client),
  "use the injected __APP_VERSION__ instead",
);
ok(
  "client uses the injected __APP_VERSION__",
  /CLIENT_VERSION\s*=\s*__APP_VERSION__/.test(client),
  "expected CLIENT_VERSION = __APP_VERSION__",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
