/**
 * Boards Tree View Provider
 *
 * Displays available Arduino boards in the sidebar tree view.
 * Allows selecting a board as the default for compilation.
 *
 * @module views/BoardsTreeProvider
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";

/**
 * Tree item for board display
 */
class BoardItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fqbn: string,
    public readonly isSelected: boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = fqbn;
    this.tooltip = `${label}\nFQBN: ${fqbn}\nClick to select`;
    this.iconPath = new vscode.ThemeIcon(
      isSelected ? "check" : "circuit-board"
    );
    this.command = {
      command: "arduinoBridge.selectThisBoard",
      title: "Select Board",
      arguments: [fqbn, label],
    };
    this.contextValue = "board";
  }
}

/**
 * Category for grouping boards
 */
class BoardCategory extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly boards: BoardItem[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

type BoardTreeItem = BoardItem | BoardCategory;

/**
 * Provides tree items for the boards view
 */
export class BoardsTreeProvider
  implements vscode.TreeDataProvider<BoardTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    BoardTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private server: BridgeServer;
  private boards: Map<string, BoardItem[]> = new Map();

  constructor(server: BridgeServer) {
    this.server = server;

    // Register the select board command
    vscode.commands.registerCommand(
      "arduinoBridge.selectThisBoard",
      this.selectBoard.bind(this)
    );
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this.boards.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Select a board as default
   */
  private async selectBoard(fqbn: string, name: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("arduinoBridge");
    await config.update(
      "defaultBoard",
      fqbn,
      vscode.ConfigurationTarget.Workspace
    );
    vscode.window.showInformationMessage(`Board set to: ${name}`);
    this.refresh();
  }

  /**
   * Get tree item representation
   */
  getTreeItem(element: BoardTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: BoardTreeItem): Promise<BoardTreeItem[]> {
    if (element instanceof BoardCategory) {
      return element.boards;
    }

    if (element) {
      return [];
    }

    // Root level - fetch ONLY installed boards from the server
    const config = vscode.workspace.getConfiguration("arduinoBridge");
    const currentFqbn = config.get<string>("defaultBoard");

    const installedBoards: Array<{
      name: string;
      fqbn: string;
      category: string;
    }> = [];

    // Fetch installed platforms and their boards from the server
    if (this.server.isRunning()) {
      try {
        const port = this.server.getPort();

        // First, get installed platforms
        const platformsResponse = await fetch(
          `http://localhost:${port}/api/cli/cores/installed`
        );
        const platformsData = (await platformsResponse.json()) as {
          success: boolean;
          platforms?: Array<{
            id: string;
            name?: string;
            boards?: Array<{ name: string; fqbn: string }>;
          }>;
        };

        if (platformsData.success && Array.isArray(platformsData.platforms)) {
          for (const platform of platformsData.platforms) {
            const categoryName = platform.name || platform.id;

            // If the platform has boards array, use it
            if (platform.boards && Array.isArray(platform.boards)) {
              for (const board of platform.boards) {
                installedBoards.push({
                  name: board.name,
                  fqbn: board.fqbn,
                  category: categoryName,
                });
              }
            }
          }
        }

        // Also fetch from /api/boards for any additional board info
        const boardsResponse = await fetch(
          `http://localhost:${port}/api/boards`
        );
        const boardsData = (await boardsResponse.json()) as {
          success: boolean;
          boards?: Array<{ name: string; fqbn: string; platform?: string }>;
        };

        if (boardsData.success && Array.isArray(boardsData.boards)) {
          for (const board of boardsData.boards) {
            // Only add if not already present
            if (!installedBoards.find((b) => b.fqbn === board.fqbn)) {
              const parts = board.fqbn.split(":");
              const category =
                parts.length >= 2 ? `${parts[0]}:${parts[1]}` : "Other";
              installedBoards.push({
                name: board.name,
                fqbn: board.fqbn,
                category: board.platform || category,
              });
            }
          }
        }
      } catch {
        // Server not available - show empty or placeholder
      }
    }

    // If no boards installed, show a helpful message item
    if (installedBoards.length === 0) {
      return [
        new BoardItem(
          "No boards installed",
          "Install a platform using the Command Palette",
          false
        ),
      ];
    }

    // Group by category
    const categories = new Map<string, BoardItem[]>();

    for (const board of installedBoards) {
      const isSelected = board.fqbn === currentFqbn;
      const item = new BoardItem(board.name, board.fqbn, isSelected);

      if (!categories.has(board.category)) {
        categories.set(board.category, []);
      }
      categories.get(board.category)!.push(item);
    }

    // Convert to tree items
    const result: BoardTreeItem[] = [];
    for (const [category, boards] of categories) {
      if (boards.length === 1) {
        result.push(boards[0]);
      } else {
        result.push(new BoardCategory(category, boards));
      }
    }

    return result;
  }
}
