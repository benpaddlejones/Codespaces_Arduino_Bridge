# Arduino to Codespaces Bridge - VS Code Extension Implementation Plan

**Date:** December 10, 2025  
**Version:** 1.0  
**Status:** Planning  
**Target:** VS Code Marketplace Publication

---

## Executive Summary

This document outlines the implementation plan to convert the existing Arduino Bridge web application into a VS Code extension called "Arduino to Codespaces Bridge". The extension will enable Arduino development directly from GitHub Codespaces, allowing students and teachers to compile and upload sketches to physical Arduino boards connected via USB to their local machine.

### Key Constraints

1. **Web Serial API Limitation**: The Web Serial API **cannot run inside a VS Code WebView** due to security sandbox restrictions. It **must run in a standalone browser page**.
2. **Target Platform**: GitHub Codespaces (Linux-based dev containers). May work on local VS Code with Linux, but Codespaces is the primary target.
3. **Self-Contained**: All dependencies must be bundled into the extension (no external `npm install` required by users).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Extension Structure](#2-extension-structure)
3. [Implementation Phases](#3-implementation-phases)
4. [Detailed Component Specifications](#4-detailed-component-specifications)
5. [Bundling & Packaging Strategy](#5-bundling--packaging-strategy)
6. [Testing Strategy](#6-testing-strategy)
7. [Publishing Checklist](#7-publishing-checklist)
8. [Risk Assessment & Mitigations](#8-risk-assessment--mitigations)
9. [File Change Matrix](#9-file-change-matrix)

---

## 1. Architecture Overview

### 1.1 Current Architecture (Web App)

```
┌─────────────────────────────────────────────────────────────────┐
│                      GitHub Codespaces                          │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐ │
│  │  Vite Dev       │    │  Express Server (API)               │ │
│  │  (Port 3000)    │    │  (Port 3001)                        │ │
│  │  - Frontend UI  │    │  - /api/compile                     │ │
│  │  - Client JS    │    │  - /api/boards                      │ │
│  └────────┬────────┘    └─────────────────────────────────────┘ │
└───────────┼─────────────────────────────────────────────────────┘
            │ Web Serial API (in browser)
            ▼
┌───────────────────────────────────────────────────────────────┐
│                   User's Browser (Local Machine)              │
│   └── Connects to USB Arduino via Web Serial                  │
└───────────────────────────────────────────────────────────────┘
```

### 1.2 Target Architecture (VS Code Extension)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        GitHub Codespaces (Linux Container)                  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      VS Code Extension                                 │ │
│  │  ┌─────────────────────┐  ┌──────────────────────────────────────────┐ │ │
│  │  │  Extension Host     │  │  Bundled Express Server                  │ │ │
│  │  │  (extension.ts)     │  │  - /api/compile                          │ │ │
│  │  │  - Commands         │  │  - /api/boards                           │ │ │
│  │  │  - Server lifecycle │  │  - /api/libraries                        │ │ │
│  │  │  - Status bar       │  │  - /api/cli/*                            │ │ │
│  │  │  - Port forwarding  │  │  - Static file serving (Web UI)          │ │ │
│  │  └─────────────────────┘  └──────────────────────────────────────────┘ │ │
│  │                                                                        │ │
│  │  ┌────────────────────────────────────────────────────────────────────┐│ │
│  │  │  Bundled Web Client (served as static files)                       ││ │
│  │  │  - Serial Monitor UI (xterm.js)                                    ││ │
│  │  │  - Plotter UI (Chart.js)                                           ││ │
│  │  │  - Board/Library Manager UI                                        ││ │
│  │  │  - Web Serial Provider, Upload Strategies                          ││ │
│  │  └────────────────────────────────────────────────────────────────────┘│ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                            │
                            │ vscode.env.openExternal() → Opens in Default Browser
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     User's Default Browser (Local Machine)                  │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────────┐ │
│   │  Arduino Bridge Web UI (loaded from extension server)                 │ │
│   │  - Web Serial API (navigator.serial) ✓                                │ │
│   │  - Full USB access to Arduino boards                                  │ │
│   │  - Firmware upload via STK500/BOSSA/ESPTool protocols                 │ │
│   └───────────────────────────────────────────────────────────────────────┘ │
│                               │ USB                                         │
│                               ▼                                             │
│                     ┌─────────────────┐                                     │
│                     │  Arduino Board  │                                     │
│                     └─────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Key Design Decisions

| Decision                            | Rationale                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **External Browser for Web Serial** | Web Serial API doesn't work in WebViews due to security restrictions. Must use `vscode.env.openExternal()` to launch the bridge UI in the user's default browser. |
| **Bundled Express Server**          | The server runs inside the Codespace. It handles compilation via `arduino-cli` and serves the web UI.                                                             |
| **Single Extension Package**        | All dependencies (express, chart.js, xterm.js) bundled via esbuild/webpack for zero-install deployment.                                                           |
| **Port Forwarding via Codespaces**  | Codespaces automatically forwards ports, making the bridge accessible from the user's browser.                                                                    |

---

## 2. Extension Structure

### 2.1 Directory Structure

```
arduino-to-codespaces-bridge/          # Extension root (new folder)
├── package.json                        # Extension manifest
├── tsconfig.json                       # TypeScript config
├── esbuild.js                          # Bundle script
├── README.md                           # Extension readme (marketplace)
├── CHANGELOG.md                        # Version history
├── LICENSE                             # License file
├── .vscodeignore                       # Files to exclude from VSIX
│
├── src/
│   ├── extension.ts                    # Extension entry point
│   ├── commands/
│   │   ├── openBridge.ts               # Open bridge in browser
│   │   ├── startServer.ts              # Start/restart server
│   │   └── selectBoard.ts              # Board selection command
│   ├── server/
│   │   ├── index.ts                    # Server bootstrap
│   │   └── ... (bundled from arduino-bridge/server.js)
│   ├── client/
│   │   └── ... (bundled from arduino-bridge/src/client/*)
│   └── shared/
│       └── ... (copied from arduino-bridge/src/shared/*)
│
├── resources/
│   ├── icons/
│   │   ├── arduino.png                 # Extension icon
│   │   └── arduino-dark.svg            # Activity bar icon
│   └── boards.json                     # Board definitions
│
├── dist/                               # Compiled output
│   ├── extension.js                    # Bundled extension
│   ├── server/                         # Bundled server
│   └── web/                            # Bundled web client
│
└── test/
    └── extension.test.ts               # Extension tests
```

### 2.2 Extension Manifest (package.json)

```json
{
  "name": "arduino-to-codespaces-bridge",
  "displayName": "Arduino to Codespaces Bridge",
  "description": "Compile and upload Arduino sketches from GitHub Codespaces to physical boards via Web Serial",
  "version": "1.0.0",
  "publisher": "benpaddlejones",
  "license": "MIT",
  "icon": "resources/icons/arduino.png",
  "repository": {
    "type": "git",
    "url": "https://github.com/benpaddlejones/Codespaces_Arduino_Bridge"
  },
  "engines": {
    "vscode": "^1.74.0"
  },
  "categories": ["Programming Languages", "Education", "Other"],
  "keywords": [
    "arduino",
    "codespaces",
    "github",
    "embedded",
    "microcontroller",
    "web serial",
    "upload",
    "flash"
  ],
  "activationEvents": ["workspaceContains:**/*.ino"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "arduinoBridge.openBridge",
        "title": "Open Arduino Bridge",
        "category": "Arduino",
        "icon": "$(plug)"
      },
      {
        "command": "arduinoBridge.startServer",
        "title": "Start Bridge Server",
        "category": "Arduino"
      },
      {
        "command": "arduinoBridge.stopServer",
        "title": "Stop Bridge Server",
        "category": "Arduino"
      },
      {
        "command": "arduinoBridge.selectBoard",
        "title": "Select Board",
        "category": "Arduino"
      },
      {
        "command": "arduinoBridge.compileSketch",
        "title": "Compile Sketch",
        "category": "Arduino"
      }
    ],
    "configuration": {
      "title": "Arduino to Codespaces Bridge",
      "properties": {
        "arduinoBridge.serverPort": {
          "type": "number",
          "default": 3001,
          "description": "Port for the Arduino Bridge server"
        },
        "arduinoBridge.autoStartServer": {
          "type": "boolean",
          "default": true,
          "description": "Automatically start the bridge server when a .ino file is detected"
        },
        "arduinoBridge.defaultBoard": {
          "type": "string",
          "default": "arduino:avr:uno",
          "description": "Default board FQBN for compilation"
        },
        "arduinoBridge.sketchPaths": {
          "type": "array",
          "default": [],
          "description": "Additional paths to search for sketches"
        }
      }
    },
    "menus": {
      "editor/title": [
        {
          "when": "resourceExtname == .ino",
          "command": "arduinoBridge.openBridge",
          "group": "navigation"
        }
      ],
      "explorer/context": [
        {
          "when": "resourceExtname == .ino",
          "command": "arduinoBridge.compileSketch",
          "group": "arduino"
        }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        {
          "id": "arduino-bridge",
          "title": "Arduino Bridge",
          "icon": "resources/icons/arduino-dark.svg"
        }
      ]
    },
    "views": {
      "arduino-bridge": [
        {
          "id": "arduinoBridge.status",
          "name": "Status"
        },
        {
          "id": "arduinoBridge.boards",
          "name": "Boards"
        },
        {
          "id": "arduinoBridge.sketches",
          "name": "Sketches"
        }
      ]
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "node esbuild.js --production",
    "watch": "node esbuild.js --watch",
    "lint": "eslint src --ext ts",
    "test": "vscode-test",
    "package": "vsce package",
    "publish": "vsce publish"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.x",
    "@types/vscode": "^1.74.0",
    "@vscode/test-electron": "^2.3.8",
    "@vscode/vsce": "^2.22.0",
    "esbuild": "^0.19.0",
    "eslint": "^8.56.0",
    "typescript": "^5.3.0"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
```

---

## 3. Implementation Phases

### Phase 1: Extension Scaffolding (Week 1)

**Goal:** Create the basic extension structure with server lifecycle management.

| Task | Description                          | Files                           |
| ---- | ------------------------------------ | ------------------------------- |
| 1.1  | Create extension folder structure    | `arduino-to-codespaces-bridge/` |
| 1.2  | Set up TypeScript configuration      | `tsconfig.json`                 |
| 1.3  | Create extension entry point         | `src/extension.ts`              |
| 1.4  | Implement server start/stop commands | `src/commands/startServer.ts`   |
| 1.5  | Add status bar item                  | `src/extension.ts`              |
| 1.6  | Configure esbuild bundler            | `esbuild.js`                    |
| 1.7  | Create package.json manifest         | `package.json`                  |

### Phase 2: Server Integration (Week 2)

**Goal:** Bundle the Express server into the extension.

| Task | Description                        | Files                       |
| ---- | ---------------------------------- | --------------------------- |
| 2.1  | Refactor server.js for bundling    | Modify imports, remove Vite |
| 2.2  | Bundle server with dependencies    | `esbuild.js` configuration  |
| 2.3  | Implement port management          | Dynamic port allocation     |
| 2.4  | Add server health monitoring       | Extension watches server    |
| 2.5  | Implement auto-start on activation | `extension.ts`              |

### Phase 3: Web Client Bundling (Week 2-3)

**Goal:** Bundle the web client for static serving.

| Task | Description                         | Files                           |
| ---- | ----------------------------------- | ------------------------------- |
| 3.1  | Configure Vite build for production | `arduino-bridge/vite.config.js` |
| 3.2  | Bundle client-side JavaScript       | Single bundle with dependencies |
| 3.3  | Copy static assets to dist          | HTML, CSS, icons                |
| 3.4  | Update server to serve static files | `dist/web/` folder              |
| 3.5  | Test Web Serial in external browser | Verify functionality            |

### Phase 4: Extension Commands & UI (Week 3)

**Goal:** Implement VS Code commands and tree views.

| Task | Description                     | Files                         |
| ---- | ------------------------------- | ----------------------------- |
| 4.1  | Implement openBridge command    | Opens external browser        |
| 4.2  | Implement selectBoard command   | Quick pick for boards         |
| 4.3  | Implement compileSketch command | Compile active file           |
| 4.4  | Create status tree view         | Show server/connection status |
| 4.5  | Create boards tree view         | List available boards         |
| 4.6  | Create sketches tree view       | List workspace sketches       |

### Phase 5: Polish & Testing (Week 4)

**Goal:** Finalize the extension for marketplace release.

| Task | Description               | Files                        |
| ---- | ------------------------- | ---------------------------- |
| 5.1  | Write extension tests     | `test/extension.test.ts`     |
| 5.2  | Test in GitHub Codespaces | End-to-end testing           |
| 5.3  | Create marketplace assets | Icon, screenshots, README    |
| 5.4  | Write documentation       | Usage guide, troubleshooting |
| 5.5  | Create .vscodeignore      | Exclude dev files            |
| 5.6  | Package and test VSIX     | Local installation test      |

### Phase 6: Publication (Week 4)

**Goal:** Publish to VS Code Marketplace.

| Task | Description                | Files                        |
| ---- | -------------------------- | ---------------------------- |
| 6.1  | Create publisher account   | marketplace.visualstudio.com |
| 6.2  | Generate PAT token         | Azure DevOps                 |
| 6.3  | Publish extension          | `vsce publish`               |
| 6.4  | Verify marketplace listing | Check installation           |
| 6.5  | Create GitHub release      | Tag and release              |

---

## 4. Detailed Component Specifications

### 4.1 Extension Entry Point (`src/extension.ts`)

```typescript
import * as vscode from "vscode";
import { BridgeServer } from "./server";
import { StatusTreeProvider } from "./views/StatusTreeProvider";
import { BoardsTreeProvider } from "./views/BoardsTreeProvider";
import { SketchesTreeProvider } from "./views/SketchesTreeProvider";

let server: BridgeServer | undefined;
let statusBar: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Arduino to Codespaces Bridge is now active");

  // Initialize server
  server = new BridgeServer(context);

  // Create status bar item
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = "$(plug) Arduino Bridge";
  statusBar.command = "arduinoBridge.openBridge";
  statusBar.tooltip = "Click to open Arduino Bridge";
  statusBar.show();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("arduinoBridge.openBridge", openBridge),
    vscode.commands.registerCommand("arduinoBridge.startServer", startServer),
    vscode.commands.registerCommand("arduinoBridge.stopServer", stopServer),
    vscode.commands.registerCommand("arduinoBridge.selectBoard", selectBoard),
    vscode.commands.registerCommand(
      "arduinoBridge.compileSketch",
      compileSketch
    ),
    statusBar
  );

  // Register tree views
  const statusProvider = new StatusTreeProvider(server);
  const boardsProvider = new BoardsTreeProvider();
  const sketchesProvider = new SketchesTreeProvider();

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
      "arduinoBridge.sketches",
      sketchesProvider
    )
  );

  // Auto-start server if configured
  const config = vscode.workspace.getConfiguration("arduinoBridge");
  if (config.get("autoStartServer")) {
    await startServer();
  }
}

async function openBridge() {
  if (!server?.isRunning()) {
    await startServer();
  }

  const port = server!.getPort();

  // Use asExternalUri for proper port forwarding in Codespaces
  const localUri = vscode.Uri.parse(`http://localhost:${port}`);
  const externalUri = await vscode.env.asExternalUri(localUri);

  // Open in external browser (required for Web Serial)
  await vscode.env.openExternal(externalUri);

  vscode.window.showInformationMessage(
    `Arduino Bridge opened in browser. Connect your Arduino and click "Connect Port".`
  );
}

async function startServer() {
  if (server?.isRunning()) {
    vscode.window.showInformationMessage("Bridge server is already running");
    return;
  }

  try {
    await server!.start();
    statusBar.text = "$(plug) Arduino Bridge (Running)";
    statusBar.backgroundColor = undefined;
    vscode.window.showInformationMessage(
      `Arduino Bridge server started on port ${server!.getPort()}`
    );
  } catch (error: any) {
    statusBar.text = "$(plug) Arduino Bridge (Error)";
    statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    vscode.window.showErrorMessage(`Failed to start server: ${error.message}`);
  }
}

async function stopServer() {
  if (!server?.isRunning()) {
    vscode.window.showInformationMessage("Bridge server is not running");
    return;
  }

  await server.stop();
  statusBar.text = "$(plug) Arduino Bridge (Stopped)";
  vscode.window.showInformationMessage("Arduino Bridge server stopped");
}

async function selectBoard() {
  // Fetch boards from server or use cached list
  const boards = [
    { label: "Arduino Uno", fqbn: "arduino:avr:uno" },
    { label: "Arduino Uno R4 WiFi", fqbn: "arduino:renesas_uno:unor4wifi" },
    { label: "Arduino Nano", fqbn: "arduino:avr:nano" },
    { label: "Arduino Mega 2560", fqbn: "arduino:avr:mega" },
    { label: "ESP32 Dev Module", fqbn: "esp32:esp32:esp32" },
  ];

  const selected = await vscode.window.showQuickPick(boards, {
    placeHolder: "Select Arduino Board",
  });

  if (selected) {
    const config = vscode.workspace.getConfiguration("arduinoBridge");
    await config.update(
      "defaultBoard",
      selected.fqbn,
      vscode.ConfigurationTarget.Workspace
    );
    vscode.window.showInformationMessage(`Board set to: ${selected.label}`);
  }
}

async function compileSketch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith(".ino")) {
    vscode.window.showWarningMessage(
      "Open an Arduino sketch (.ino) file first"
    );
    return;
  }

  // Trigger compilation via server API
  // Implementation details in server module
}

export function deactivate() {
  server?.stop();
}
```

### 4.2 Server Module (`src/server/index.ts`)

```typescript
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import express from "express";

export class BridgeServer {
  private app: express.Application;
  private server: http.Server | undefined;
  private port: number;
  private running: boolean = false;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.app = express();

    const config = vscode.workspace.getConfiguration("arduinoBridge");
    this.port = config.get("serverPort") || 3001;

    this.setupRoutes();
  }

  private setupRoutes() {
    // Serve static web client files
    const webPath = path.join(this.context.extensionPath, "dist", "web");
    this.app.use(express.static(webPath));

    // API routes (ported from arduino-bridge/server.js)
    this.app.use(express.json());

    // Health endpoint
    this.app.get("/api/health", (req, res) => {
      res.json({ status: "ok", version: "1.0.0" });
    });

    // ... Additional API routes imported from existing server.js
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        this.running = true;
        console.log(`Arduino Bridge server listening on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Try next port
          this.port++;
          this.start().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getPort(): number {
    return this.port;
  }
}
```

### 4.3 Web Serial Considerations

**Critical:** The Web Serial API has strict security requirements:

- Must be called from a **secure context** (HTTPS or localhost)
- Requires **user gesture** (click) to request port access
- **Cannot work in iframes or WebViews** with sandboxing

**Solution:** The bridge UI runs in the user's default browser, not in VS Code. The extension:

1. Starts the Express server inside the Codespace
2. Uses `vscode.env.openExternal()` to open the bridge URL
3. Codespaces automatically handles port forwarding

```typescript
// In extension.ts
async function openBridge() {
  const port = server!.getPort();
  const localUri = vscode.Uri.parse(`http://localhost:${port}`);

  // asExternalUri handles Codespaces port forwarding
  const externalUri = await vscode.env.asExternalUri(localUri);

  // Opens in system default browser where Web Serial works
  await vscode.env.openExternal(externalUri);
}
```

---

## 5. Bundling & Packaging Strategy

### 5.1 Build Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                     Build Process                                │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ TypeScript   │    │ esbuild      │    │ VSIX         │       │
│  │ Compilation  │ -> │ Bundling     │ -> │ Packaging    │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   │                │
│         v                   v                   v                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ src/*.ts     │    │ dist/        │    │ *.vsix       │       │
│  │ - extension  │    │ - extension.js│   │ (installable)│       │
│  │ - server     │    │ - server.js  │    │              │       │
│  │              │    │ - web/*      │    │              │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐                           │
│  │ Vite Build   │ -> │ dist/web/    │                           │
│  │ (Client)     │    │ - index.html │                           │
│  │              │    │ - main.js    │                           │
│  │              │    │ - style.css  │                           │
│  └──────────────┘    └──────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 esbuild Configuration (`esbuild.js`)

```javascript
const esbuild = require("esbuild");
const { copy } = require("esbuild-plugin-copy");

const production = process.argv.includes("--production");

// Bundle extension
esbuild
  .build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: !production,
    minify: production,
  })
  .catch(() => process.exit(1));

