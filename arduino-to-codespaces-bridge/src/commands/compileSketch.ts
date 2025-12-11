/**
 * Compile Sketch Command
 *
 * Compiles the currently active Arduino sketch using arduino-cli.
 * Shows progress and error output in the output channel.
 *
 * @module commands/compileSketch
 */

import * as vscode from "vscode";
import * as path from "path";
import { BridgeServer } from "../server";

/**
 * Compile the active sketch
 * @param server - Bridge server instance
 * @param outputChannel - Output channel for logging
 */
export async function compileSketch(
  server: BridgeServer,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  // Get active editor
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showWarningMessage("No file is currently open");
    return;
  }

  const filePath = editor.document.fileName;

  // Check if it's an Arduino sketch
  if (!filePath.endsWith(".ino")) {
    vscode.window.showWarningMessage(
      "Current file is not an Arduino sketch (.ino)"
    );
    return;
  }

  // Ensure server is running
  if (!server.isRunning()) {
    try {
      await server.start();
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `Failed to start server: ${error.message}`
      );
      return;
    }
  }

  // Get sketch directory (parent of .ino file)
  const sketchDir = path.dirname(filePath);
  const sketchName = path.basename(sketchDir);

  // Get board FQBN from settings
  const config = vscode.workspace.getConfiguration("arduinoBridge");
  const fqbn = config.get<string>("defaultBoard") || "arduino:avr:uno";

  // Show output channel
  outputChannel.show(true);
  outputChannel.appendLine("");
  outputChannel.appendLine("═".repeat(60));
  outputChannel.appendLine(`Compiling: ${sketchName}`);
  outputChannel.appendLine(`Board: ${fqbn}`);
  outputChannel.appendLine("═".repeat(60));

  // Compile with progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Compiling ${sketchName}...`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ increment: 0, message: "Starting compilation..." });

      try {
        const port = server.getPort();
        const response = await fetch(`http://localhost:${port}/api/compile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sketchPath: sketchDir, fqbn }),
        });

        const result = (await response.json()) as {
          success: boolean;
          output?: string[];
          hexPath?: string;
          error?: string;
        };

        progress.report({ increment: 100, message: "Done" });

        // Show output
        if (result.output && Array.isArray(result.output)) {
          for (const line of result.output) {
            outputChannel.appendLine(line);
          }
        }

        outputChannel.appendLine("");

        if (result.success) {
          outputChannel.appendLine("✓ Compilation successful!");
          if (result.hexPath) {
            outputChannel.appendLine(`Output: ${result.hexPath}`);
          }

          vscode.window
            .showInformationMessage(
              `Compilation successful! Open Arduino Bridge to upload.`,
              "Open Bridge"
            )
            .then((selection) => {
              if (selection === "Open Bridge") {
                vscode.commands.executeCommand("arduinoBridge.openBridge");
              }
            });
        } else {
          outputChannel.appendLine("✗ Compilation failed!");
          if (result.error) {
            outputChannel.appendLine(`Error: ${result.error}`);
          }

          vscode.window
            .showErrorMessage(
              `Compilation failed. Check Output panel for details.`,
              "Show Output"
            )
            .then((selection) => {
              if (selection === "Show Output") {
                outputChannel.show(true);
              }
            });
        }
      } catch (error: any) {
        outputChannel.appendLine(`Error: ${error.message}`);
        vscode.window.showErrorMessage(`Compilation error: ${error.message}`);
      }
    }
  );
}
