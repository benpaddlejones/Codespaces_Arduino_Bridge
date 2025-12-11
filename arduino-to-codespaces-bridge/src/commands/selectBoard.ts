/**
 * Select Board Command
 *
 * Shows a quick pick dialog for selecting the target Arduino board.
 * Fetches available boards from arduino-cli and saves selection to settings.
 *
 * @module commands/selectBoard
 */

import * as vscode from "vscode";
import { BridgeServer } from "../server";

interface BoardQuickPickItem extends vscode.QuickPickItem {
  fqbn: string;
}

/**
 * Common boards to show even if arduino-cli is not available
 */
const DEFAULT_BOARDS: BoardQuickPickItem[] = [
  {
    label: "Arduino Uno",
    description: "arduino:avr:uno",
    fqbn: "arduino:avr:uno",
  },
  {
    label: "Arduino Uno R4 WiFi",
    description: "arduino:renesas_uno:unor4wifi",
    fqbn: "arduino:renesas_uno:unor4wifi",
  },
  {
    label: "Arduino Uno R4 Minima",
    description: "arduino:renesas_uno:minima",
    fqbn: "arduino:renesas_uno:minima",
  },
  {
    label: "Arduino Nano",
    description: "arduino:avr:nano",
    fqbn: "arduino:avr:nano",
  },
  {
    label: "Arduino Mega 2560",
    description: "arduino:avr:mega",
    fqbn: "arduino:avr:mega",
  },
  {
    label: "Arduino Leonardo",
    description: "arduino:avr:leonardo",
    fqbn: "arduino:avr:leonardo",
  },
  {
    label: "ESP32 Dev Module",
    description: "esp32:esp32:esp32",
    fqbn: "esp32:esp32:esp32",
  },
  {
    label: "ESP8266 Generic",
    description: "esp8266:esp8266:generic",
    fqbn: "esp8266:esp8266:generic",
  },
];

/**
 * Show board selection quick pick
 * @param server - Bridge server instance
 */
export async function selectBoard(server: BridgeServer): Promise<void> {
  // Show loading indicator
  const boards = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading boards...",
      cancellable: false,
    },
    async () => {
      return await fetchBoards(server);
    }
  );

  if (boards.length === 0) {
    vscode.window.showWarningMessage(
      "No boards found. Make sure arduino-cli is installed and board cores are installed."
    );
    return;
  }

  // Get current board for pre-selection
  const config = vscode.workspace.getConfiguration("arduinoBridge");
  const currentFqbn = config.get<string>("defaultBoard");

  // Find current board in list
  const currentBoard = boards.find((b) => b.fqbn === currentFqbn);

  // Show quick pick
  const selected = await vscode.window.showQuickPick(boards, {
    placeHolder: currentBoard
      ? `Current: ${currentBoard.label}`
      : "Select Arduino Board",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (selected) {
    // Save to workspace settings
    await config.update(
      "defaultBoard",
      selected.fqbn,
      vscode.ConfigurationTarget.Workspace
    );
    vscode.window.showInformationMessage(`Board set to: ${selected.label}`);
  }
}

/**
 * Fetch boards from server or use defaults
 * @param server - Bridge server instance
 */
async function fetchBoards(
  server: BridgeServer
): Promise<BoardQuickPickItem[]> {
  if (!server.isRunning()) {
    return DEFAULT_BOARDS;
  }

  try {
    const port = server.getPort();
    const response = await fetch(`http://localhost:${port}/api/boards`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      boards?: Array<{ name: string; fqbn: string; platform?: string }>;
    };

    if (data.success && Array.isArray(data.boards) && data.boards.length > 0) {
      return data.boards.map((board) => ({
        label: board.name,
        description: board.fqbn,
        detail: board.platform,
        fqbn: board.fqbn,
      }));
    }
  } catch (error) {
    console.warn("Failed to fetch boards from server:", error);
  }

  // Return defaults if fetch failed
  return DEFAULT_BOARDS;
}