// Bundle server with dependencies
esbuild
  .build({
    entryPoints: ["src/server/index.ts"],
    bundle: true,
    outfile: "dist/server.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: !production,
    minify: production,
    plugins: [
      copy({
        resolveFrom: "cwd",
        assets: {
          from: ["./web-dist/**/*"],
          to: ["./dist/web"],
        },
      }),
    ],
  })
  .catch(() => process.exit(1));
```

### 5.3 Dependencies to Bundle

| Package         | Size   | Purpose           | Bundle?      |
| --------------- | ------ | ----------------- | ------------ |
| express         | ~200KB | HTTP server       | ✅ Yes       |
| xterm           | ~300KB | Terminal emulator | ✅ Yes (web) |
| xterm-addon-fit | ~10KB  | Terminal resize   | ✅ Yes (web) |
| chart.js        | ~200KB | Serial plotter    | ✅ Yes (web) |
| **Total**       | ~700KB |                   |              |

### 5.4 .vscodeignore

```
.vscode/**
.github/**
src/**
test/**
node_modules/**
!node_modules/express/**
!node_modules/chart.js/**
!node_modules/xterm/**
*.map
.gitignore
.eslintrc.json
tsconfig.json
esbuild.js
webpack.config.js
**/*.ts
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

```typescript
// test/extension.test.ts
import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  test("Extension should be present", () => {
    assert.ok(
      vscode.extensions.getExtension(
        "benpaddlejones.arduino-to-codespaces-bridge"
      )
    );
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes("arduinoBridge.openBridge"));
    assert.ok(commands.includes("arduinoBridge.startServer"));
  });
});
```

