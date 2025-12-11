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
 * @version 1.0.15
 */

import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import express, { Application, Request, Response, NextFunction } from "express";
import { spawn, ChildProcess, exec } from "child_process";
import { writeEnvironmentConfig } from "../config/environmentConfig";

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

// =============================================================================
// Constants
// =============================================================================

/** Server version */
const SERVER_VERSION = "1.0.15";

/** Maximum depth for sketch directory scanning */
const MAX_SCAN_DEPTH = 3;

/** Directories to ignore when scanning */
const IGNORE_DIRS = new Set([
  "web-client",
  "arduino-to-codespaces-bridge",
  "docs",
  "scripts",
  "build",
  ".git",
  ".github",
  ".vscode",
  ".devcontainer",
  "node_modules",
  "dist",
  "out",
]);

// =============================================================================
// BridgeServer Class
// =============================================================================

/**
 * Arduino Bridge Server for VS Code Extension
 */
export class BridgeServer {
  private app: Application;
  private server: http.Server | undefined;
  private port: number;
  private running: boolean = false;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private workspaceRoot: string;
  private buildRoot: string;
  private activeProcesses: Set<ChildProcess> = new Set();
  private lastCoreIndexUpdate?: number;
  private lastLibraryIndexUpdate?: number;
  private cachedBoardUrls: string[] = [];

  /**
   * Create a new BridgeServer instance
   * @param context - VS Code extension context
   * @param outputChannel - Output channel for logging
   */
  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.app = express();

