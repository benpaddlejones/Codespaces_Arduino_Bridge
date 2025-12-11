/**
 * Arduino to Codespaces Bridge - VS Code Extension
 *
 * Main extension entry point that provides:
 * - Server lifecycle management
 * - Commands for opening bridge, compiling sketches
 * - Status bar integration
 * - Tree views for boards and sketches
 *
 * @module extension
 * @version 1.0.0
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { BridgeServer } from "./server";
import { StatusTreeProvider } from "./views/StatusTreeProvider";
import { BoardsTreeProvider } from "./views/BoardsTreeProvider";
import { LibrariesTreeProvider } from "./views/LibrariesTreeProvider";
import { openBridge } from "./commands/openBridge";
import { selectBoard } from "./commands/selectBoard";
import { compileSketch } from "./commands/compileSketch";
import { EnvironmentSyncController } from "./services/environmentSync";

// =============================================================================
// Module State
// =============================================================================

/** @type {BridgeServer | undefined} */
let server: BridgeServer | undefined;

/** @type {vscode.StatusBarItem} */
let statusBarItem: vscode.StatusBarItem;

/** @type {StatusTreeProvider} */
let statusProvider: StatusTreeProvider;

/** @type {BoardsTreeProvider} */
let boardsProvider: BoardsTreeProvider;

/** @type {LibrariesTreeProvider} */
let librariesProvider: LibrariesTreeProvider;

/** @type {vscode.OutputChannel} */
let outputChannel: vscode.OutputChannel;

/** @type {EnvironmentSyncController | undefined} */
let environmentSync: EnvironmentSyncController | undefined;

// =============================================================================
// Extension Activation
// =============================================================================

/**
 * Called when the extension is activated
 * @param {vscode.ExtensionContext} context - Extension context
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Arduino Bridge");
  outputChannel.appendLine("Arduino to Codespaces Bridge is now active");

  // Set up clang-format configuration for Arduino code style
  await setupClangFormat(context, outputChannel);

  // Initialize server
  server = new BridgeServer(context, outputChannel);

  // Create status bar item
  const config = vscode.workspace.getConfiguration("arduinoBridge");
  if (config.get("showStatusBar", true)) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    statusBarItem.text = "$(plug) Arduino Bridge";
    statusBarItem.command = "arduinoBridge.openBridge";
    statusBarItem.tooltip = "Click to open Arduino Bridge";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }

  // Initialize tree view providers
  statusProvider = new StatusTreeProvider(server);
  boardsProvider = new BoardsTreeProvider(server);
  librariesProvider = new LibrariesTreeProvider(server);

  environmentSync = await EnvironmentSyncController.create(
    context,
    server,
    outputChannel
  );

  // Register tree views
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "arduinoBridge.status",
      statusProvider
    ),
    vscode.window.registerTreeDataProvider(
      "arduinoBridge.boards",
      boardsProvider
    ),
    vscode.window.registerTreeDataProvider(
      "arduinoBridge.libraries",
      librariesProvider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("arduinoBridge.openBridge", () =>
      openBridge(server!, outputChannel)
    ),
    vscode.commands.registerCommand("arduinoBridge.startServer", () =>
      startServer()
    ),
    vscode.commands.registerCommand("arduinoBridge.stopServer", () =>
      stopServer()
    ),
    vscode.commands.registerCommand("arduinoBridge.restartServer", () =>
      restartServer()
    ),
    vscode.commands.registerCommand("arduinoBridge.selectBoard", () =>
      selectBoard(server!)
    ),
    vscode.commands.registerCommand("arduinoBridge.compileSketch", () =>
      compileSketch(server!, outputChannel)
    ),
    vscode.commands.registerCommand(
      "arduinoBridge.refreshLibraries",
      async () => {
        librariesProvider.refresh();
        // Also sync installed items to config
        if (environmentSync) {
          await environmentSync.syncInstalledToConfig();
        }
      }
    ),
    vscode.commands.registerCommand("arduinoBridge.refreshBoards", async () => {
      boardsProvider.refresh();
      // Also sync installed items to config
      if (environmentSync) {
        await environmentSync.syncInstalledToConfig();
      }
    }),
    vscode.commands.registerCommand(
      "arduinoBridge.syncEnvironmentConfig",
      async () => {
        if (environmentSync) {
          await environmentSync.syncInstalledToConfig();
          vscode.window.showInformationMessage(
            "Environment config synced with installed boards and libraries"
          );
        } else {
          vscode.window.showWarningMessage("Environment sync not available");
        }
      }
    )
  );

  // Register output channel
  context.subscriptions.push(outputChannel);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("arduinoBridge")) {
        handleConfigurationChange();
      }
    })
  );

  // Auto-start server if configured
  if (config.get("autoStartServer", true)) {
    await startServer();
  }

  outputChannel.appendLine("Extension activation complete");
}

// =============================================================================
// Server Management
// =============================================================================

/**
 * Start the bridge server
 */