### 6.2 Integration Tests (Codespaces)

| Test            | Steps                                     | Expected Result                        |
| --------------- | ----------------------------------------- | -------------------------------------- |
| Server Start    | 1. Activate extension 2. Check status bar | Server running, status shows "Running" |
| Open Bridge     | 1. Run command 2. Check browser           | Bridge UI opens in browser             |
| Compile Sketch  | 1. Open .ino file 2. Run compile          | Successful compilation output          |
| Board Selection | 1. Run select board 2. Choose board       | Board saved to settings                |

### 6.3 Manual Testing Checklist

- [ ] Extension installs without errors
- [ ] Extension activates when .ino file detected
- [ ] Server starts automatically
- [ ] Bridge opens in external browser
- [ ] Web Serial works in browser
- [ ] Can connect to Arduino board
- [ ] Can compile sketch
- [ ] Can upload to board (Uno R3)
- [ ] Can upload to board (Uno R4 WiFi)
- [ ] Board Manager works
- [ ] Library Manager works
- [ ] Serial Monitor works
- [ ] Serial Plotter works

---

## 7. Publishing Checklist

### 7.1 Pre-Publication

- [ ] Version number updated in package.json
- [ ] CHANGELOG.md updated
- [ ] README.md complete with screenshots
- [ ] Icon is 128x128 PNG
- [ ] License file present
- [ ] All tests passing
- [ ] Extension tested in Codespaces
- [ ] .vscodeignore configured