    const config = vscode.workspace.getConfiguration("arduinoBridge");
    this.port = config.get("serverPort") || 3001;

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
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // JSON body parsing
    this.app.use(express.json());

    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      this.log(`${req.method} ${req.path}`);
      next();
    });

    // CORS headers for browser access
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      next();
    });
  }

  /**
   * Execute an arduino-cli command and capture structured output
   */
  private runCliCommand(
    args: string[],
    options: { addJson?: boolean; timeoutMs?: number } = {}
  ): Promise<CliCommandResult> {
    const { addJson = true, timeoutMs = 120_000 } = options;
    const cliArgs = addJson ? [...args, "--format", "json"] : [...args];

    return new Promise<CliCommandResult>((resolve) => {
      const start = Date.now();
      const child = spawn("arduino-cli", cliArgs, {
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
                  " "
                )}: ${error?.message || error}`
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
        `Failed to load additional board URLs: ${result.error || result.log}`
      );
    }

    return this.cachedBoardUrls;
  }

  /**
   * Set up API routes
   */
  private setupRoutes(): void {
    // Serve static web client files
    const webPath = path.join(this.context.extensionPath, "dist", "web");
    if (fs.existsSync(webPath)) {
      this.app.use(express.static(webPath));
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
          version: SERVER_VERSION,
          uptime: process.uptime(),
          port: this.port,
        },
      });
    });

    // Version endpoint
    this.app.get("/api/version", (_req: Request, res: Response) => {
      res.json({
        version: SERVER_VERSION,
        platform: process.platform,
        node: process.version,
      });
    });

    // Board listing
    this.app.get("/api/boards", async (_req: Request, res: Response) => {
      try {
        const boards = await this.listBoards();
        res.json({ success: true, boards });
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
          const details = await this.getBoardDetails(fqbn);
          res.json(details);
        } catch (error: any) {
          res.status(500).json({ success: false, error: error.message });
        }
      }
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
        const { sketchPath, fqbn } = req.body;
        if (!sketchPath) {
          return res
            .status(400)
            .json({ success: false, error: "sketchPath is required" });
        }

        const result = await this.compileSketch(sketchPath, fqbn);
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get compiled HEX file
    this.app.get("/api/hex/:sketchName", (req: Request, res: Response) => {
      const sketchName = req.params.sketchName;
      const hexPath = path.join(
        this.buildRoot,
        sketchName,
        `${sketchName}.ino.hex`
      );

      if (fs.existsSync(hexPath)) {
        res.sendFile(hexPath);
      } else {
        // Try .bin for ARM boards
        const binPath = path.join(
          this.buildRoot,
          sketchName,
          `${sketchName}.ino.bin`
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
        "index.html"
      );
      if (fs.existsSync(indexPath)) {
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
      }
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
      }
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
      }
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

        const result = await this.runCliCommand(
          ["config", "add", "board_manager.additional_urls", url],
          { addJson: false, timeoutMs: 10_000 }
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
      }
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

        const result = await this.runCliCommand(
          ["config", "remove", "board_manager.additional_urls", url],
          { addJson: false, timeoutMs: 10_000 }
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
      }
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
            this.transformPlatform(platform)
          );
          res.json({ success: true, platforms });
        } else {
          res.status(500).json({
            success: false,
            platforms: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      }
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
            this.transformPlatform(platform)
          );
          res.json({ success: true, platforms });
        } else {
          res.status(500).json({
            success: false,
            platforms: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      }
    );

    const respondFromCliTask = (
      res: Response,
      result: CliCommandResult
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

        const platformSpec = version ? `${platformId}@${version}` : platformId;
        const result = await this.runCliCommand(
          ["core", "install", platformSpec],
          { addJson: false, timeoutMs: 300_000 }
        );

        // Sync config after successful install
        if (result.success) {
          await this.syncInstalledToConfig();
        }

        respondFromCliTask(res, result);
      }
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

        const result = await this.runCliCommand(
          ["core", "upgrade", platformId],
          { addJson: false, timeoutMs: 300_000 }
        );
        respondFromCliTask(res, result);
      }
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

        const result = await this.runCliCommand(
          ["core", "uninstall", platformId],
          { addJson: false, timeoutMs: 120_000 }
        );

        // Sync config after successful uninstall
        if (result.success) {
          await this.syncInstalledToConfig();
        }

        respondFromCliTask(res, result);
      }
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
      }
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
      }
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
            this.transformLibrary(library)
          );
          res.json({ success: true, libraries });
        } else {
          res.status(500).json({
            success: false,
            libraries: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      }
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
      }
    );

    const respondFromCliTask = (
      res: Response,
      result: CliCommandResult
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

        const libSpec = version ? `${name}@${version}` : name;
        const args = ["lib", "install", libSpec];
        if (installDeps === false) {
          args.push("--no-deps");
        }

        const result = await this.runCliCommand(args, {
          addJson: false,
          timeoutMs: 240_000,
        });

        // Sync config after successful install
        if (result.success) {
          await this.syncInstalledToConfig();
        }

        respondFromCliTask(res, result);
      }
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

        const result = await this.runCliCommand(["lib", "upgrade", name], {
          addJson: false,
          timeoutMs: 240_000,
        });
        respondFromCliTask(res, result);
      }
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
                  { addJson: true, timeoutMs: 15_000 }
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
                  { addJson: false, timeoutMs: 60_000 }
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
        await this.syncInstalledToConfig();

        res.json({
          success: true,
          duration: result.duration,
          log: result.log,
          removedDependencies: removedDeps,
        });
      }
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
          { addJson: false, timeoutMs: 240_000 }
        );
        respondFromCliTask(res, result);
      }
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
          { addJson: false, timeoutMs: 240_000 }
        );
        respondFromCliTask(res, result);
      }
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
          { addJson: false, timeoutMs: 15_000 }
        );

        if (result.success) {
          const rawOutput = (result.rawOutput || result.log || "").replace(
            /\x1b\[[0-9;]*m/g,
            ""
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
              Boolean(example)
            );

          res.json({ success: true, examples });
        } else {
          res.status(500).json({
            success: false,
            examples: [],
            error: this.parseCliError(result.error || result.log),
          });
        }
      }
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
          /Version:\s*(\S+)/i
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
   * List available boards
   */
  private async listBoards(): Promise<BoardInfo[]> {
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

      return boards.map((board: any) => ({
        fqbn: board.fqbn,
        name: board.name,
        platform: board.platform?.name,
      }));
    }

    this.log(
      `Error listing boards: ${this.parseCliError(result.error || result.log)}`
    );

    return [
      { fqbn: "arduino:avr:uno", name: "Arduino Uno" },
      { fqbn: "arduino:avr:nano", name: "Arduino Nano" },
      { fqbn: "arduino:avr:mega", name: "Arduino Mega 2560" },
      { fqbn: "arduino:renesas_uno:unor4wifi", name: "Arduino Uno R4 WiFi" },
    ];
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
   * List sketches in workspace
   */
  private async listSketches(): Promise<SketchInfo[]> {
    const sketches: SketchInfo[] = [];

    const scanDir = (dir: string, depth: number = 0): void => {
      if (depth > MAX_SCAN_DEPTH) {
        return;
      }

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          if (IGNORE_DIRS.has(entry.name)) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const inoFile = path.join(fullPath, `${entry.name}.ino`);

          if (fs.existsSync(inoFile)) {
            sketches.push({
              name: entry.name,
              path: path.relative(this.workspaceRoot, fullPath),
              fullPath,
            });
          } else {
            scanDir(fullPath, depth + 1);
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    };

    scanDir(this.workspaceRoot);
    return sketches;
  }

  /**
   * Compile a sketch
   */
  private async compileSketch(
    sketchPath: string,
    fqbn?: string
  ): Promise<CompileResult> {
    const config = vscode.workspace.getConfiguration("arduinoBridge");
    const boardFqbn = fqbn || config.get("defaultBoard") || "arduino:avr:uno";

    // Resolve sketch path
    let fullSketchPath = sketchPath;
    if (!path.isAbsolute(sketchPath)) {
      fullSketchPath = path.join(this.workspaceRoot, sketchPath);
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

  private async ensurePortAvailable(port: number): Promise<void> {
    const conflicting = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0
    );

    if (conflicting.length === 0) {
      return;
    }

    this.log(
      `Port ${port} is currently in use by PIDs ${conflicting.join(
        ", "
      )} - attempting to terminate`
    );

    for (const pid of conflicting) {
      await this.terminateProcess(pid, "SIGTERM");
    }

    await this.delay(500);

    const stillRunning = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0
    );

    if (stillRunning.length === 0) {
      return;
    }

    this.log(
      `Port ${port} still occupied after SIGTERM. Forcing termination of ${stillRunning.join(
        ", "
      )}`
    );

    for (const pid of stillRunning) {
      await this.terminateProcess(pid, "SIGKILL");
    }

    await this.delay(300);

    const finalCheck = (await this.findProcessesUsingPort(port)).filter(
      (pid) => pid !== process.pid && pid > 0
    );

    if (finalCheck.length > 0) {
      throw new Error(
        `Unable to free port ${port}. Still in use by ${finalCheck.join(", ")}`
      );
    }
  }

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

  private async terminateProcess(
    pid: number,
    signal: NodeJS.Signals
  ): Promise<void> {
    if (pid === process.pid) {
      return;
    }

    try {
      process.kill(pid, signal);
      this.log(`Sent ${signal} to process ${pid}`);
    } catch (error: any) {
      this.log(
        `Failed to send ${signal} to process ${pid}: ${error?.message || error}`
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Server is already running");
    }

    await this.ensurePortAvailable(this.port);

    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(this.port);
      this.server = server;

      const handleError = (error: NodeJS.ErrnoException): void => {
        server.off("listening", handleListening);
        reject(error);
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
   * Get workspace root path
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Sync installed platforms and libraries to the config file
   */
  private async syncInstalledToConfig(): Promise<void> {
    try {
      // Get installed platforms
      const platformsResult = await this.runCliCommand(["core", "list"], {
        addJson: true,
        timeoutMs: 30_000,
      });

      const platforms: Array<{ id: string; version: string | null }> = [];
      if (platformsResult.success && platformsResult.data?.platforms) {
        for (const p of platformsResult.data.platforms) {
          platforms.push({
            id: p.id,
            version: p.installed_version || p.installedVersion || null,
          });
        }
      }

      // Get installed libraries
      const librariesResult = await this.runCliCommand(["lib", "list"], {
        addJson: true,
        timeoutMs: 30_000,
      });

      const libraries: Array<{ name: string; version: string | null }> = [];
      if (
        librariesResult.success &&
        librariesResult.data?.installed_libraries
      ) {
        for (const item of librariesResult.data.installed_libraries) {
          const lib = item.library || item;
          libraries.push({
            name: lib.name,
            version: lib.version || null,
          });
        }
      }

      // Write to config file
      await writeEnvironmentConfig(this.workspaceRoot, {
        version: 1,
        platforms,
        libraries,
      });

      this.log(
        `Config synced: ${platforms.length} platforms, ${libraries.length} libraries`
      );
    } catch (error: any) {
      this.log(`Failed to sync config: ${error.message}`);
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