async function startServer(): Promise<void> {
  if (!server) {
    vscode.window.showErrorMessage("Server not initialized");
    return;
  }

  if (server.isRunning()) {
    vscode.window.showInformationMessage("Bridge server is already running");
    return;
  }

  try {
    await server.start();
    updateStatusBar("running");
    statusProvider.refresh();
    await environmentSync?.runSyncNow();
    boardsProvider.refresh();
    librariesProvider.refresh();
    vscode.window.showInformationMessage(
      `Arduino Bridge server started on port ${server.getPort()}`
    );
    outputChannel.appendLine(`Server started on port ${server.getPort()}`);
  } catch (error: any) {
    updateStatusBar("error");
    statusProvider.refresh();
    vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
    outputChannel.appendLine(`Server start error: ${error.message}`);
  }
}

/**
 * Stop the bridge server
 */
async function stopServer(): Promise<void> {
  if (!server) {
    return;
  }

  if (!server.isRunning()) {
    vscode.window.showInformationMessage("Bridge server is not running");
    return;
  }

  try {
    await server.stop();
    updateStatusBar("stopped");
    statusProvider.refresh();
    boardsProvider.refresh();
    librariesProvider.refresh();
    environmentSync?.scheduleSync();
    vscode.window.showInformationMessage("Arduino Bridge server stopped");
    outputChannel.appendLine("Server stopped");
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to stop server: ${error.message}`);
    outputChannel.appendLine(`Server stop error: ${error.message}`);
  }
}

/**
 * Restart the bridge server
 */
async function restartServer(): Promise<void> {
  outputChannel.appendLine("Restarting server...");
  await stopServer();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await startServer();
}

// =============================================================================
// UI Updates
// =============================================================================

/**
 * Update status bar appearance based on server state
 * @param {string} state - Server state: 'running', 'stopped', 'error'
 */
function updateStatusBar(state: "running" | "stopped" | "error"): void {
  if (!statusBarItem) {
    return;
  }

  switch (state) {
    case "running":
      statusBarItem.text = "$(plug) Arduino Bridge";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.tooltip = `Arduino Bridge running on port ${server?.getPort()}`;
      break;
    case "stopped":
      statusBarItem.text = "$(plug) Arduino Bridge (Stopped)";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.tooltip = "Click to start Arduino Bridge";
      break;
    case "error":
      statusBarItem.text = "$(plug) Arduino Bridge (Error)";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      statusBarItem.tooltip = "Arduino Bridge encountered an error";
      break;
  }
}

/**
 * Handle configuration changes
 */
function handleConfigurationChange(): void {
  const config = vscode.workspace.getConfiguration("arduinoBridge");

  // Handle status bar visibility
  if (config.get("showStatusBar", true)) {
    if (!statusBarItem) {
      statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
      );
      statusBarItem.command = "arduinoBridge.openBridge";
    }
    statusBarItem.show();
  } else if (statusBarItem) {
    statusBarItem.hide();
  }
}

// =============================================================================
// Clang Format Setup
// =============================================================================

/**
 * Set up .clang-format configuration in the workspace for Arduino code styling
 */
async function setupClangFormat(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    return;
  }

  const targetPath = path.join(workspace.uri.fsPath, ".clang-format");
  const sourcePath = path.join(
    context.extensionPath,
    "resources",
    "clang-format"
  );

  try {
    // Check if .clang-format already exists
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      output.appendLine(
        "[Clang Format] .clang-format already exists, skipping"
      );
      return;
    } catch {
      // File doesn't exist, continue to create it
    }

    // Check if source file exists in extension resources
    try {
      await fs.promises.access(sourcePath, fs.constants.F_OK);
    } catch {
      output.appendLine(
        "[Clang Format] Source config not found in extension resources"
      );
      return;
    }

    // Copy the clang-format config
    const content = await fs.promises.readFile(sourcePath, "utf8");
    await fs.promises.writeFile(targetPath, content, "utf8");
    output.appendLine(
      "[Clang Format] Created .clang-format for Arduino code style"
    );

    // Configure VS Code to use clang-format for .ino files
    const cppConfig = vscode.workspace.getConfiguration("C_Cpp");
    const currentFormatter = cppConfig.get("clang_format_style");
    if (!currentFormatter || currentFormatter === "Visual Studio") {
      await cppConfig.update(
        "clang_format_style",
        "file",
        vscode.ConfigurationTarget.Workspace
      );
      output.appendLine(
        "[Clang Format] Set C_Cpp.clang_format_style to 'file'"
      );
    }
  } catch (error: any) {
    output.appendLine(`[Clang Format] Failed to setup: ${error.message}`);
  }
}

// =============================================================================
// Extension Deactivation
// =============================================================================

/**
 * Called when the extension is deactivated
 */
export function deactivate(): void {
  if (server?.isRunning()) {
    server.stop().catch((err: Error) => {
      console.error("Error stopping server during deactivation:", err);
    });
  }
}