### 7.2 Marketplace Assets

| Asset       | Requirement                               |
| ----------- | ----------------------------------------- |
| Icon        | 128x128 PNG, transparent background       |
| Banner      | 1000x250, dark background for dark theme  |
| Screenshots | 1280x800 recommended                      |
| Categories  | Programming Languages, Education          |
| Tags        | arduino, codespaces, web serial, embedded |

### 7.3 Publication Commands

```bash
# Login to publisher account
vsce login benpaddlejones

# Package extension
vsce package

# Publish to marketplace
vsce publish

# Or publish with version bump
vsce publish minor
```

---

## 8. Risk Assessment & Mitigations

| Risk                              | Impact | Likelihood | Mitigation                                 |
| --------------------------------- | ------ | ---------- | ------------------------------------------ |
| Web Serial not working in WebView | High   | Certain    | Use external browser via `openExternal()`  |
| Port conflicts in Codespaces      | Medium | Medium     | Dynamic port allocation with fallback      |
| arduino-cli not installed         | High   | Low        | Document prerequisite, check on activation |
| Large bundle size                 | Medium | Medium     | Code splitting, tree shaking               |
| Browser compatibility             | Medium | Medium     | Document Chrome/Edge requirement           |
| Codespaces port forwarding issues | High   | Low        | Use `asExternalUri()` API                  |

