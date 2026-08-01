/**
 * Arduino Bridge Server Module
 *
 * Express server that provides a REST API for Arduino development operations.
 * This module is the backbone of the VS Code extension, enabling compile and
 * upload workflows from GitHub Codespaces to physical Arduino boards.
 *
 * Features:
 * - **Arduino CLI Integration**: Wraps arduino-cli commands for compile, board
 *   management, and library management operations
 * - **Static File Serving**: Hosts the web client for browser-based serial
 *   communication (required for WebSerial API access)
 * - **Sketch Management**: Discovers and lists Arduino sketches in the workspace
 * - **Board/Core Management**: Install, upgrade, and uninstall Arduino platforms
 * - **Library Management**: Search, install, upgrade, and uninstall libraries
 * - **Environment Sync**: Maintains arduino-bridge.config.json with installed
 *   platforms and libraries for reproducible environments
 *
 * API Endpoints:
 * - GET  /api/health - Server health check
 * - GET  /api/version - Server version info
 * - GET  /api/boards - List available boards
 * - GET  /api/sketches - List sketches in workspace
 * - POST /api/compile - Compile a sketch
 * - GET  /api/hex/:sketchName - Download compiled firmware
 * - GET  /api/cli/health - Check arduino-cli availability
 * - GET  /api/cli/cores/* - Core/platform management endpoints
 * - GET  /api/cli/libraries/* - Library management endpoints
 *
 * @module server
 * @version 1.0.18
 */

import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import express, { Application, Request, Response, NextFunction } from "express";
import { spawn, ChildProcess, exec } from "child_process";
import { buildIntelliSenseConfig } from "../config/intellisenseConfig";
import {
  analyzeCompileError,
  analyzeCompileErrors,
} from "./compileErrorAnalyzer";

// =============================================================================
// Types
// =============================================================================

interface CompileResult {
  success: boolean;
  hexPath?: string;
  output?: string[];
  error?: string;
  fqbn?: string;
  sketchPath?: string;
}

interface BoardInfo {
  fqbn: string;
  name: string;
  protocol?: string;
  uploadTool?: string;
}

interface SketchInfo {
  name: string;
  path: string;
  fullPath: string;
}

interface CliCommandResult {
  success: boolean;
  data?: any;
  log: string;
  rawOutput?: string;
  duration: number;
  error?: string;
}

interface IndexStatus {
  lastUpdate: string | null;
  ageSeconds: number | null;
  needsRefresh: boolean;
}

interface MissingInclude {
  header: string;
  query: string;
  isLibraryInclude: boolean | null;
  suggestions: Array<{
    name: string;
    latestVersion?: string;
    author?: string;
  }>;
}

// =============================================================================
// Constants
// =============================================================================

/** Standard C/C++ headers that should not trigger library suggestions */
const STANDARD_LIBRARY_HEADERS = new Set<string>([
  "assert",
  "arduino",
  "complex",
  "ctype",
  "errno",
  "float",
  "inttypes",
  "limits",
  "locale",
  "math",
  "setjmp",
  "signal",
  "stdarg",
  "stdbool",
  "stddef",
  "stdint",
  "stdio",
  "stdlib",
  "string",
  "time",
]);

/**
 * Pattern to detect include style from a source line:
 * #include <header.h> = library include, #include "header.h" = local file.
 */
const INCLUDE_STYLE_PATTERN = /#include\s*([<"])([^>"]+)[>"]/;

/** Patterns that identify missing-include errors in compiler output */
const MISSING_INCLUDE_PATTERNS: RegExp[] = [
  // GCC style: fatal error: Servo.h: No such file or directory
  /fatal error:\s*([^\s:]+\.h(?:pp|xx)?)\s*:\s*No such file or directory/i,
  // Clang style with quotes/angles
  /fatal error:\s*['"]([^'"]+)['"]\s*file not found/i,
  /error:\s*['"]([^'"]+)['"]\s*file not found/i,
  // Generic fallback
  /No such file or directory[:]?\s*['"]?([^'":\s]+\.h(?:pp|xx)?)['"]?/i,
];

/**
 * Normalize a library name for comparison (lowercase, alphanumeric only).
 * @param name - Library name to normalize
 * @returns Normalized name
 */
function normalizeLibraryName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// =============================================================================
// BridgeServer Class
// =============================================================================

/**
 * Arduino Bridge Server for VS Code Extension
 *
 * Emits:
 * - "environmentChanged" after platform/library install/uninstall operations,
 *   so the extension can sync the requirements file.
 */
export class BridgeServer extends EventEmitter {
  private app: Application;
  private server: http.Server | undefined;
  private port: number;
  private running: boolean = false;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private workspaceRoot: string;
  private buildRoot: string;
  private cliPath: string = "arduino-cli";
  private activeProcesses: Set<ChildProcess> = new Set();
  private lastCoreIndexUpdate?: number;
  private lastLibraryIndexUpdate?: number;
  private cachedBoardUrls: string[] = [];
  /**
   * Learned device mappings: "0xVVVV:0xPPPP" -> FQBN, proven by a
   * successful upload. Seeded from arduino-requirements.txt at sync time;
   * persisted back to the file by the environment sync controller.
   */
  private learnedDevices: Map<string, string> = new Map();
  /**
   * Server version, tracking the extension's published version (single source
   * of truth: package.json). The web client is built with the same value, so
   * client and server always match for a given build — a mismatch therefore
   * reliably indicates a stale cached client.
   */
  private readonly serverVersion: string;

