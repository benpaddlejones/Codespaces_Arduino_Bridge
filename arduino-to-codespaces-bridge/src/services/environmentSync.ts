/**
 * Environment synchronization service
 *
 * Applies the workspace arduino-bridge configuration by ensuring
 * required board platforms and libraries are installed via the
 * bridge server API.
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

export class EnvironmentSyncController {
  private syncing = false;
  private pending = false;
  private needsSyncOnStart = true;

  constructor(
    private readonly workspaceRoot: string,
    private readonly server: BridgeServer,
    private readonly output: vscode.OutputChannel
  ) {}

  /**
   * Ensure the config file exists and set up watcher hooks
   */
  static async create(
    context: vscode.ExtensionContext,
    server: BridgeServer,
    output: vscode.OutputChannel
  ): Promise<EnvironmentSyncController | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      output.appendLine(
        "[Env Sync] No workspace folder detected; skipping environment sync"
      );
      return undefined;
    }

    const controller = new EnvironmentSyncController(
      workspace.uri.fsPath,
      server,
      output
    );

    try {
      await ensureEnvironmentConfig(workspace.uri.fsPath);
    } catch (error: any) {
      output.appendLine(
        `[Env Sync] Failed to ensure ${CONFIG_FILE_NAME}: ${error.message}`
      );
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, CONFIG_FILE_NAME)
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
            "[Env Sync] Server not running; deferring environment sync"
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
          `[Env Sync] Failed to read ${CONFIG_FILE_NAME}: ${error.message}`
        );
        return;
      }

      await this.applyConfig(config);
    } finally {
      this.syncing = false;
      if (this.pending) {
        this.pending = false;
        void this.syncInternal();
      }
    }
  }

  private async applyConfig(config: EnvironmentConfig): Promise<void> {
    const port = this.server.getPort();

    const installedPlatforms = await this.fetchInstalledPlatforms(port);
    const installedLibraries = await this.fetchInstalledLibraries(port);

    const missingPlatforms = config.platforms.filter(
      (platform) => !this.isPlatformSatisfied(platform, installedPlatforms)
    );

    const missingLibraries = config.libraries.filter(
      (library) => !this.isLibrarySatisfied(library, installedLibraries)
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

        if (missingPlatforms.length > 0) {
          this.output.appendLine(
            `[Env Sync] Installing board platforms: ${missingPlatforms
              .map((p) => (p.version ? `${p.id}@${p.version}` : p.id))
              .join(", ")}`
          );

          for (const platform of missingPlatforms) {
            const label = platform.version
              ? `${platform.id}@${platform.version}`
              : platform.id;
            progress.report({
              message: `Installing platform: ${label}`,
              increment: (100 / totalItems) * 0.1,
            });

            await this.installPlatform(port, platform);
            completed++;
            progress.report({
              increment: (100 / totalItems) * 0.9,
            });
          }
        }

        if (missingLibraries.length > 0) {
          this.output.appendLine(
            `[Env Sync] Installing libraries: ${missingLibraries
              .map((l) => (l.version ? `${l.name}@${l.version}` : l.name))
              .join(", ")}`
          );

          for (const library of missingLibraries) {
            const label = library.version
              ? `${library.name}@${library.version}`
              : library.name;
            progress.report({
              message: `Installing library: ${label}`,
              increment: (100 / totalItems) * 0.1,
            });

            await this.installLibrary(port, library);
            completed++;
            progress.report({
              increment: (100 / totalItems) * 0.9,
            });
          }
        }

        vscode.window.showInformationMessage(
          `Arduino Bridge: Installed ${completed} item(s) from config`
        );
      }
    );
  }

  private async fetchInstalledPlatforms(
    port: number
  ): Promise<Array<{ id: string; installedVersion?: string | null }>> {
    try {
      const response = await fetch(
        `http://localhost:${port}/api/cli/cores/installed`
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
        `[Env Sync] Failed to query installed platforms: ${error.message}`
      );
      return [];
    }
  }

  private async fetchInstalledLibraries(
    port: number
  ): Promise<Array<{ name: string; installedVersion?: string | null }>> {
    try {
      const response = await fetch(
        `http://localhost:${port}/api/cli/libraries/installed`
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
        `[Env Sync] Failed to query installed libraries: ${error.message}`
      );
      return [];
    }
  }

  private async installPlatform(
    port: number,
    platform: PlatformRequirement
  ): Promise<void> {
    const target = platform.version
      ? `${platform.id}@${platform.version}`
      : platform.id;

    try {
      const response = await fetch(
        `http://localhost:${port}/api/cli/cores/install`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            platformId: platform.id,
            version: platform.version ?? null,
          }),
        }
      );

      const result = (await response.json()) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        this.output.appendLine(`[Env Sync] ✓ Installed ${target}`);
      } else {
        this.output.appendLine(
          `[Env Sync] ⚠️ Failed to install ${target}: ${
            result.error || "Unknown error"
          }`
        );
      }
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] ⚠️ Failed to install ${target}: ${error.message}`
      );
    }
  }

  private async installLibrary(
    port: number,
    library: LibraryRequirement
  ): Promise<void> {
    const target = library.version
      ? `${library.name}@${library.version}`
      : library.name;

    try {
      const response = await fetch(
        `http://localhost:${port}/api/cli/libraries/install`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            name: library.name,
            version: library.version ?? null,
            installDeps: true,
          }),
        }
      );

      const result = (await response.json()) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        this.output.appendLine(`[Env Sync] ✓ Installed ${target}`);
      } else {
        this.output.appendLine(
          `[Env Sync] ⚠️ Failed to install ${target}: ${
            result.error || "Unknown error"
          }`
        );
      }
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] ⚠️ Failed to install ${target}: ${error.message}`
      );
    }
  }

  private isPlatformSatisfied(
    requirement: PlatformRequirement,
    installed: Array<{ id: string; installedVersion?: string | null }>
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

  private isLibrarySatisfied(
    requirement: LibraryRequirement,
    installed: Array<{ name: string; installedVersion?: string | null }>
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
        "[Env Sync] Server not running; cannot sync installed items to config"
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
        config = { version: 1, platforms: [], libraries: [] };
      }

      // Build new platforms list from installed platforms
      const newPlatforms: PlatformRequirement[] = installedPlatforms.map(
        (platform) => ({
          id: platform.id,
          version: platform.installedVersion || null,
        })
      );

      // Build new libraries list from installed libraries
      const newLibraries: LibraryRequirement[] = installedLibraries.map(
        (library) => ({
          name: library.name,
          version: library.installedVersion || null,
        })
      );

      // Update config
      config.platforms = newPlatforms;
      config.libraries = newLibraries;

      // Write config
      await writeEnvironmentConfig(this.workspaceRoot, config);

      this.output.appendLine(
        `[Env Sync] Updated config with ${newPlatforms.length} platforms, ${newLibraries.length} libraries`
      );
    } catch (error: any) {
      this.output.appendLine(
        `[Env Sync] Failed to sync installed items to config: ${error.message}`
      );
    }
  }
}
