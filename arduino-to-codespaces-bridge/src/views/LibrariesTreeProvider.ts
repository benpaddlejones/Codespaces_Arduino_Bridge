/**
 * Libraries Tree View Provider
 *
 * Displays Arduino libraries installed via arduino-cli.
 * Allows refreshing to show current installed set.
 *
 * @module views/LibrariesTreeProvider
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";

/**
 * Tree item representing an installed library
 */
class LibraryItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly installedVersion: string | null,
    public readonly latestVersion: string | null,
    public readonly location: string | null
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = installedVersion
      ? `v${installedVersion}${
          latestVersion && latestVersion !== installedVersion
            ? ` → v${latestVersion}`
            : ""
        }`
      : "Not installed";
    this.tooltip = [
      `Library: ${label}`,
      installedVersion ? `Installed: ${installedVersion}` : "",
      latestVersion && latestVersion !== installedVersion
        ? `Latest: ${latestVersion}`
        : "",
      location ? `Location: ${location}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.iconPath = new vscode.ThemeIcon(
      latestVersion && installedVersion && latestVersion !== installedVersion
        ? "arrow-circle-up"
        : "book"
    );
    this.contextValue = "library";
  }
}

/**
 * Informational item when no libraries can be shown
 */
class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon: string = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "info";
  }
}

type LibrariesTreeItem = LibraryItem | InfoItem;

/**
 * Provides data for the libraries view
 */
export class LibrariesTreeProvider
  implements vscode.TreeDataProvider<LibrariesTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    LibrariesTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private libraries: LibraryItem[] = [];

  constructor(private readonly server: BridgeServer) {}

  /**
   * Refresh the tree by clearing cached data and re-fetching
   */
  refresh(): void {
    this.libraries = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LibrariesTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: LibrariesTreeItem): Promise<LibrariesTreeItem[]> {
    if (element) {
      return [];
    }

    if (!this.server.isRunning()) {
      return [
        new InfoItem(
          "Bridge server is not running. Start the server to load libraries.",
          "plug"
        ),
      ];
    }

    if (this.libraries.length === 0) {
      await this.loadLibraries();
    }

    if (this.libraries.length === 0) {
      return [new InfoItem("No libraries installed yet.")];
    }

    return this.libraries;
  }

  private async loadLibraries(): Promise<void> {
    try {
      const port = this.server.getPort();
      const response = await fetch(
        `http://localhost:${port}/api/cli/libraries/installed`
      );
      const data = (await response.json()) as {
        success: boolean;
        libraries?: Array<{
          name: string;
          installedVersion?: string | null;
          latestVersion?: string | null;
          location?: string | null;
        }>;
      };

      if (!data.success || !Array.isArray(data.libraries)) {
        throw new Error("Response did not contain library data");
      }

      this.libraries = data.libraries
        .map(
          (lib) =>
            new LibraryItem(
              lib.name,
              lib.installedVersion ?? null,
              lib.latestVersion ?? null,
              lib.location ?? null
            )
        )
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch (error: any) {
      vscode.window.showWarningMessage(
        `Failed to load libraries: ${error.message}`
      );
      this.libraries = [];
    }
  }
}
