/**
 * Sketches Tree View Provider
 *
 * Displays Arduino sketches found in the workspace.
 * Allows opening and compiling sketches directly from the sidebar.
 *
 * @module views/SketchesTreeProvider
 */

import * as vscode from "vscode";
import * as path from "path";

/**
 * Tree item for sketch display
 */
class SketchItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly sketchPath: string,
    public readonly inoFile: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = path.relative(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
      path.dirname(sketchPath),
    );
    this.tooltip = `${label}\n${sketchPath}\nClick to open`;
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.command = {
      command: "vscode.open",
      title: "Open Sketch",
      arguments: [vscode.Uri.file(inoFile)],
    };
    this.contextValue = "sketch";
  }
}

/**
 * Folder containing sketches
 */
class SketchFolder extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly folderPath: string,
    public readonly sketches: SketchItem[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip = folderPath;
  }
}

type SketchTreeItem = SketchItem | SketchFolder;

/**
 * Provides tree items for the sketches view
 */
export class SketchesTreeProvider implements vscode.TreeDataProvider<SketchTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SketchTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sketches: SketchItem[] = [];

  constructor() {
    // Watch for file changes
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.ino");
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this.sketches = [];
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item representation
   */
  getTreeItem(element: SketchTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: SketchTreeItem): Promise<SketchTreeItem[]> {
    if (element instanceof SketchFolder) {
      return element.sketches;
    }

    if (element) {
      return [];
    }

    // Root level - scan workspace for sketches
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const allSketches = await this.findSketches();

    if (allSketches.length === 0) {
      return [];
    }

    // Group sketches by parent directory
    const groups = new Map<string, SketchItem[]>();

    for (const sketch of allSketches) {
      const parentDir = path.dirname(sketch.sketchPath);
      const _parentName = path.basename(parentDir);

      // Check if it's in a demo/example folder
      const relativePath = path.relative(workspaceRoot, sketch.sketchPath);
      const parts = relativePath.split(path.sep);

      let groupName: string;
      if (parts.length > 1 && parts[0].startsWith("demo")) {
        groupName = "Demo Sketches";
      } else if (parts.length > 1 && parts[0].includes("example")) {
        groupName = "Examples";
      } else if (parts.length > 1 && parts[0].includes("library")) {
        groupName = "Library Examples";
      } else {
        groupName = "Workspace Sketches";
      }

      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName)!.push(sketch);
    }

    // Convert to tree items
    const result: SketchTreeItem[] = [];

    for (const [groupName, sketches] of groups) {
      if (sketches.length === 1 && groups.size === 1) {
        // Just show the sketch directly
        result.push(...sketches);
      } else {
        // Create folder group
        result.push(
          new SketchFolder(
            `${groupName} (${sketches.length})`,
            workspaceRoot,
            sketches.sort((a, b) => a.label.localeCompare(b.label)),
          ),
        );
      }
    }

    return result.sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Find all sketches in the workspace using the VS Code file search API
   */
  private async findSketches(): Promise<SketchItem[]> {
    const sketches: SketchItem[] = [];

    try {
      // Find all .ino files, excluding build output, hidden folders, and
      // the bridge's own web-client (contains bundled tool sketches)
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
          sketches.push(new SketchItem(sketchName, sketchDir, inoPath));
        }
      }
    } catch (error) {
      console.error("Error finding sketches:", error);
    }

    return sketches;
  }
}
