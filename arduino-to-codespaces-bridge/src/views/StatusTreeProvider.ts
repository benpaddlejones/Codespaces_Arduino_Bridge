/**
 * Status Tree View Provider
 *
 * Displays the current status of the Arduino Bridge server
 * in the sidebar tree view.
 *
 * @module views/StatusTreeProvider
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";

/**
 * Tree item for status display
 */
class StatusItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly value: string,
    public readonly icon?: string,
    public readonly commandId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    if (commandId) {
      this.command = {
        command: commandId,
        title: label,
      };
    }
  }
}

/**
 * Provides tree items for the status view
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    StatusItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private server: BridgeServer;

  constructor(server: BridgeServer) {
    this.server = server;
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item representation
   */
  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: StatusItem): Promise<StatusItem[]> {
    if (element) {
      return [];
    }

    const items: StatusItem[] = [];

    // Server status
    const running = this.server.isRunning();
    items.push(
      new StatusItem(
        "Server",
        running ? "Running" : "Stopped",
        running ? "pass" : "circle-slash"
      )
    );

    if (running) {
      // Port
      items.push(
        new StatusItem("Port", this.server.getPort().toString(), "globe")
      );

      // Check arduino-cli
      try {
        const port = this.server.getPort();
        const response = await fetch(`http://localhost:${port}/api/cli/health`);
        const data = (await response.json()) as {
          available: boolean;
          version?: string;
        };

        items.push(
          new StatusItem(
            "Arduino CLI",
            data.available ? `v${data.version}` : "Not found",
            data.available ? "check" : "warning"
          )
        );
      } catch {
        items.push(new StatusItem("Arduino CLI", "Unknown", "question"));
      }

      // Current board
      const config = vscode.workspace.getConfiguration("arduinoBridge");
      const board = config.get<string>("defaultBoard") || "Not set";
      items.push(new StatusItem("Board", board, "circuit-board"));
    }

    // Actions - clickable item to open bridge or start server
    const actionItem = new StatusItem(
      running ? "Open Arduino Bridge" : "Start Server",
      running ? "Click to open in browser" : "Click to start",
      running ? "link-external" : "play",
      running ? "arduinoBridge.openBridge" : "arduinoBridge.startServer"
    );
    items.push(actionItem);

    return items;
  }
}