  /**
   * Create a new BridgeServer instance
   * @param context - VS Code extension context
   * @param outputChannel - Output channel for logging
   */
  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
  ) {
    super();
    this.context = context;
    this.outputChannel = outputChannel;
    this.app = express();

    // Resolve the build version from package.json (single source of truth).
    this.serverVersion = this.resolveExtensionVersion(context);

    const config = vscode.workspace.getConfiguration("arduinoBridge");
    this.port = config.get("serverPort") || 3000;

    // Prefer the arduino-cli bundled with the extension; fall back to PATH
    const localBin = path.join(context.extensionPath, "bin", "arduino-cli");
    if (fs.existsSync(localBin)) {
      this.cliPath = localBin;
      this.log(`Using bundled arduino-cli: ${this.cliPath}`);
    } else {
      this.log("Using system arduino-cli");
    }

    // Set workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = workspaceFolders
      ? workspaceFolders[0].uri.fsPath
      : process.cwd();
    this.buildRoot = path.join(this.workspaceRoot, "build", "sketches");

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Resolve the extension's published version from package.json. Prefers the
   * metadata VS Code already loaded (context.extension.packageJSON), falling
   * back to reading the file directly.
   */
  private resolveExtensionVersion(context: vscode.ExtensionContext): string {
    const fromApi = context.extension?.packageJSON?.version;
    if (typeof fromApi === "string" && fromApi.length > 0) {
      return fromApi;
    }
    try {
      const pkgPath = path.join(context.extensionPath, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      /* fall through to a safe default */
    }
    return "0.0.0";
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // JSON body parsing with an explicit size cap so a hostile/broken client
    // cannot exhaust memory with a huge payload.
    this.app.use(express.json({ limit: "2mb" }));

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      this.log(`${req.method} ${req.path}`);
      next();
    });

    // Security headers + CSRF protection.
    //
    // The web client is served from THIS server, so every legitimate API call
    // is same-origin and no cross-origin access is required. We therefore:
    //  - drop the previous permissive CORS policy (Access-Control-Allow-Origin:
    //    "*"), which allowed any website to read API responses such as the
    //    workspace sketch listing;
    //  - reject state-changing requests the browser marks as cross-site. This
    //    is a CSRF defense based on the Fetch Metadata `Sec-Fetch-Site` header,
    //    which cross-site JavaScript cannot forge and which the Codespaces
    //    port-forwarding proxy preserves (unlike Host, which it may rewrite);
    //  - block framing to prevent clickjacking. The app is only ever used in an
    //    external Chromium browser, because WebSerial/WebUSB (required for
    //    uploads) are unavailable inside VS Code's Simple Browser, so this
    //    never interferes with normal use.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

      const method = req.method.toUpperCase();
      const mutating =
        method === "POST" ||
        method === "PUT" ||
        method === "PATCH" ||
        method === "DELETE";

      if (mutating && req.headers["sec-fetch-site"] === "cross-site") {
        this.log(`Blocked cross-site ${method} ${req.path}`);
        res.status(403).json({
          success: false,
          error: "Cross-site requests are not allowed",
        });
        return;
      }

      next();
    });
  }

  /**
   * Validate a value before passing it to arduino-cli as an argument.
   *
   * Arguments are always passed as an argv array (spawn without a shell), so
   * shell metacharacters are already inert. This additionally rejects values
   * that begin with "-" (which arduino-cli could misinterpret as a flag —
   * "argument injection") and values containing control characters or NUL.
   */
  private isSafeCliArg(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      !value.startsWith("-") &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f]/.test(value)
    );
  }

  /**
   * Execute an arduino-cli command and capture structured output
   */
  private runCliCommand(
    args: string[],
    options: { addJson?: boolean; timeoutMs?: number } = {},
  ): Promise<CliCommandResult> {
    const { addJson = true, timeoutMs = 120_000 } = options;
    const cliArgs = addJson ? [...args, "--format", "json"] : [...args];

    return new Promise<CliCommandResult>((resolve) => {
      const start = Date.now();
      const child = spawn(this.cliPath, cliArgs, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeProcesses.add(child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const finalize = (partial: Partial<CliCommandResult>): void => {
        const duration = (Date.now() - start) / 1000;
        this.activeProcesses.delete(child);
        resolve({
          success: false,
          log: stderr || stdout,
          rawOutput: stdout,
          duration,
          ...partial,
        });
      };

      const timeoutId =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill("SIGTERM");
              } catch (error) {
                this.log(`Failed to kill arduino-cli process: ${error}`);
              }
            }, timeoutMs)
          : undefined;

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        finalize({
          success: false,
          log: error.message,
          error: error.message,
        });
      });

      child.on("close", (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (timedOut) {
          finalize({
            success: false,
            log: `Command timed out after ${timeoutMs}ms`,
            error: "arduino-cli timed out",
          });
          return;
        }

        if (code === 0) {
          let data: any;
          if (addJson) {
            try {
              data = JSON.parse(stdout);
            } catch (error: any) {
              this.log(
                `Failed to parse JSON output for command ${cliArgs.join(
                  " ",
                )}: ${error?.message || error}`,
              );
            }
          }

          finalize({
            success: true,
            data,
            log: stderr || stdout,
            rawOutput: stdout,
            error: undefined,
          });
        } else {
          const message =
            stderr || stdout || `arduino-cli exited with code ${code}`;
          finalize({
            success: false,
            log: message,
            error: message,
          });
        }
      });
    });
  }

  /**
   * Build index freshness metadata from the last update timestamp
   */
  private buildIndexStatus(lastUpdate?: number): IndexStatus {
    if (!lastUpdate) {
      return {
        lastUpdate: null,
        ageSeconds: null,
        needsRefresh: true,
      };
    }

    const ageSeconds = Math.floor((Date.now() - lastUpdate) / 1000);
    return {
      lastUpdate: new Date(lastUpdate).toISOString(),
      ageSeconds,
      needsRefresh: ageSeconds > 86_400,
    };
  }

  /**
   * Compare two dotted version strings numerically.
   *
   * @param a First version string.
   * @param b Second version string.
   * @returns Negative if a < b, positive if a > b, zero if equal.
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map((value) => parseInt(value, 10) || 0);
    const partsB = b.split(".").map((value) => parseInt(value, 10) || 0);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const aPart = partsA[i] || 0;
      const bPart = partsB[i] || 0;
      if (aPart !== bPart) {
        return aPart - bPart;
      }
    }
    return 0;
  }

  /**
   * Scan compiler output for missing-header errors and suggest installable
   * libraries for each one (skipping headers from libraries that are already
   * installed and standard C/C++ headers).
   *
   * @param compileLog Full compiler output.
   * @returns Missing include descriptors with Library Manager suggestions.
   */
  private async detectMissingIncludes(
    compileLog: string,
  ): Promise<MissingInclude[]> {
    if (!compileLog) {
      return [];
    }

    const lines = compileLog.split(/\r?\n/);
    const missingHeaders = new Map<
      string,
      { header: string; baseName: string; isLibraryInclude: boolean | null }
    >();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of MISSING_INCLUDE_PATTERNS) {
        const match = line.match(pattern);
        if (!match || !match[1]) {
          continue;
        }
        const rawHeader = match[1].trim();
        const headerName = path.basename(rawHeader);
        const baseName = headerName.replace(/\.(h|hh|hpp|hxx)$/i, "");
        const normalizedBase = normalizeLibraryName(baseName);

        // Determine include style (<lib.h> vs "file.h") from nearby source
        // context lines that GCC echoes with the error.
        let isAngleBracket: boolean | null = null;
        for (
          let j = Math.max(0, i - 2);
          j < Math.min(lines.length, i + 3);
          j++
        ) {
          const includeMatch = lines[j].match(INCLUDE_STYLE_PATTERN);
          if (includeMatch && lines[j].includes(rawHeader)) {
            isAngleBracket = includeMatch[1] === "<";
            break;
          }
        }

        if (!baseName || normalizedBase.length < 2) {
          break;
        }
        if (STANDARD_LIBRARY_HEADERS.has(normalizedBase)) {
          break;
        }

        missingHeaders.set(normalizedBase, {
          header: rawHeader,
          baseName,
          isLibraryInclude: isAngleBracket,
        });
        break;
      }
    }

    if (missingHeaders.size === 0) {
      return [];
    }

    // Skip headers whose library is already installed
    let installedNormalized = new Set<string>();
    try {
      const listResult = await this.runCliCommand(["lib", "list"], {
        addJson: true,
        timeoutMs: 15_000,
      });
      if (listResult.success && listResult.data) {
        const installed = Array.isArray(listResult.data.installed_libraries)
          ? listResult.data.installed_libraries
          : [];
        installedNormalized = new Set(
          installed
            .map((item: any) =>
              normalizeLibraryName((item.library || item).name || ""),
            )
            .filter(Boolean),
        );
      }
    } catch {
      /* best-effort - suggestions still useful without installed list */
    }

    const results: MissingInclude[] = [];
    for (const [normalizedBase, info] of missingHeaders.entries()) {
      if (installedNormalized.has(normalizedBase)) {
        continue;
      }

      let suggestions: MissingInclude["suggestions"] = [];
      if (info.isLibraryInclude !== false && this.isSafeCliArg(info.baseName)) {
        try {
          const searchResult = await this.runCliCommand(
            ["lib", "search", info.baseName],
            { addJson: true, timeoutMs: 20_000 },
          );
          if (searchResult.success && searchResult.data) {
            const libraries = Array.isArray(searchResult.data.libraries)
              ? searchResult.data.libraries
              : [];
            suggestions = libraries.slice(0, 3).map((lib: any) => ({
              name: lib.name,
              latestVersion:
                lib.latest?.version || lib.latest_version || undefined,
              author: lib.latest?.author || lib.author || undefined,
            }));
          }
        } catch {
          /* suggestions are best-effort */
        }
      }

      results.push({
        header: info.header,
        query: info.baseName,
        isLibraryInclude: info.isLibraryInclude,
        suggestions,
      });
    }

    return results;
  }

  /**
   * Normalize a raw arduino-cli platform record into the shape used by the UI.
   *
   * @param platform Raw platform object from arduino-cli JSON output.
   * @returns The transformed platform, or the input unchanged if falsy.
   */
  private transformPlatform(platform: any): any {
    if (!platform) {
      return platform;
    }

    const latestVersion = platform.latest_version || platform.latest;
    const installedVersion = platform.installed_version || platform.installed;
    const releases = platform.releases || {};
    const latestRelease = (latestVersion && releases[latestVersion]) || {};

    return {
      id: platform.id,
      name: latestRelease.name || platform.name || platform.id,
      maintainer: platform.maintainer || "Unknown",
      website: platform.website || null,
      installedVersion: installedVersion || null,
      latestVersion: latestVersion || null,
      hasUpdate:
        !!installedVersion &&
        !!latestVersion &&
        installedVersion !== latestVersion,
      boards: Array.isArray(latestRelease.boards)
        ? latestRelease.boards.map((board: any) => ({
            name: board.name,
            fqbn: board.fqbn,
          }))
        : [],
      versions: Object.keys(releases)
        .sort((a, b) => this.compareVersions(b, a))
        .filter(Boolean),
      indexed: platform.indexed !== false,
    };
  }

  /**
   * Normalize a raw arduino-cli library record into the shape used by the UI.
   *
   * @param library Raw library object from arduino-cli JSON output.
   * @returns The transformed library, or the input unchanged if falsy.
   */
  private transformLibrary(library: any): any {
    if (!library) {
      return library;
    }

    const releases = library.releases || {};
    const versions = Object.keys(releases)
      .sort((a, b) => this.compareVersions(b, a))
      .filter(Boolean);
    const latestVersion = versions[0] || library.version;
    const latestRelease = (latestVersion && releases[latestVersion]) || {};

    return {
      name: library.name,
      latestVersion,
      versions,
      author: latestRelease.author || library.author || "Unknown",
      maintainer: latestRelease.maintainer || library.maintainer || "",
      sentence: latestRelease.sentence || library.sentence || "",
      paragraph: latestRelease.paragraph || library.paragraph || "",
      website: latestRelease.website || library.website || null,
      category: latestRelease.category || library.category || "Uncategorized",
      architectures: latestRelease.architectures || library.architectures || [],
      types: latestRelease.types || library.types || [],
      installedVersion:
        library.installedVersion || library.installed_version || null,
    };
  }

  /**
   * Translate a raw arduino-cli error log into a concise, user-friendly message.
   *
   * @param log Raw error output from arduino-cli.
   * @returns A human-readable error message.
   */
  private parseCliError(log: string): string {
    if (!log) {
      return "Command failed";
    }

    const lower = log.toLowerCase();

    if (lower.includes("not found") || lower.includes("no matching")) {
      if (lower.includes("platform") || lower.includes("core")) {
        return "Platform not found in index. Try updating the board index first.";
      }
      if (lower.includes("library")) {
        return "Library not found. Try updating the library index first.";
      }
    }

    if (lower.includes("permission denied")) {
      return "Permission denied. Try running the command again or check file permissions.";
    }

    if (lower.includes("network") || lower.includes("timeout")) {
      return "Network error while contacting package index. Check your internet connection and try again.";
    }

    if (lower.includes("already installed")) {
      return "Already installed. Try upgrading instead.";
    }

    return log.trim();
  }

  /**
   * Return the additional board manager URLs configured in arduino-cli, using a
   * cached value if the CLI call fails.
   *
   * @returns The list of additional board manager URLs.
   */
  private async getAdditionalBoardUrls(): Promise<string[]> {
    const result = await this.runCliCommand(["config", "dump"], {
      addJson: true,
      timeoutMs: 10_000,
    });

    if (result.success && result.data) {
      const urls =
        result.data.board_manager?.additional_urls &&
        Array.isArray(result.data.board_manager.additional_urls)
          ? result.data.board_manager.additional_urls
          : [];
      this.cachedBoardUrls = urls;
      return urls;
    }

    if (!this.cachedBoardUrls.length) {
      this.log(
        `Failed to load additional board URLs: ${result.error || result.log}`,
      );
    }

    return this.cachedBoardUrls;
  }

  /**
   * Set up API routes
   */
  private setupRoutes(): void {
    // Serve static web client files.
    // HTML must never be cached: Codespaces forwarded-URL origins cache
    // aggressively, which previously kept serving an outdated UI after
    // extension updates until a manual hard refresh. Hashed assets
    // (Vite output) are immutable and safe to cache long-term.
    const webPath = path.join(this.context.extensionPath, "dist", "web");
    if (fs.existsSync(webPath)) {
      this.app.use(
        express.static(webPath, {
          etag: true,
          setHeaders: (res, filePath) => {
            if (filePath.endsWith(".html")) {
              res.setHeader(
                "Cache-Control",
                "no-cache, no-store, must-revalidate",
              );
            } else if (/assets[/\\]/.test(filePath)) {
              res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable",
              );
            } else {
              res.setHeader("Cache-Control", "no-cache");
            }
          },
        }),
      );
      this.log(`Serving static files from: ${webPath}`);
    } else {
      this.log(`Warning: Web client path not found: ${webPath}`);
    }

    // Health endpoint
    this.app.get("/api/health", (_req: Request, res: Response) => {
      res.json({
        success: true,
        data: {
          status: "ok",
          version: this.serverVersion,
          uptime: process.uptime(),
          port: this.port,
        },
      });
    });

    // Version endpoint
    this.app.get("/api/version", (_req: Request, res: Response) => {
      res.json({
        version: this.serverVersion,
        platform: process.platform,
        node: process.version,
      });
    });

    // Restart request from the web client's "Restart Bridge" button. The
    // extension owns the server lifecycle, so respond first and then emit an
    // event the extension handles by stopping and restarting this server.
    this.app.post("/api/restart", (_req: Request, res: Response) => {
      res.json({ success: true, log: "Restarting bridge server..." });
      setTimeout(() => this.emit("restartRequested"), 100);
    });

    // Learned device mappings (VID:PID -> FQBN, proven by successful upload)
    this.app.get("/api/devices/learned", (_req: Request, res: Response) => {
      res.json({ success: true, devices: this.getLearnedDevices() });
    });

    this.app.post("/api/devices/learned", (req: Request, res: Response) => {
      const { vid, pid, fqbn } = req.body ?? {};
      const vidNum = Number(vid);
      const pidNum = Number(pid);
      const validIds =
        Number.isInteger(vidNum) &&
        Number.isInteger(pidNum) &&
        vidNum > 0 &&
        vidNum <= 0xffff &&
        pidNum > 0 &&
        pidNum <= 0xffff;
      const validFqbn =
        typeof fqbn === "string" &&
        /^[\w-]+:[\w-]+:[\w-]+$/.test(fqbn) &&
        this.isSafeCliArg(fqbn);
      if (!validIds || !validFqbn) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid vid/pid/fqbn" });
      }

      const hex = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
      const key = `${hex(vidNum)}:${hex(pidNum)}`;
      this.learnedDevices.set(key, fqbn);
      this.log(`Learned device mapping: ${key} -> ${fqbn}`);
      // Persist via the environment sync controller (single file writer)
      this.emit("environmentChanged");
      res.json({ success: true, devices: this.getLearnedDevices() });
    });

    // Board listing
    this.app.get("/api/boards", async (_req: Request, res: Response) => {
      try {
        const result = await this.listBoards();
        res.json({
          success: true,
          boards: result.boards,
          noCoresInstalled: result.noCoresInstalled,
          message: result.message,
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Board details
    this.app.get(
      "/api/board-details/:fqbn",
      async (req: Request, res: Response) => {
        try {
          const fqbn = decodeURIComponent(req.params.fqbn);
          if (!this.isSafeCliArg(fqbn)) {
            return res
              .status(400)
              .json({ success: false, error: "Invalid board identifier" });
          }
          const details = await this.getBoardDetails(fqbn);
          res.json(details);
        } catch (error: any) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    // Sketch listing
    this.app.get("/api/sketches", async (_req: Request, res: Response) => {
      try {
        const sketches = await this.listSketches();
        res.json({ success: true, sketches });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Compile endpoint
    this.app.post("/api/compile", async (req: Request, res: Response) => {
      try {
        // The web client sends "path"; the extension command sends "sketchPath"
        const { fqbn } = req.body;
        if (fqbn !== undefined && !this.isSafeCliArg(fqbn)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid board identifier" });
        }
        let sketchPath: string | undefined =
          req.body.sketchPath || req.body.path;
        if (!sketchPath) {
          return res
            .status(400)
            .json({ success: false, error: "sketchPath is required" });
        }

        // Resolve bundled tool sketches (e.g. __TOOL__:i2c-scanner)
        if (sketchPath.startsWith("__TOOL__:")) {
          const toolPath = this.resolveToolSketch(
            sketchPath.substring("__TOOL__:".length),
          );
          if (!toolPath) {
            return res
              .status(400)
              .json({ success: false, error: "Unknown tool sketch" });
          }
          sketchPath = toolPath;
        }

        const result = await this.compileSketch(sketchPath, fqbn);

        // Enrich the response with the fields the web client expects
        // (log string + artifact URL) while preserving the original shape.
        const log = (result.output || []).join("\n");
        let artifact;
        if (result.success && result.hexPath) {
          const name = path.basename(result.hexPath);
          const sketchName = path.basename(path.dirname(result.hexPath));
          let size = 0;
          try {
            size = fs.statSync(result.hexPath).size;
          } catch {
            /* stat is best-effort */
          }
          artifact = { name, url: `/api/hex/${sketchName}`, size };
        }

        // On failure, scan the compiler output for missing headers so the
        // client can guide the user to the Library Manager.
        const missingIncludes = result.success
          ? []
          : await this.detectMissingIncludes(log);

        // On failure, distil the log into a single clear diagnosis so the
        // final console line explains the real problem, not `exit status 1`.
        const diagnosis = result.success ? null : analyzeCompileError(log);
        // ...and the full list so a sketch with several mistakes shows them all.
        const diagnostics = result.success ? [] : analyzeCompileErrors(log);

        res.json({
          ...result,
          log,
          artifact,
          missingIncludes,
          diagnosis,
          diagnostics,
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // IntelliSense configuration - regenerates .vscode/c_cpp_properties.json
    // for the selected board (the web client calls this on board change)
    this.app.post("/api/intellisense", async (req: Request, res: Response) => {
      try {
        const { fqbn } = req.body;
        if (!fqbn) {
          return res
            .status(400)
            .json({ success: false, error: "fqbn is required" });
        }
        if (!this.isSafeCliArg(fqbn)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid board identifier" });
        }

        const result = await this.generateIntelliSense(fqbn);
        if (!result.success) {
          return res.status(500).json({ success: false, error: result.error });
        }

        res.json({
          success: true,
          fqbn,
          message: "IntelliSense configuration updated",
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get compiled HEX file
    this.app.get("/api/hex/:sketchName", (req: Request, res: Response) => {
      const sketchName = req.params.sketchName;
      // Prevent path traversal: the sketch name is used to build a filesystem
      // path, so restrict it to a single safe path segment.
      if (!/^[A-Za-z0-9_.-]+$/.test(sketchName) || sketchName.includes("..")) {
        res.status(400).json({ success: false, error: "Invalid sketch name" });
        return;
      }
      const hexPath = path.join(
        this.buildRoot,
        sketchName,
        `${sketchName}.ino.hex`,
      );

      if (fs.existsSync(hexPath)) {
        res.sendFile(hexPath);
      } else {
        // Try .bin for ARM boards
        const binPath = path.join(
          this.buildRoot,
          sketchName,
          `${sketchName}.ino.bin`,
        );
        if (fs.existsSync(binPath)) {
          res.sendFile(binPath);
        } else {
          res
            .status(404)
            .json({ success: false, error: "Compiled file not found" });
        }
      }
    });

    // CLI Health check
    this.app.get("/api/cli/health", async (_req: Request, res: Response) => {
      try {
        const result = await this.checkCliHealth();
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Core management routes
    this.setupCoreRoutes();

    // Library management routes
    this.setupLibraryRoutes();

    // Fallback to index.html for SPA routing - MUST be last!
    this.app.get("*", (req: Request, res: Response) => {
      // Don't intercept API routes
      if (req.path.startsWith("/api/")) {
        res
          .status(404)
          .json({ success: false, error: "API endpoint not found" });
        return;
      }

      const indexPath = path.join(
        this.context.extensionPath,
        "dist",
        "web",
        "index.html",
      );
      if (fs.existsSync(indexPath)) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Web client not found");
      }
    });
  }

  /**
   * Set up core management routes
   */
  private setupCoreRoutes(): void {
    this.app.get(
      "/api/cli/cores/index/status",
      (_req: Request, res: Response) => {
        res.json(this.buildIndexStatus(this.lastCoreIndexUpdate));
      },
    );

    this.app.post(
      "/api/cli/cores/index/update",
      async (_req: Request, res: Response) => {
        const result = await this.runCliCommand(["core", "update-index"], {
          addJson: false,
          timeoutMs: 60_000,
        });

        if (result.success) {
          this.lastCoreIndexUpdate = Date.now();
          res.json({
            success: true,
            duration: result.duration,
            log: (result.log || result.rawOutput || "").trim(),
          });
        } else {
          res.status(500).json({
            success: false,
            duration: result.duration,
            log: result.log,
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.get(
      "/api/cli/cores/urls",
      async (_req: Request, res: Response) => {
        try {
          const urls = await this.getAdditionalBoardUrls();
          res.json({ success: true, urls });
        } catch (error: any) {
          res
            .status(500)
            .json({ success: false, urls: [], error: error.message });
        }
      },
    );

    this.app.post(
      "/api/cli/cores/urls/add",
      async (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) {
          return res
            .status(400)
            .json({ success: false, urls: [], error: "URL is required" });
        }

        try {
          new URL(url);
        } catch {
          return res
            .status(400)
            .json({ success: false, urls: [], error: "Invalid URL format" });
        }

        if (!this.isSafeCliArg(url)) {
          return res
            .status(400)
            .json({ success: false, urls: [], error: "Invalid URL format" });
        }

        const result = await this.runCliCommand(
          ["config", "add", "board_manager.additional_urls", url],
          { addJson: false, timeoutMs: 10_000 },
        );

        if (result.success) {
          const urls = await this.getAdditionalBoardUrls();
          res.json({ success: true, urls });
        } else {
          res.status(500).json({
            success: false,
            urls: this.cachedBoardUrls,
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.post(
      "/api/cli/cores/urls/remove",
      async (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) {
          return res
            .status(400)
            .json({ success: false, urls: [], error: "URL is required" });
        }
        if (!this.isSafeCliArg(url)) {
          return res
            .status(400)
            .json({ success: false, urls: [], error: "Invalid URL format" });
        }

        const result = await this.runCliCommand(
          ["config", "remove", "board_manager.additional_urls", url],
          { addJson: false, timeoutMs: 10_000 },
        );

        if (result.success) {
          const urls = await this.getAdditionalBoardUrls();
          res.json({ success: true, urls });
        } else {
          res.status(500).json({
            success: false,
            urls: this.cachedBoardUrls,
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.get(
      "/api/cli/cores/search",
      async (req: Request, res: Response) => {
        const query = typeof req.query.q === "string" ? req.query.q : "";
        const args = ["core", "search"];
        if (query) {
          args.push(query);
        }

        const result = await this.runCliCommand(args, {
          addJson: true,
          timeoutMs: 30_000,
        });

        if (result.success && result.data) {
          const rawPlatforms = Array.isArray(result.data.platforms)
            ? result.data.platforms
            : Array.isArray(result.data)
              ? result.data
              : [];
          const platforms = rawPlatforms.map((platform: any) =>
            this.transformPlatform(platform),
          );
          res.json({ success: true, platforms });
        } else {
          res.status(500).json({
            success: false,
            platforms: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.get(
      "/api/cli/cores/installed",
      async (_req: Request, res: Response) => {
        const result = await this.runCliCommand(["core", "list"], {
          addJson: true,
          timeoutMs: 15_000,
        });

        if (result.success && result.data) {
          const rawPlatforms = Array.isArray(result.data.platforms)
            ? result.data.platforms
            : Array.isArray(result.data)
              ? result.data
              : [];
          const platforms = rawPlatforms.map((platform: any) =>
            this.transformPlatform(platform),
          );
          res.json({ success: true, platforms });
        } else {
          res.status(500).json({
            success: false,
            platforms: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    const respondFromCliTask = (
      res: Response,
      result: CliCommandResult,
    ): void => {
      if (result.success) {
        res.json({
          success: true,
          duration: result.duration,
          log: (result.log || result.rawOutput || "").trim(),
        });
      } else {
        res.status(500).json({
          success: false,
          duration: result.duration,
          log: result.log,
          error: this.parseCliError(result.error || result.log),
        });
      }
    };

    this.app.post(
      "/api/cli/cores/install",
      async (req: Request, res: Response) => {
        const { platformId, version } = req.body;
        if (!platformId) {
          return res
            .status(400)
            .json({ success: false, error: "platformId is required" });
        }
        if (
          !this.isSafeCliArg(platformId) ||
          (version !== undefined &&
            version !== "" &&
            !this.isSafeCliArg(version))
        ) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid platform identifier" });
        }

        const platformSpec = version ? `${platformId}@${version}` : platformId;
        const result = await this.runCliCommand(
          ["core", "install", platformSpec],
          { addJson: false, timeoutMs: 300_000 },
        );

        // Notify the extension so it can sync the requirements file
        if (result.success) {
          this.emit("environmentChanged");
        }

        respondFromCliTask(res, result);
      },
    );

    this.app.post(
      "/api/cli/cores/upgrade",
      async (req: Request, res: Response) => {
        const { platformId } = req.body;
        if (!platformId) {
          return res
            .status(400)
            .json({ success: false, error: "platformId is required" });
        }
        if (!this.isSafeCliArg(platformId)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid platform identifier" });
        }

        const result = await this.runCliCommand(
          ["core", "upgrade", platformId],
          { addJson: false, timeoutMs: 300_000 },
        );
        if (result.success) {
          this.emit("environmentChanged");
        }
        respondFromCliTask(res, result);
      },
    );

    this.app.post(
      "/api/cli/cores/uninstall",
      async (req: Request, res: Response) => {
        const { platformId } = req.body;
        if (!platformId) {
          return res
            .status(400)
            .json({ success: false, error: "platformId is required" });
        }
        if (!this.isSafeCliArg(platformId)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid platform identifier" });
        }

        const result = await this.runCliCommand(
          ["core", "uninstall", platformId],
          { addJson: false, timeoutMs: 120_000 },
        );

        // Notify the extension so it can sync the requirements file
        if (result.success) {
          this.emit("environmentChanged");
        }

        respondFromCliTask(res, result);
      },
    );
  }

  /**
   * Set up library management routes
   */
  private setupLibraryRoutes(): void {
    this.app.get(
      "/api/cli/libraries/index/status",
      (_req: Request, res: Response) => {
        res.json(this.buildIndexStatus(this.lastLibraryIndexUpdate));
      },
    );

    this.app.post(
      "/api/cli/libraries/index/update",
      async (_req: Request, res: Response) => {
        const result = await this.runCliCommand(["lib", "update-index"], {
          addJson: false,
          timeoutMs: 60_000,
        });

        if (result.success) {
          this.lastLibraryIndexUpdate = Date.now();
          res.json({
            success: true,
            duration: result.duration,
            log: (result.log || result.rawOutput || "").trim(),
          });
        } else {
          res.status(500).json({
            success: false,
            duration: result.duration,
            log: result.log,
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.get(
      "/api/cli/libraries/search",
      async (req: Request, res: Response) => {
        const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if (!query) {
          return res.status(400).json({
            success: false,
            libraries: [],
            error: "Search query is required",
          });
        }

        const result = await this.runCliCommand(["lib", "search", query], {
          addJson: true,
          timeoutMs: 30_000,
        });

        if (result.success && result.data) {
          const rawLibraries = Array.isArray(result.data.libraries)
            ? result.data.libraries
            : Array.isArray(result.data)
              ? result.data
              : [];
          const libraries = rawLibraries.map((library: any) =>
            this.transformLibrary(library),
          );
          res.json({ success: true, libraries });
        } else {
          res.status(500).json({
            success: false,
            libraries: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    this.app.get(
      "/api/cli/libraries/installed",
      async (_req: Request, res: Response) => {
        const result = await this.runCliCommand(["lib", "list"], {
          addJson: true,
          timeoutMs: 15_000,
        });

        if (result.success && result.data) {
          const installed = Array.isArray(result.data.installed_libraries)
            ? result.data.installed_libraries
            : Array.isArray(result.data)
              ? result.data
              : [];

          const libraries = installed.map((item: any) => {
            const lib = item.library || item;
            return {
              name: lib.name,
              installedVersion: lib.version || lib.installed_version,
              latestVersion: lib.version || null,
              author: lib.author || "Unknown",
              sentence: lib.sentence || "",
              paragraph: lib.paragraph || "",
              category: lib.category || "Uncategorized",
              architectures: lib.architectures || [],
              location: lib.location || null,
              versions: lib.versions || [],
            };
          });

          res.json({ success: true, libraries });
        } else {
          res.status(500).json({
            success: false,
            libraries: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );

    const respondFromCliTask = (
      res: Response,
      result: CliCommandResult,
    ): void => {
      if (result.success) {
        res.json({
          success: true,
          duration: result.duration,
          log: (result.log || result.rawOutput || "").trim(),
        });
      } else {
        res.status(500).json({
          success: false,
          duration: result.duration,
          log: result.log,
          error: this.parseCliError(result.error || result.log),
        });
      }
    };

    this.app.post(
      "/api/cli/libraries/install",
      async (req: Request, res: Response) => {
        const { name, version, installDeps } = req.body;
        if (!name) {
          return res
            .status(400)
            .json({ success: false, error: "Library name is required" });
        }
        if (
          !this.isSafeCliArg(name) ||
          (version !== undefined &&
            version !== "" &&
            !this.isSafeCliArg(version))
        ) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid library name" });
        }

        const libSpec = version ? `${name}@${version}` : name;
        const args = ["lib", "install", libSpec];
        if (installDeps === false) {
          args.push("--no-deps");
        }

        const result = await this.runCliCommand(args, {
          addJson: false,
          timeoutMs: 240_000,
        });

        // Notify the extension so it can sync the requirements file
        if (result.success) {
          this.emit("environmentChanged");
        }

        respondFromCliTask(res, result);
      },
    );

    this.app.post(
      "/api/cli/libraries/upgrade",
      async (req: Request, res: Response) => {
        const { name } = req.body;
        if (!name) {
          return res
            .status(400)
            .json({ success: false, error: "Library name is required" });
        }
        if (!this.isSafeCliArg(name)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid library name" });
        }

        const result = await this.runCliCommand(["lib", "upgrade", name], {
          addJson: false,
          timeoutMs: 240_000,
        });
        if (result.success) {
          this.emit("environmentChanged");
        }
        respondFromCliTask(res, result);
      },
    );

    this.app.post(
      "/api/cli/libraries/uninstall",
      async (req: Request, res: Response) => {
        const { name, removeUnusedDeps = true } = req.body;
        if (!name) {
          return res
            .status(400)
            .json({ success: false, error: "Library name is required" });
        }
        if (!this.isSafeCliArg(name)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid library name" });
        }

        // Get dependencies of the library being uninstalled
        let depsToCheck: string[] = [];
        if (removeUnusedDeps) {
          try {
            const depsResult = await this.runCliCommand(["lib", "deps", name], {
              addJson: true,
              timeoutMs: 30_000,
            });
            if (depsResult.success && depsResult.data?.dependencies) {
              depsToCheck = depsResult.data.dependencies
                .map((d: { name: string }) => d.name)
                .filter((n: string) => n !== name); // Exclude the library itself
            }
          } catch {
            // Continue with uninstall even if deps check fails
          }
        }

        // Uninstall the main library
        const result = await this.runCliCommand(["lib", "uninstall", name], {
          addJson: false,
          timeoutMs: 120_000,
        });

        if (!result.success) {
          return respondFromCliTask(res, result);
        }

        // Check and remove unused dependencies
        const removedDeps: string[] = [];
        if (removeUnusedDeps && depsToCheck.length > 0) {
          // Get all remaining installed libraries and their dependencies
          const remainingDeps = new Set<string>();

          try {
            const listResult = await this.runCliCommand(["lib", "list"], {
              addJson: true,
              timeoutMs: 30_000,
            });

            if (listResult.success && listResult.data?.installed_libraries) {
              // For each installed library, get its dependencies
              for (const item of listResult.data.installed_libraries) {
                const libName = item.library?.name;
                if (!libName) {
                  continue;
                }

                // Get deps of this library
                const libDepsResult = await this.runCliCommand(
                  ["lib", "deps", libName],
                  { addJson: true, timeoutMs: 15_000 },
                );

                if (libDepsResult.success && libDepsResult.data?.dependencies) {
                  for (const dep of libDepsResult.data.dependencies) {
                    remainingDeps.add(dep.name);
                  }
                }
              }
            }

            // Uninstall deps that are no longer needed
            for (const depName of depsToCheck) {
              if (!remainingDeps.has(depName)) {
                const uninstallDepResult = await this.runCliCommand(
                  ["lib", "uninstall", depName],
                  { addJson: false, timeoutMs: 60_000 },
                );
                if (uninstallDepResult.success) {
                  removedDeps.push(depName);
                }
              }
            }
          } catch {
            // Continue even if dep cleanup fails
          }
        }

        // Update the config file to reflect the uninstall
        this.emit("environmentChanged");

        res.json({
          success: true,
          duration: result.duration,
          log: result.log,
          removedDependencies: removedDeps,
        });
      },
    );

    this.app.post(
      "/api/cli/libraries/install-git",
      async (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) {
          return res
            .status(400)
            .json({ success: false, error: "Git URL is required" });
        }

        const result = await this.runCliCommand(
          ["lib", "install", "--git-url", url],
          { addJson: false, timeoutMs: 240_000 },
        );
        if (result.success) {
          this.emit("environmentChanged");
        }
        respondFromCliTask(res, result);
      },
    );

    this.app.post(
      "/api/cli/libraries/install-zip",
      async (req: Request, res: Response) => {
        const { path: zipPath } = req.body;
        if (!zipPath) {
          return res
            .status(400)
            .json({ success: false, error: "ZIP path is required" });
        }

        const result = await this.runCliCommand(
          ["lib", "install", "--zip-path", zipPath],
          { addJson: false, timeoutMs: 240_000 },
        );
        if (result.success) {
          this.emit("environmentChanged");
        }
        respondFromCliTask(res, result);
      },
    );

    this.app.get(
      "/api/cli/libraries/:name/examples",
      async (req: Request, res: Response) => {
        const libraryName = req.params.name;
        if (!libraryName) {
          return res.status(400).json({
            success: false,
            examples: [],
            error: "Library name is required",
          });
        }

        const result = await this.runCliCommand(
          ["lib", "examples", libraryName],
          { addJson: false, timeoutMs: 15_000 },
        );

        if (result.success) {
          const rawOutput = (result.rawOutput || result.log || "").replace(
            /\x1b\[[0-9;]*m/g,
            "",
          );
          const lines = rawOutput
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.startsWith("Examples for library"));

          const examples = lines
            .map((line) => {
              const match = line.match(/^[-•]\s*(.+)$/);
              const pathValue = match ? match[1].trim() : line;
              if (!pathValue) {
                return null;
              }
              return {
                name: path.basename(pathValue),
                path: pathValue,
              };
            })
            .filter((example): example is { name: string; path: string } =>
              Boolean(example),
            );

          res.json({ success: true, examples });
        } else {
          res.status(500).json({
            success: false,
            examples: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      },
    );
  }

  // =========================================================================
  // Arduino CLI Operations
  // =========================================================================

  /**
   * Execute arduino-cli command
   * @param args - Command arguments
   * @returns Command output
   */
  /**
   * Check arduino-cli availability
   */
  private async checkCliHealth(): Promise<{
    available: boolean;
    version?: string;
    error?: string;
  }> {
    const result = await this.runCliCommand(["version"], {
      addJson: true,
      timeoutMs: 5_000,
    });

    if (result.success) {
      const versionString =
        result.data?.VersionString ||
        result.data?.version ||
        (result.rawOutput || result.log || "").match(
          /Version:\s*(\S+)/i,
        )?.[1] ||
        "unknown";
      return { available: true, version: versionString };
    }

    return {
      available: false,
      error: this.parseCliError(result.error || result.log),
    };
  }

  /**
   * List available boards. Reports when no cores are installed so the UI
   * can guide the user to the Board Manager instead of showing an empty list.
   */
  private async listBoards(): Promise<{
    boards: BoardInfo[];
    noCoresInstalled: boolean;
    message?: string;
  }> {
    // First, check if any cores are installed
    const coresResult = await this.runCliCommand(["core", "list"], {
      addJson: true,
      timeoutMs: 15_000,
    });

    let installedCores: any[] = [];
    if (coresResult.success && coresResult.data) {
      installedCores = Array.isArray(coresResult.data.platforms)
        ? coresResult.data.platforms
        : Array.isArray(coresResult.data)
          ? coresResult.data
          : [];
    }

    if (installedCores.length === 0) {
      this.log("No cores installed - board list will be empty");
      return {
        boards: [],
        noCoresInstalled: true,
        message:
          "No board cores are installed. Please go to the Board Manager tab and install a core (e.g., 'Arduino AVR Boards' for Uno, Nano, Mega) to see available boards.",
      };
    }

    const result = await this.runCliCommand(["board", "listall"], {
      addJson: true,
      timeoutMs: 20_000,
    });

    if (result.success && result.data) {
      const boards = Array.isArray(result.data.boards)
        ? result.data.boards
        : Array.isArray(result.data)
          ? result.data
          : [];

      return {
        boards: boards.map((board: any) => ({
          fqbn: board.fqbn,
          name: board.name,
          platform: board.platform?.name,
        })),
        noCoresInstalled: false,
      };
    }

    this.log(
      `Error listing boards: ${this.parseCliError(result.error || result.log)}`,
    );

    return {
      boards: [
        { fqbn: "arduino:avr:uno", name: "Arduino Uno" },
        { fqbn: "arduino:avr:nano", name: "Arduino Nano" },
        { fqbn: "arduino:avr:mega", name: "Arduino Mega 2560" },
        { fqbn: "arduino:renesas_uno:unor4wifi", name: "Arduino Uno R4 WiFi" },
      ],
      noCoresInstalled: false,
      message:
        "Could not retrieve board list from Arduino CLI. Showing common boards.",
    };
  }

  /**
   * Get board details
   */
  private async getBoardDetails(fqbn: string): Promise<BoardInfo> {
    const result = await this.runCliCommand(["board", "details", "-b", fqbn], {
      addJson: true,
      timeoutMs: 15_000,
    });

    if (result.success && result.data) {
      const data = result.data;
      return {
        fqbn: data.fqbn || fqbn,
        name: data.name || fqbn,
        uploadTool: data.programmers?.[0]?.name,
        protocol: data.protocol,
      };
    }

    return { fqbn, name: fqbn };
  }

  /**
   * List sketches in workspace using the VS Code file search API
   * (respects workspace scope, symlinks, and remote filesystems).
   * Falls back to a direct filesystem scan when findFiles returns nothing:
   * right after the extension host starts, the workspace file index may not
   * be ready yet and findFiles yields an empty result even though sketches
   * exist (seen as an empty sketch dropdown on first page load).
   */
  private async listSketches(): Promise<SketchInfo[]> {
    const sketches: SketchInfo[] = [];

    try {
      const uris = await vscode.workspace.findFiles(
        "**/*.ino",
        "**/{node_modules,dist,out,build,.git,.github,.vscode,.devcontainer,web-client}/**",
      );

      for (const uri of uris) {
        const inoPath = uri.fsPath;
        const sketchDir = path.dirname(inoPath);
        const sketchName = path.basename(sketchDir);
        const inoFileName = path.basename(inoPath);

        // Arduino convention: main sketch file matches directory name
        if (inoFileName === `${sketchName}.ino`) {
          sketches.push({
            name: sketchName,
            path: path.relative(this.workspaceRoot, sketchDir),
            fullPath: sketchDir,
          });
        }
      }
    } catch (error: any) {
      this.log(`Error listing sketches: ${error.message}`);
    }

    if (sketches.length > 0) {
      return this.sortSketches(sketches);
    }
    return this.sortSketches(this.scanSketchesOnDisk());
  }

  /**
   * Sort sketches alphabetically for stable UI ordering.
   */
  private sortSketches(sketches: SketchInfo[]): SketchInfo[] {
    return sketches.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  }

  /**
   * Scan the workspace directory tree for sketch folders directly on disk.
   * Used as a fallback when the VS Code file index is not ready yet.
   *
   * @returns Sketch folders containing a matching <dirname>.ino file.
   */
  private scanSketchesOnDisk(): SketchInfo[] {
    const ignoreDirs = new Set([
      "node_modules",
      "dist",
      "out",
      "build",
      ".git",
      ".github",
      ".vscode",
      ".devcontainer",
      "web-client",
    ]);
    const sketches: SketchInfo[] = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > 5) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const dirName = path.basename(dir);
      if (entries.some((e) => e.isFile() && e.name === `${dirName}.ino`)) {
        sketches.push({
          name: dirName,
          path: path.relative(this.workspaceRoot, dir),
          fullPath: dir,
        });
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !ignoreDirs.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      }
    };

    try {
      walk(this.workspaceRoot, 0);
    } catch (error: any) {
      this.log(`Error scanning sketches on disk: ${error.message}`);
    }
    return sketches;
  }

  /**
   * Compile a sketch
   */
  private async compileSketch(
    sketchPath: string,
    fqbn?: string,
  ): Promise<CompileResult> {
    const config = vscode.workspace.getConfiguration("arduinoBridge");
    const boardFqbn = fqbn || config.get("defaultBoard") || "arduino:avr:uno";

    // Resolve sketch path
    let fullSketchPath = sketchPath;
    if (!path.isAbsolute(sketchPath)) {
      fullSketchPath = path.join(this.workspaceRoot, sketchPath);
      // A relative path must stay inside the workspace; reject "../" escapes.
      const root = path.resolve(this.workspaceRoot);
      const resolved = path.resolve(fullSketchPath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return { success: false, error: "Sketch path escapes the workspace" };
      }
    }

    // Check if sketch exists
    const sketchName = path.basename(fullSketchPath);
    const inoFile = path.join(fullSketchPath, `${sketchName}.ino`);

    if (!fs.existsSync(inoFile)) {
      return { success: false, error: `Sketch not found: ${inoFile}` };
    }

    // Create build directory
    const buildDir = path.join(this.buildRoot, sketchName);
    fs.mkdirSync(buildDir, { recursive: true });

    this.log(`Compiling ${sketchName} for ${boardFqbn}...`);

    try {
      const args = [
        "compile",
        "-b",
        boardFqbn,
        "--build-path",
        buildDir,
        "--warnings",
        "default",
        fullSketchPath,
      ];

      const result = await this.runCliCommand(args, {
        addJson: false,
        timeoutMs: 300_000,
      });

      if (!result.success) {
        const message = this.parseCliError(result.error || result.log);
        return {
          success: false,
          error: message,
          output: (result.log || result.rawOutput || message).split(/\r?\n/),
          fqbn: boardFqbn,
          sketchPath: fullSketchPath,
        };
      }

      // Find the output file
      const hexFile = path.join(buildDir, `${sketchName}.ino.hex`);
      const binFile = path.join(buildDir, `${sketchName}.ino.bin`);

      const outputFile = fs.existsSync(hexFile)
        ? hexFile
        : fs.existsSync(binFile)
          ? binFile
          : null;

      return {
        success: true,
        hexPath: outputFile || undefined,
        output: (result.rawOutput || result.log || "").split(/\r?\n/),
        fqbn: boardFqbn,
        sketchPath: fullSketchPath,
      };
    } catch (error: any) {
      const message = error?.message || String(error);
      return {
        success: false,
        error: message,
        output: message.split(/\r?\n/),
        fqbn: boardFqbn,
        sketchPath: fullSketchPath,
      };
    }
  }

  // =========================================================================
  // Server Lifecycle
  // =========================================================================

  /**
   * Ensure the given port is free, terminating any conflicting processes with
   * SIGTERM and then SIGKILL if necessary.
   *
   * @param port The port that must be made available.
   * @throws If the port cannot be freed.
   */
  private async ensurePortAvailable(port: number): Promise<void> {
    const conflicting = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0,
    );

    if (conflicting.length === 0) {
      return;
    }

    this.log(
      `Port ${port} is currently in use by PIDs ${conflicting.join(
        ", ",
      )} - attempting to terminate`,
    );

    for (const pid of conflicting) {
      await this.terminateProcess(pid, "SIGTERM");
    }

    await this.delay(500);

    const stillRunning = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0,
    );

    if (stillRunning.length === 0) {
      return;
    }

    this.log(
      `Port ${port} still occupied after SIGTERM. Forcing termination of ${stillRunning.join(
        ", ",
      )}`,
    );

    for (const pid of stillRunning) {
      await this.terminateProcess(pid, "SIGKILL");
    }

    await this.delay(300);

    const finalCheck = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0,
    );

    if (finalCheck.length > 0) {
      throw new Error(
        `Unable to free port ${port}. Still in use by ${finalCheck.join(", ")}`,
      );
    }
  }

  /**
   * Find the PIDs of processes currently listening on the given TCP port.
   *
   * @param port The TCP port to inspect.
   * @returns The list of process IDs using the port.
   */
  private findProcessesUsingPort(port: number): Promise<number[]> {
    return new Promise((resolve) => {
      const command =
        process.platform === "win32"
          ? `netstat -ano | findstr :${port}`
          : `lsof -ti tcp:${port}`;

      exec(command, (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }

        const lines = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        const pids = new Set<number>();

        if (process.platform === "win32") {
          for (const line of lines) {
            const parts = line.split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (!Number.isNaN(pid)) {
              pids.add(pid);
            }
          }
        } else {
          for (const line of lines) {
            const pid = parseInt(line, 10);
            if (!Number.isNaN(pid)) {
              pids.add(pid);
            }
          }
        }

        resolve(Array.from(pids));
      });
    });
  }

  /**
   * Send a termination signal to a process, ignoring the current process.
   *
   * @param pid The target process ID.
   * @param signal The signal to send (e.g. SIGTERM or SIGKILL).
   */
  private async terminateProcess(
    pid: number,
    signal: NodeJS.Signals,
  ): Promise<void> {
    if (pid === process.pid) {
      return;
    }

    try {
      process.kill(pid, signal);
      this.log(`Sent ${signal} to process ${pid}`);
    } catch (error: any) {
      this.log(
        `Failed to send ${signal} to process ${pid}: ${error?.message || error}`,
      );
    }
  }

  /**
   * Resolve after the given number of milliseconds.
   *
   * @param ms Delay duration in milliseconds.
   * @returns A promise that resolves once the delay elapses.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start the server. Frees the preferred port first (graceful SIGTERM then
   * SIGKILL); if binding still fails with EADDRINUSE, falls back to the next
   * port so the bridge always comes up.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Server is already running");
    }

    try {
      await this.ensurePortAvailable(this.port);
    } catch (error: any) {
      this.log(`Could not free port ${this.port}: ${error.message}`);
    }

    await new Promise<void>((resolve, reject) => {
      const tryPort = (port: number, attemptsLeft: number): void => {
        // Bind to loopback only. VS Code / Codespaces port-forwarding connects
        // over localhost, so forwarding still works, while the server is not
        // exposed to the local network (or other containers).
        const server = this.app.listen(port, "127.0.0.1");
        this.server = server;

        const handleError = (error: NodeJS.ErrnoException): void => {
          server.off("listening", handleListening);
          if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
            this.log(`Port ${port} in use, trying ${port + 1}...`);
            tryPort(port + 1, attemptsLeft - 1);
          } else {
            reject(error);
          }
        };

        const handleListening = (): void => {
          server.off("error", handleError);
          this.port = (server.address() as any).port;
          this.running = true;
          this.log(`Server started on port ${this.port}`);
          resolve();
        };

        server.once("error", handleError);
        server.once("listening", handleListening);
      };

      tryPort(this.port, 10);
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    // Clean up active processes
    for (const proc of this.activeProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore errors
      }
    }
    this.activeProcesses.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        this.server = undefined;
        this.log("Server stopped");
        resolve();
      });
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the learned device mappings as a serializable list.
   * @returns Device entries sorted by key
   */
  getLearnedDevices(): { key: string; fqbn: string }[] {
    return [...this.learnedDevices.entries()]
      .map(([key, fqbn]) => ({ key, fqbn }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Seed the learned device map from the requirements file (file is the
   * source of truth at sync time; runtime uploads then update both).
   * @param devices Device entries parsed from arduino-requirements.txt
   */
  seedLearnedDevices(devices: { key: string; fqbn: string }[]): void {
    this.learnedDevices = new Map(
      (devices || []).map((d) => [d.key.toLowerCase(), d.fqbn]),
    );
  }

  /**
   * Get workspace root path
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Resolve a bundled tool sketch id (from a __TOOL__:<id> compile path)
   * to its absolute directory inside the packaged extension.
   * @param toolId - Tool identifier, e.g. "i2c-scanner"
   * @returns Absolute path to the tool sketch folder, or null if unknown
   */
  private resolveToolSketch(toolId: string): string | null {
    const toolSketches: Record<string, string> = {
      "i2c-scanner": path.join(
        this.context.extensionPath,
        "dist",
        "tools",
        "I2C_Scanner",
      ),
    };
    const toolPath = toolSketches[toolId];
    if (!toolPath || !fs.existsSync(toolPath)) {
      return null;
    }
    return toolPath;
  }

  /**
   * Generate .vscode/c_cpp_properties.json for the given board so C/C++
   * IntelliSense resolves Arduino symbols (pinMode, Serial, etc.).
   * Paths are resolved from `arduino-cli board details` build properties,
   * so they are correct for any user/home directory and tool versions.
   * @param fqbn - Fully qualified board name, e.g. "arduino:avr:uno"
   */
  private async generateIntelliSense(
    fqbn: string,
  ): Promise<{ success: boolean; error?: string; configPath?: string }> {
    const result = await this.runCliCommand(
      ["board", "details", "--fqbn", fqbn],
      { addJson: true, timeoutMs: 30_000 },
    );

    if (!result.success || !result.data) {
      return {
        success: false,
        error: this.parseCliError(result.error || result.log),
      };
    }

    const { config, error } = buildIntelliSenseConfig(
      result.data.build_properties || [],
      { homeDir: os.homedir() },
    );

    if (!config) {
      return { success: false, error };
    }

    try {
      const vscodeDir = path.join(this.workspaceRoot, ".vscode");
      fs.mkdirSync(vscodeDir, { recursive: true });
      const configPath = path.join(vscodeDir, "c_cpp_properties.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      this.log(`IntelliSense configuration updated for ${fqbn}`);
      return { success: true, configPath };
    } catch (writeError: any) {
      return { success: false, error: writeError.message };
    }
  }

  /**
   * Log a message
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }
}
