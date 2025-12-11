/**
 * Extension Test Suite
 *
 * Basic tests to verify extension activation and command registration.
 */

import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Extension should be present", () => {
    const extension = vscode.extensions.getExtension(
      "benpaddlejones.arduino-to-codespaces-bridge"
    );
    assert.ok(extension, "Extension should be found");
  });

  test("Extension should activate", async () => {
    const extension = vscode.extensions.getExtension(
      "benpaddlejones.arduino-to-codespaces-bridge"
    );
    if (extension) {
      await extension.activate();
      assert.ok(extension.isActive, "Extension should be active");
    }
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes("arduinoBridge.openBridge"),
      "openBridge command should be registered"
    );
    assert.ok(
      commands.includes("arduinoBridge.startServer"),
      "startServer command should be registered"
    );
    assert.ok(
      commands.includes("arduinoBridge.stopServer"),
      "stopServer command should be registered"
    );
    assert.ok(
      commands.includes("arduinoBridge.selectBoard"),
      "selectBoard command should be registered"
    );
    assert.ok(
      commands.includes("arduinoBridge.compileSketch"),
      "compileSketch command should be registered"
    );
  });

  test("Configuration should have defaults", () => {
    const config = vscode.workspace.getConfiguration("arduinoBridge");

    assert.strictEqual(
      config.get("serverPort"),
      3001,
      "Default server port should be 3001"
    );
    assert.strictEqual(
      config.get("autoStartServer"),
      true,
      "Auto start should be true by default"
    );
    assert.strictEqual(
      config.get("defaultBoard"),
      "arduino:avr:uno",
      "Default board should be arduino:avr:uno"
    );
  });
});
