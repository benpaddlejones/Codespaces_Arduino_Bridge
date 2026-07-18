/**
 * Environment Synchronization Service
 *
 * Automatically synchronizes the workspace Arduino environment with the
 * arduino-requirements.txt configuration file. This ensures that required
 * board platforms and libraries are installed when opening a workspace.
 *
 * Key Responsibilities:
 * - **Config-to-Environment Sync**: Installs missing platforms and libraries
 *   declared in the config file when the server starts
 * - **Environment-to-Config Sync**: Updates the config file after install/uninstall
 *   operations to reflect the current environment state
 * - **File Watching**: Monitors config file changes and triggers re-sync
 * - **Progress Reporting**: Shows installation progress in VS Code notifications
 *
 * Sync Flow:
 * 1. On server start, reads arduino-requirements.txt
 * 2. Compares declared requirements with installed items
 * 3. Installs any missing platforms or libraries
 * 4. After any install/uninstall, updates config to match reality
 *
 * @module services/environmentSync
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";
import {
  CONFIG_FILE_NAME,
  EnvironmentConfig,
  ensureEnvironmentConfig,
  readEnvironmentConfig,
  writeEnvironmentConfig,
  PlatformRequirement,
  LibraryRequirement,
} from "../config/environmentConfig";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Keeps the installed Arduino platforms and libraries in sync with the
 * workspace `arduino-requirements.txt` config file, reacting to file changes
 * and server lifecycle events.
 */
export class EnvironmentSyncController {
  private syncing = false;
  private pending = false;
  private needsSyncOnStart = true;

  constructor(
    private readonly workspaceRoot: string,
    private readonly server: BridgeServer,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Ensure the config file exists and set up watcher hooks
   */
  static async create(
    context: vscode.ExtensionContext,
    server: BridgeServer,
    output: vscode.OutputChannel,
  ): Promise<EnvironmentSyncController | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      output.appendLine(
        "[Env Sync] No workspace folder detected; skipping environment sync",
      );
      return undefined;
    }

    const controller = new EnvironmentSyncController(
      workspace.uri.fsPath,
      server,
      output,
    );