### 8.1 Platform Limitations

| Platform              | Support Level | Notes                        |
| --------------------- | ------------- | ---------------------------- |
| **GitHub Codespaces** | ✅ Full       | Primary target, Linux-based  |
| **VS Code + Linux**   | ✅ Full       | Works with local arduino-cli |
| **VS Code + macOS**   | ⚠️ Partial    | May work, untested           |
| **VS Code + Windows** | ⚠️ Partial    | May need WSL for arduino-cli |
| **VS Code Web**       | ❌ None       | Cannot run Node.js server    |

---

## 9. File Change Matrix

### 9.1 Files to Create (New Extension)

| File                                               | Purpose             |
| -------------------------------------------------- | ------------------- |
| `arduino-to-codespaces-bridge/package.json`        | Extension manifest  |
| `arduino-to-codespaces-bridge/tsconfig.json`       | TypeScript config   |
| `arduino-to-codespaces-bridge/esbuild.js`          | Build script        |
| `arduino-to-codespaces-bridge/src/extension.ts`    | Entry point         |
| `arduino-to-codespaces-bridge/src/server/index.ts` | Server module       |
| `arduino-to-codespaces-bridge/src/commands/*.ts`   | Command handlers    |
| `arduino-to-codespaces-bridge/src/views/*.ts`      | Tree view providers |
| `arduino-to-codespaces-bridge/resources/icons/*`   | Extension icons     |
| `arduino-to-codespaces-bridge/.vscodeignore`       | Package exclusions  |
| `arduino-to-codespaces-bridge/README.md`           | Marketplace readme  |
| `arduino-to-codespaces-bridge/CHANGELOG.md`        | Version history     |

