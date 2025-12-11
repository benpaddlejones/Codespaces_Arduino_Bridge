/**
 * Open Bridge Command
 *
 * Opens the Arduino Bridge web UI in the user's default browser.
 * Uses vscode.env.openExternal() and asExternalUri() for proper
 * port forwarding in GitHub Codespaces.
 *
 * @module commands/openBridge
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";

/**
 * Open the Arduino Bridge in an external browser
 * @param server - Bridge server instance
 * @param outputChannel - Output channel for logging
 */
export async function openBridge(
  server: BridgeServer,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  // Ensure server is running
  if (!server.isRunning()) {
    outputChannel.appendLine("Server not running, starting...");

    try {
      await server.start();
      outputChannel.appendLine(`Server started on port ${server.getPort()}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(
        `Failed to start server: ${error.message}`
      );
      return;
    }
  }

  const port = server.getPort();

  // Create local URI
  const localUri = vscode.Uri.parse(`http://localhost:${port}`);

  try {
    // Use asExternalUri for proper port forwarding in Codespaces
    // This transforms localhost:port to the publicly accessible URL
    const externalUri = await vscode.env.asExternalUri(localUri);

    outputChannel.appendLine(
      `Opening Arduino Bridge: ${externalUri.toString()}`
    );

    // Open in external browser (required for Web Serial API)
    const opened = await vscode.env.openExternal(externalUri);

    if (opened) {
      vscode.window.showInformationMessage(
        'Arduino Bridge opened in browser. Connect your Arduino and click "Connect Port".',
        "OK"
      );
    } else {
      // Fallback: show the URL for manual opening
      const copyAction = "Copy URL";
      const result = await vscode.window.showWarningMessage(
        `Could not open browser automatically. Please open: ${externalUri.toString()}`,
        copyAction
      );

      if (result === copyAction) {
        await vscode.env.clipboard.writeText(externalUri.toString());
        vscode.window.showInformationMessage("URL copied to clipboard");
      }
    }
  } catch (error: any) {
    outputChannel.appendLine(`Error opening bridge: ${error.message}`);
    vscode.window.showErrorMessage(
      `Failed to open Arduino Bridge: ${error.message}`
    );
  }
}