    try {
      await ensureEnvironmentConfig(workspace.uri.fsPath);
    } catch (error: any) {
      output.appendLine(
        `[Env Sync] Failed to ensure ${CONFIG_FILE_NAME}: ${error.message}`,
      );
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, CONFIG_FILE_NAME),
    );

    const scheduleSync = () => {
      controller.scheduleSync();
    };

    watcher.onDidCreate(scheduleSync);
    watcher.onDidChange(scheduleSync);
    watcher.onDidDelete(scheduleSync);

    context.subscriptions.push(watcher);

    return controller;
  }

  /** Schedule a sync run */
  scheduleSync(): void {
    if (this.syncing) {
      this.pending = true;
      return;
    }

    void this.syncInternal();
  }

  /** Force a sync attempt (used after server start) */
  async runSyncNow(): Promise<void> {
    await this.syncInternal(true);
  }

  /**
   * Run a single sync pass: read the config, then install anything missing.
   *
   * @param force When true, log a message if the server is not yet running.
   */
  private async syncInternal(force: boolean = false): Promise<void> {
    if (this.syncing) {
      this.pending = true;
      return;
    }

    this.syncing = true;

    try {
      if (!this.server.isRunning()) {
        this.needsSyncOnStart = true;
        if (force) {
          this.output.appendLine(
            "[Env Sync] Server not running; deferring environment sync",
          );
        }
        return;
      }

      if (!force && !this.needsSyncOnStart && !this.pending) {
        return;
      }

      this.needsSyncOnStart = false;
      this.pending = false;

      let config: EnvironmentConfig;
      try {
        config = await readEnvironmentConfig(this.workspaceRoot);
      } catch (error: any) {
        this.output.appendLine(
          `[Env Sync] Failed to read ${CONFIG_FILE_NAME}: ${error.message}`,
        );
        return;
      }

      // Seed the server's learned-device map from the file (the file is the
      // source of truth at sync time; runtime uploads update both)
      this.server.seedLearnedDevices(config.devices || []);

      await this.applyConfig(config);
    } finally {
      this.syncing = false;
      if (this.pending) {
        this.pending = false;
        void this.syncInternal();
      }
    }
  }

  /**
   * Install any platforms and libraries required by the config that are not
   * already present, showing progress to the user.
   *
   * @param config The parsed environment configuration to apply.
   */
  private async applyConfig(config: EnvironmentConfig): Promise<void> {
    const port = this.server.getPort();

    const installedPlatforms = await this.fetchInstalledPlatforms(port);
    const installedLibraries = await this.fetchInstalledLibraries(port);

    const missingPlatforms = config.platforms.filter(
      (platform) => !this.isPlatformSatisfied(platform, installedPlatforms),
    );

    const missingLibraries = config.libraries.filter(
      (library) => !this.isLibrarySatisfied(library, installedLibraries),
    );

    if (missingPlatforms.length === 0 && missingLibraries.length === 0) {
      this.output.appendLine("[Env Sync] Environment already up to date");
      return;
    }

    const totalItems = missingPlatforms.length + missingLibraries.length;

    // Show progress notification to user
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Arduino Bridge: Syncing Environment",
        cancellable: false,
      },
      async (progress) => {
        let completed = 0;
        const errors: string[] = [];

        if (missingPlatforms.length > 0) {
          this.output.appendLine(
            `[Env Sync] Installing board platforms: ${missingPlatforms
              .map((p) => (p.version ? `${p.id}@${p.version}` : p.id))
              .join(", ")}`,
          );

          for (const platform of missingPlatforms) {
            const label = platform.version
              ? `${platform.id}@${platform.version}`
              : platform.id;
            progress.report({
              message: `Installing platform: ${label}`,
              increment: (100 / totalItems) * 0.1,
            });

            const error = await this.installPlatform(port, platform);
            if (error) {
              errors.push(`Platform ${label}: ${error}`);
            } else {
              completed++;
            }
            progress.report({
              increment: (100 / totalItems) * 0.9,
            });
          }
        }

        if (missingLibraries.length > 0) {
          this.output.appendLine(
            `[Env Sync] Installing libraries: ${missingLibraries
              .map((l) => (l.version ? `${l.name}@${l.version}` : l.name))
              .join(", ")}`,
          );

          for (const library of missingLibraries) {
            const label = library.version
              ? `${library.name}@${library.version}`
              : library.name;
            progress.report({
              message: `Installing library: ${label}`,
              increment: (100 / totalItems) * 0.1,
            });

            const error = await this.installLibrary(port, library);
            if (error) {
              errors.push(`Library ${label}: ${error}`);
            } else {
              completed++;
            }
            progress.report({
              increment: (100 / totalItems) * 0.9,
            });
          }
        }

        if (errors.length > 0) {
          const message = `Arduino Bridge Sync encountered errors:\n${errors.join("\n")}`;
          this.output.appendLine(`[Env Sync] ${message}`);
          vscode.window.showErrorMessage(message);
        } else {
          vscode.window.showInformationMessage(
            `Arduino Bridge: Installed ${completed} item(s) from config`,
          );
        }
      },
    );
  }

  /**
   * Query the running server for the currently installed board platforms.
   *
   * @param port Port the bridge server is listening on.
   * @returns Installed platforms, or an empty array on failure.
   */
  private async fetchInstalledPlatforms(
    port: number,
  ): Promise<Array<{ id: string; installedVersion?: string | null }>> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/cli/cores/installed`,
      );
      const data = (await response.json()) as {
        success: boolean;
        platforms?: Array<{ id: string; installedVersion?: string | null }>;
      };

      if (!data.success || !Array.isArray(data.platforms)) {
        return [];
      }

      return data.platforms;
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] Failed to query installed platforms: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Query the running server for the currently installed libraries.
   *
   * @param port Port the bridge server is listening on.
   * @returns Installed libraries, or an empty array on failure.
   */
  private async fetchInstalledLibraries(
    port: number,
  ): Promise<Array<{ name: string; installedVersion?: string | null }>> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/cli/libraries/installed`,
      );
      const data = (await response.json()) as {
        success: boolean;
        libraries?: Array<{ name: string; installedVersion?: string | null }>;
      };

      if (!data.success || !Array.isArray(data.libraries)) {
        return [];
      }

      return data.libraries;
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] Failed to query installed libraries: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Install a single board platform via the server API.
   *
   * @param port Port the bridge server is listening on.
   * @param platform The platform requirement to install.
   * @returns Null on success, otherwise an error message.
   */
  private async installPlatform(
    port: number,
    platform: PlatformRequirement,
  ): Promise<string | null> {
    const target = platform.version
      ? `${platform.id}@${platform.version}`
      : platform.id;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/cli/cores/install`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            platformId: platform.id,
            version: platform.version ?? null,
          }),
        },
      );

      const result = (await response.json()) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        this.output.appendLine(`[Env Sync] ✓ Installed ${target}`);
        return null;
      } else {
        const msg = result.error || "Unknown error";
        this.output.appendLine(
          `[Env Sync] ⚠️ Failed to install ${target}: ${msg}`,
        );
        return msg;
      }
    } catch (error: any) {
      const msg = error.message;
      this.output.appendLine(
        `[Env Sync] ⚠️ Failed to install ${target}: ${msg}`,
      );
      return msg;
    }
  }

  /**
   * Install a single library via the server API.
   *
   * @param port Port the bridge server is listening on.
   * @param library The library requirement to install.
   * @returns Null on success, otherwise an error message.
   */
  private async installLibrary(
    port: number,
    library: LibraryRequirement,
  ): Promise<string | null> {
    const target = library.version
      ? `${library.name}@${library.version}`
      : library.name;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/cli/libraries/install`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            name: library.name,
            version: library.version ?? null,
            installDeps: true,
          }),
        },
      );

      const result = (await response.json()) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        this.output.appendLine(`[Env Sync] ✓ Installed ${target}`);
        return null;
      } else {
        const msg = result.error || "Unknown error";
        this.output.appendLine(
          `[Env Sync] ⚠️ Failed to install ${target}: ${msg}`,
        );
        return msg;
      }
    } catch (error: any) {
      const msg = error.message;
      this.output.appendLine(
        `[Env Sync] ⚠️ Failed to install ${target}: ${msg}`,
      );
      return msg;
    }
  }

  /**
   * Determine whether an installed platform satisfies a requirement.
   *
   * @param requirement The required platform (with optional version).
   * @param installed The list of installed platforms.
   * @returns True if the requirement is satisfied.
   */
  private isPlatformSatisfied(
    requirement: PlatformRequirement,
    installed: Array<{ id: string; installedVersion?: string | null }>,
  ): boolean {
    return installed.some((platform) => {
      if (platform.id !== requirement.id) {
        return false;
      }

      if (!requirement.version) {
        return true;
      }

      return platform.installedVersion === requirement.version;
    });
  }

  /**
   * Determine whether an installed library satisfies a requirement.
   *
   * @param requirement The required library (with optional version).
   * @param installed The list of installed libraries.
   * @returns True if the requirement is satisfied.
   */
  private isLibrarySatisfied(
    requirement: LibraryRequirement,
    installed: Array<{ name: string; installedVersion?: string | null }>,
  ): boolean {
    return installed.some((library) => {
      if (library.name !== requirement.name) {
        return false;
      }

      if (!requirement.version) {
        return true;
      }

      return library.installedVersion === requirement.version;
    });
  }

  /**
   * Sync installed platforms and libraries back to the config file.
   * Call this after install/uninstall operations to persist environment state.
   */
  async syncInstalledToConfig(): Promise<void> {
    if (!this.server.isRunning()) {
      this.output.appendLine(
        "[Env Sync] Server not running; cannot sync installed items to config",
      );
      return;
    }

    const port = this.server.getPort();

    try {
      const installedPlatforms = await this.fetchInstalledPlatforms(port);
      const installedLibraries = await this.fetchInstalledLibraries(port);

      // Read current config
      let config: EnvironmentConfig;
      try {
        config = await readEnvironmentConfig(this.workspaceRoot);
      } catch {
        config = { version: 1, platforms: [], libraries: [], devices: [] };
      }

      // Build new platforms list from installed platforms
      const newPlatforms: PlatformRequirement[] = installedPlatforms.map(
        (platform) => ({
          id: platform.id,
          version: platform.installedVersion || null,
        }),
      );

      // Build new libraries list from installed libraries
      const newLibraries: LibraryRequirement[] = installedLibraries.map(
        (library) => ({
          name: library.name,
          version: library.installedVersion || null,
        }),
      );

      // Update config
      config.platforms = newPlatforms;
      config.libraries = newLibraries;

      // Merge learned devices: file entries first, runtime map wins per key
      const deviceMap = new Map(
        (config.devices || []).map((d) => [d.key, d.fqbn]),
      );
      for (const d of this.server.getLearnedDevices()) {
        deviceMap.set(d.key, d.fqbn);
      }
      config.devices = [...deviceMap.entries()]
        .map(([key, fqbn]) => ({ key, fqbn }))
        .sort((a, b) => a.key.localeCompare(b.key));

      // Write config
      await writeEnvironmentConfig(this.workspaceRoot, config);

      this.output.appendLine(
        `[Env Sync] Updated config with ${newPlatforms.length} platforms, ${newLibraries.length} libraries, ${config.devices.length} learned devices`,
      );
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] Failed to sync installed items to config: ${error.message}`,
      );
    }
  }
}