### 9.2 Files to Refactor (From arduino-bridge)

| Source File                         | Destination             | Changes                   |
| ----------------------------------- | ----------------------- | ------------------------- |
| `arduino-bridge/server.js`          | `src/server/`           | Modularize, remove Vite   |
| `arduino-bridge/src/server/*.js`    | `src/server/`           | Convert to TS, bundle     |
| `arduino-bridge/src/client/*.js`    | Build to `dist/web/`    | Bundle for static serving |
| `arduino-bridge/src/shared/*.js`    | `src/shared/`           | Convert to TS             |
| `arduino-bridge/index.html`         | `dist/web/index.html`   | Update asset paths        |
| `arduino-bridge/public/boards.json` | `resources/boards.json` | Copy                      |

### 9.3 Files Unchanged

| File                                       | Reason                       |
| ------------------------------------------ | ---------------------------- |
| `arduino-bridge/src/client/providers/*.js` | Web Serial logic works as-is |
| `arduino-bridge/src/client/services/*.js`  | Upload strategies work as-is |
| `arduino-bridge/src/client/ui/*.js`        | UI components work as-is     |

---

## Appendix A: Quick Start Commands

```bash
# Create extension scaffolding
npx yo code --extensionType=ts --extensionName=arduino-to-codespaces-bridge

# Install dependencies
cd arduino-to-codespaces-bridge
npm install

# Build extension
npm run build

# Package VSIX
npm run package

# Install locally for testing
code --install-extension arduino-to-codespaces-bridge-1.0.0.vsix

# Publish
npm run publish
```

---

## Appendix B: Key VS Code APIs

| API                                        | Purpose                                         |
| ------------------------------------------ | ----------------------------------------------- |
| `vscode.env.openExternal(uri)`             | Open URL in external browser                    |
| `vscode.env.asExternalUri(uri)`            | Get externally accessible URI (port forwarding) |
| `vscode.window.createStatusBarItem()`      | Create status bar button                        |
| `vscode.window.showQuickPick()`            | Board selection dialog                          |
| `vscode.workspace.getConfiguration()`      | Read extension settings                         |
| `vscode.window.registerTreeDataProvider()` | Sidebar tree views                              |
| `vscode.commands.registerCommand()`        | Register commands                               |

---

## Appendix C: References

1. [VS Code Extension API](https://code.visualstudio.com/api)
2. [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
3. [Existing Arduino Bridge](https://github.com/benpaddlejones/Codespaces_Arduino_Bridge)
4. [vsce Publishing Tool](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
5. [esbuild Bundler](https://esbuild.github.io/)

---

**Document Status:** Complete  
**Next Step:** Begin Phase 1 - Extension Scaffolding
