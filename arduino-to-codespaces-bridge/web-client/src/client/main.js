/**
 * Arduino Bridge Client
 *
 * Main client application that provides:
 * - Serial monitor and plotter functionality
 * - Board and library management UI
 * - Compile and upload workflow
 * - WebSerial API integration
 * - Global error handling and resilience
 *
 * @module client/main
 * @version Tracks package.json (build version)
 */

import { SerialManager } from "./services/SerialManager.js";
import { TerminalUI } from "./ui/TerminalUI.js";
import { UploadManager } from "./services/UploadManager.js";
import { PlotterUI } from "./ui/PlotterUI.js";
import { BoardManagerUI } from "./ui/BoardManagerUI.js";
import { LibraryManagerUI } from "./ui/LibraryManagerUI.js";
import { ReferenceUI } from "./ui/ReferenceUI.js";
import { DriversUI } from "./ui/DriversUI.js";
import { trapFocus, releaseFocus } from "./ui/focusTrap.js";
import {
  resolveBoardForDevice,
  shouldWarnMismatch,
} from "./services/boardResolver.js";
import { UploadReporter } from "./services/utils/UploadReporter.js";
import { Logger } from "../shared/Logger.js";

// =============================================================================
// Constants
// =============================================================================

/** @type {Logger} Client-side logger for structured logging */
const logger = new Logger("Client");

/* global __APP_VERSION__ */
/**
 * Client version — injected from package.json at build time by Vite (see
 * vite.config.js). Always equals the build version, so it matches the server
 * unless a stale client bundle is being served from cache.
 */
const CLIENT_VERSION = __APP_VERSION__;

/** Default baud rate for serial connections */
const DEFAULT_BAUD_RATE = 115200;

/** Health check polling interval in milliseconds */
const HEALTH_CHECK_INTERVAL_MS = 30000;

/** Reconnection delay after port disconnect */
const RECONNECT_DELAY_MS = 2000;

/** Maximum reconnection attempts */
const MAX_RECONNECT_ATTEMPTS = 3;

// =============================================================================
// Global Error Handlers
// =============================================================================

/** @type {boolean} Track server online status */
let serverOnline = true;

/** @type {number|null} Health check interval ID */
let healthCheckInterval = null;

/**
 * Global error handler for uncaught exceptions
 * Logs error and attempts graceful recovery
 */
window.onerror = (message, source, lineno, colno, error) => {
  logger.error(`Global Error: ${message}`, { source, lineno, colno, error });
  handleGlobalError(error || new Error(message));
  return true; // Prevent default error handling
};

/**
 * Global handler for unhandled promise rejections
 */
window.onunhandledrejection = (event) => {
  logger.error("Unhandled Rejection", event.reason);
  handleGlobalError(event.reason);
  event.preventDefault();
};

/**
 * Handle global errors with graceful recovery
 * @param {Error|*} error - The error that occurred
 */
async function handleGlobalError(error) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Show error to user via terminal if available
  if (typeof terminal !== "undefined" && terminal.write) {
    terminal.write(`\r\n\x1b[1;31m[Error] ${errorMessage}\x1b[0m\r\n`);
  }

  // Attempt graceful recovery - disconnect port if connected
  try {
    if (typeof serialManager !== "undefined" && serialManager.provider?.port) {
      logger.info("Attempting graceful disconnect after error");
      await serialManager.disconnect().catch(() => {});
    }
  } catch (recoveryError) {
    logger.warn("Disconnect failed", recoveryError);
  }

  // Reset UI state
  updateConnectionUIState(false);
}

/**
 * Update connection UI elements to reflect connection state
 * @param {boolean} connected - Whether serial is connected
 */
function updateConnectionUIState(connected) {
  const connectBtn = document.getElementById("connectBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const serialInput = document.getElementById("serialInput");
  const sendBtn = document.getElementById("sendBtn");

  if (connectBtn) connectBtn.disabled = connected;
  if (disconnectBtn) disconnectBtn.disabled = !connected;
  if (serialInput) serialInput.disabled = !connected;
  if (sendBtn) sendBtn.disabled = !connected;
}

// =============================================================================
// Server Health Monitoring
// =============================================================================

/** @type {boolean} A Codespaces port-auth-expired notice has been shown */
let portAuthNoticeShown = false;

/**
 * Detect the GitHub Codespaces port-forward sign-in page: when the
 * forwarded-port auth cookie expires, the proxy answers API requests with
 * an HTML login page and HTTP 200 - a silent failure mode unless the
 * content type is checked.
 * @param {Response} response - Fetch response to inspect
 * @returns {boolean} True when the response is HTML instead of JSON
 */
function isHtmlResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("text/html");
}

/**
 * Show a one-time notice that the Codespaces forwarded-port session
 * expired and the page must be reloaded to re-authenticate.
 */
function showPortAuthExpiredNotice() {
  if (portAuthNoticeShown) return;
  portAuthNoticeShown = true;
  setBridgeStatus({
    online: false,
    message: "Codespaces port session expired",
    detail: "Reload the page to sign in to the forwarded port again",
  });
  showGuidance({
    title: "\ud83d\udd10 Codespaces session expired",
    lines: [
      "GitHub's forwarded-port sign-in for this page has expired, so requests to the bridge are being redirected to a login page.",
      "Reload the page to re-authenticate - your Codespace and sketches are unaffected.",
    ],
    actionLabel: "Reload page",
    onAction: () => window.location.reload(),
  });
}

/**
 * Fetch wrapper hardened for the Codespaces forwarded-port proxy:
 * - request timeout via AbortController
 * - automatic retry with backoff on transient failures (network errors and
 *   502/503/504 proxy responses while the Codespace wakes up)
 * - detection of the Codespaces sign-in HTML page served with HTTP 200
 *   when the port-forwarding auth cookie has expired
 * @param {string} url - Request URL
 * @param {object} [options] - fetch options plus {timeoutMs, retries, retryDelayMs}
 * @returns {Promise<Response>} The successful response
 */
async function bridgeFetch(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 1000,
    ...fetchOptions
  } = options;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok && isHtmlResponse(response)) {
        showPortAuthExpiredNotice();
        throw new Error(
          "Codespaces port session expired - reload the page to sign in again",
        );
      }

      if ([502, 503, 504].includes(response.status) && attempt < retries) {
        lastError = new Error(`HTTP ${response.status} from port proxy`);
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      if (
        error &&
        typeof error.message === "string" &&
        error.message.includes("port session expired")
      ) {
        throw error;
      }
      lastError = error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastError || new Error("Request failed");
}

/**
 * Start periodic server health monitoring
 */
function startHealthMonitoring() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  healthCheckInterval = setInterval(
    checkServerHealth,
    HEALTH_CHECK_INTERVAL_MS,
  );
  logger.info("Started server health monitoring");
}

/**
 * Check server health and update UI
 */
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("/api/health", {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok && isHtmlResponse(response)) {
      // The Codespaces port-forward cookie expired - the proxy is serving
      // its sign-in page with HTTP 200 to every request
      showPortAuthExpiredNotice();
      throw new Error("Codespaces port session expired");
    }

    if (response.ok) {
      const data = await response.json();

      if (!serverOnline) {
        logger.info("Server back online", data.data);
        serverOnline = true;
        hideBridgeOfflineBanner();
        setBridgeStatus({ online: true });
        // The Codespace may have just woken up - reload the boards and
        // sketches lists so the dropdowns aren't left empty or stale
        logger.info("Reloading boards and sketches after reconnection");
        void initialize();
      }
    } else {
      throw new Error(`Health check failed: HTTP ${response.status}`);
    }
  } catch (error) {
    if (serverOnline) {
      logger.error("Server offline", error.message);
      serverOnline = false;
      showBridgeOfflineBanner();
    }
  }
}

/**
 * Show banner indicating bridge server is offline
 */
function showBridgeOfflineBanner() {
  let banner = document.getElementById("health-offline-banner");

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "health-offline-banner";
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #ff6b6b;
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-weight: bold;
      z-index: 10000;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    `;
    banner.innerHTML = `
      <span>⚠️ Arduino Bridge is offline - some features unavailable</span>
      <button id="retryHealthBtn" style="
        background: white;
        color: #ff6b6b;
        border: none;
        padding: 4px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
      ">Retry</button>
    `;
    document.body.prepend(banner);

    document
      .getElementById("retryHealthBtn")
      ?.addEventListener("click", async () => {
        await checkServerHealth();
      });
  }

  banner.style.display = "flex";
}

/**
 * Hide the bridge offline banner
 */
function hideBridgeOfflineBanner() {
  const banner = document.getElementById("health-offline-banner");
  if (banner) {
    banner.style.display = "none";
  }
}

// Start health monitoring on load
startHealthMonitoring();

// =============================================================================
// UI Component Initialization
// =============================================================================

const terminal = new TerminalUI("terminal-container");
const plotter = new PlotterUI("plotter-container");
const boardManager = new BoardManagerUI("boards-view");
const libraryManager = new LibraryManagerUI("libraries-view");
const referenceUI = new ReferenceUI("reference-view");
const driversUI = new DriversUI("drivers-view");

// Upload trace stays in the browser console (UploadLogger writes there);
// the terminal only receives the reporter's fixed phase lines + summary.
const uploadReporter = new UploadReporter((text) => terminal.write(text));

logger.info(`Version: ${CLIENT_VERSION}`);
logger.info(`Loaded at: ${new Date().toISOString()}`);

const serialManager = new SerialManager();
const uploadManager = new UploadManager();

// Initialize manager UIs
boardManager.init();
libraryManager.init();
referenceUI.init();
driversUI.init();

// Set up main navigation view switching
setupNavigation();

// =============================================================================
// Version Verification
// =============================================================================

// Fetch and display server version for cache verification
verifyServerVersion();

/**
 * Verify server version matches client version
 * Shows warning banner if versions mismatch
 */
async function verifyServerVersion() {
  try {
    const response = await bridgeFetch("/api/version");
    const data = await response.json();

    logger.info(`Server Version: ${data.version}`);

    if (data.version !== CLIENT_VERSION) {
      logger.warn(
        `VERSION MISMATCH! Client: ${CLIENT_VERSION}, Server: ${data.version}`,
      );
      setBridgeStatus({
        online: false,
        message: "Version mismatch detected",
        detail: `Client ${CLIENT_VERSION}, Server ${data.version}. Restart to resync`,
      });
    } else {
      logger.info("Client and Server versions match");
      setBridgeStatus({ online: true });
    }
  } catch (error) {
    handleBridgeError("Version check", error);
  }
}

// =============================================================================
// State
// =============================================================================

/** Track the last working baud rate for reconnection after upload */
let lastWorkingBaudRate = DEFAULT_BAUD_RATE;

// UI Elements
const bridgeStatusBanner = document.getElementById("bridge-status");
const bridgeStatusText = document.getElementById("bridgeStatusText");
const bridgeStatusDetail = document.getElementById("bridgeStatusDetail");
const restartBridgeBtn = document.getElementById("restartBridgeBtn");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const baudSelect = document.getElementById("baudRate");
const boardSelect = document.getElementById("boardType");
const sketchSelect = document.getElementById("sketchSelect");
const includeExamplesCheck = document.getElementById("includeExamplesCheck");
const compileBtn = document.getElementById("compileBtn");
const compileUploadBtn = document.getElementById("compileUploadBtn");
const toggleViewBtn = document.getElementById("toggleViewBtn");
const terminalContainer = document.getElementById("terminal-container");
const plotterContainer = document.getElementById("plotter-container");

// New Toolbar Elements
const timestampCheck = document.getElementById("timestampCheck");
const dtrCheck = document.getElementById("dtrCheck");
const rtsCheck = document.getElementById("rtsCheck");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");
const freezePlotBtn = document.getElementById("freezePlotBtn");
const downloadPlotBtn = document.getElementById("downloadPlotBtn");

// Input Bar Elements
const serialInput = document.getElementById("serialInput");
const lineEndingSelect = document.getElementById("lineEnding");
const sendBtn = document.getElementById("sendBtn");

// Modal Elements
const bootloaderModal = document.getElementById("bootloaderModal");
const modalSelectPortBtn = document.getElementById("modalSelectPortBtn");
const modalCancelBtn = document.getElementById("modalCancelBtn");

// Mismatch Modal Elements
const mismatchModal = document.getElementById("mismatchModal");
const mismatchMessage = document.getElementById("mismatchMessage");
const mismatchConnected = document.getElementById("mismatchConnected");
const mismatchSelected = document.getElementById("mismatchSelected");
const mismatchContinueBtn = document.getElementById("mismatchContinueBtn");
const mismatchCancelBtn = document.getElementById("mismatchCancelBtn");

// I2C Scan Button
const i2cScanBtn = document.getElementById("i2cScanBtn");

// DFU Modal Elements
const dfuModal = document.getElementById("dfuModal");
const dfuModalMessage = document.getElementById("dfuModalMessage");
const dfuSelectBtn = document.getElementById("dfuSelectBtn");
const dfuCancelBtn = document.getElementById("dfuCancelBtn");

/** @type {boolean} Guard against concurrent DFU device requests */
let dfuRequestInProgress = false;

// WebUSB requestDevice() must run inside a user gesture. The DFU strategy
// calls this helper when it needs the user to pick the DFU device: show a
// modal whose button click provides the gesture.
if (
  typeof window !== "undefined" &&
  typeof window.requestDfuDevice !== "function"
) {
  window.requestDfuDevice = (filters, message) => {
    if (!dfuModal || !dfuSelectBtn || !dfuCancelBtn) {
      // No modal in the DOM - fall back to a direct request (may fail
      // outside a user gesture, but better than nothing)
      logger.info("Select the Arduino DFU device from the USB chooser");
      return navigator.usb.requestDevice({ filters });
    }
    if (dfuRequestInProgress) {
      return Promise.reject(
        new Error("A DFU device request is already in progress"),
      );
    }
    dfuRequestInProgress = true;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        dfuRequestInProgress = false;
        closeModal(dfuModal);
        dfuSelectBtn.disabled = false;
        dfuCancelBtn.disabled = false;
        dfuSelectBtn.removeEventListener("click", handleSelect);
        dfuCancelBtn.removeEventListener("click", handleCancel);
      };
      const handleSelect = async () => {
        try {
          dfuSelectBtn.disabled = true;
          dfuCancelBtn.disabled = true;
          const device = await navigator.usb.requestDevice({ filters });
          window._dfuDevice = device;
          cleanup();
          resolve(device);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const handleCancel = () => {
        cleanup();
        reject(new Error("User cancelled DFU device selection"));
      };

      logger.info("Select the Arduino DFU device from the USB chooser");
      dfuModalMessage.textContent =
        message ||
        "Click the button below, then choose the Arduino DFU device in the USB chooser.";
      openModal(dfuModal, dfuCancelBtn);
      dfuSelectBtn.addEventListener("click", handleSelect);
      dfuCancelBtn.addEventListener("click", handleCancel);
    });
  };
}

/**
 * Show a modal overlay with keyboard focus trapped inside it.
 * ESC activates the modal's cancel button.
 * @param {HTMLElement} modal - Modal overlay element
 * @param {HTMLElement} [cancelBtn] - Button to click when ESC is pressed
 */
function openModal(modal, cancelBtn) {
  modal.style.display = "flex";
  trapFocus(modal, () => cancelBtn && cancelBtn.click());
}

/**
 * Hide a modal overlay and release its focus trap.
 * @param {HTMLElement} modal - Modal overlay element
 */
function closeModal(modal) {
  releaseFocus(modal);
  modal.style.display = "none";
}

// ==========================================
// Guidance Popups (onboarding / missing platform / missing library)
// ==========================================

const guidanceModal = document.getElementById("guidanceModal");
const guidanceTitle = document.getElementById("guidanceTitle");
const guidanceBody = document.getElementById("guidanceBody");
const guidanceActionBtn = document.getElementById("guidanceActionBtn");
const guidanceDismissBtn = document.getElementById("guidanceDismissBtn");

/**
 * Show a guidance popup with a title, message paragraphs and an optional
 * primary action button. Content is set with textContent (no HTML injection).
 * @param {object} options - Popup options
 * @param {string} options.title - Modal heading
 * @param {string[]} options.lines - Paragraphs of guidance text
 * @param {string} [options.actionLabel] - Primary button label
 * @param {Function} [options.onAction] - Primary button handler
 */
function showGuidance({ title, lines, actionLabel, onAction }) {
  if (!guidanceModal || !guidanceTitle || !guidanceBody) {
    return;
  }
  guidanceTitle.textContent = title;
  guidanceBody.replaceChildren();
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    guidanceBody.appendChild(p);
  }

  const hasAction = Boolean(actionLabel && onAction);
  guidanceActionBtn.style.display = hasAction ? "" : "none";
  if (hasAction) {
    guidanceActionBtn.textContent = actionLabel;
  }

  const cleanup = () => {
    closeModal(guidanceModal);
    guidanceActionBtn.removeEventListener("click", handleAction);
    guidanceDismissBtn.removeEventListener("click", handleDismiss);
  };
  const handleAction = () => {
    cleanup();
    if (onAction) {
      onAction();
    }
  };
  const handleDismiss = () => cleanup();

  guidanceActionBtn.addEventListener("click", handleAction);
  guidanceDismissBtn.addEventListener("click", handleDismiss);
  openModal(guidanceModal, guidanceDismissBtn);
}

// Let upload strategies (which have no access to the UI layer) show the
// driver guidance popup with an "Open driver guide" action - same dialog
// the Connect button uses when no serial device is found.
if (
  typeof window !== "undefined" &&
  typeof window.showDriverGuidance !== "function"
) {
  window.showDriverGuidance = (title, lines) =>
    showGuidance({
      title,
      lines,
      actionLabel: "Open driver guide",
      onAction: () => openViewWithSearch("drivers"),
    });
}

/**
 * Switch to a main navigation view and optionally pre-fill its search box
 * so the user lands directly on relevant results.
 * @param {string} viewName - Nav view name ("boards" | "libraries" | ...)
 * @param {string} [searchTerm] - Text to type into the view's search input
 */
function openViewWithSearch(viewName, searchTerm) {
  const tab = document.querySelector(`.nav-tab[data-view="${viewName}"]`);
  if (tab) {
    tab.click();
  }
  if (searchTerm) {
    const inputId = viewName === "boards" ? "board-search" : "lib-search";
    const input = document.getElementById(inputId);
    if (input) {
      input.value = searchTerm;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

let isPlotterMode = false;

function setBridgeStatus({ online, message = "", detail = "", busy = false }) {
  if (!bridgeStatusBanner) return;

  if (online) {
    bridgeStatusBanner.classList.add("hidden");
    bridgeStatusBanner.classList.remove("busy");
    bridgeStatusText.textContent = message || "Bridge online";
    bridgeStatusDetail.textContent = "";
    if (restartBridgeBtn) restartBridgeBtn.disabled = false;
    return;
  }

  bridgeStatusBanner.classList.remove("hidden");
  if (busy) {
    bridgeStatusBanner.classList.add("busy");
  } else {
    bridgeStatusBanner.classList.remove("busy");
  }
  bridgeStatusText.textContent = message || "Bridge server unavailable";
  bridgeStatusDetail.textContent = detail;
  if (restartBridgeBtn) restartBridgeBtn.disabled = busy;
}

function handleBridgeError(context, error) {
  const message = error?.message || String(error || "unknown error");
  logger.error(`Bridge Error - ${context}`, message);
  setBridgeStatus({
    online: false,
    message: "Bridge server unreachable",
    detail: `${context}: ${message}`,
  });
  // Don't wait up to 30s for the next scheduled poll - confirm the outage
  // (and start recovery detection) right away
  setTimeout(() => void checkServerHealth(), 500);
}

async function requestBridgeRestart() {
  if (!restartBridgeBtn) return;
  setBridgeStatus({
    online: false,
    busy: true,
    message: "Restarting Arduino Bridge...",
    detail: "Killing existing processes and relaunching (≈5s)",
  });

  try {
    const response = await fetch("/api/restart", { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setBridgeStatus({
      online: false,
      busy: true,
      message: "Bridge restarting...",
      detail: "Reloading shortly to reconnect",
    });
    setTimeout(() => window.location.reload(), 4000);
  } catch (error) {
    handleBridgeError("Bridge restart", error);
    if (restartBridgeBtn) restartBridgeBtn.disabled = false;
  }
}

if (restartBridgeBtn) {
  restartBridgeBtn.addEventListener("click", requestBridgeRestart);
}

// DTR/RTS Handlers
dtrCheck.addEventListener("change", async (e) => {
  if (serialManager.provider.port) {
    await serialManager.setSignals({ dataTerminalReady: e.target.checked });
  }
});

rtsCheck.addEventListener("change", async (e) => {
  if (serialManager.provider.port) {
    await serialManager.setSignals({ requestToSend: e.target.checked });
  }
});

// Timestamp Handler
timestampCheck.addEventListener("change", (e) => {
  terminal.setTimestampMode(e.target.checked);
});

// Clear Button Handler
clearBtn.addEventListener("click", () => {
  if (isPlotterMode) {
    plotter.clear();
  } else {
    terminal.clear();
  }
});

// Download Button Handler
downloadBtn.addEventListener("click", () => {
  terminal.downloadLog();
});

// Freeze Plot Button Handler
freezePlotBtn.addEventListener("click", () => {
  const frozen = plotter.toggleFreeze();
  freezePlotBtn.textContent = frozen ? "▶ Resume Plot" : "⏸ Freeze Plot";
  freezePlotBtn.style.backgroundColor = frozen ? "#4caf50" : "";
});

// Download Plot as PNG Button Handler
downloadPlotBtn.addEventListener("click", () => {
  plotter.downloadPNG();
});

// Toggle View Handler
toggleViewBtn.addEventListener("click", () => {
  isPlotterMode = !isPlotterMode;

  if (isPlotterMode) {
    terminalContainer.style.visibility = "hidden";
    plotterContainer.style.visibility = "visible";
    toggleViewBtn.textContent = "Switch to Monitor";
    freezePlotBtn.style.display = "inline-block";
    downloadPlotBtn.style.display = "inline-block";
    plotter.resize();
  } else {
    terminalContainer.style.visibility = "visible";
    plotterContainer.style.visibility = "hidden";
    toggleViewBtn.textContent = "Switch to Plotter";
    freezePlotBtn.style.display = "none";
    downloadPlotBtn.style.display = "none";
    terminal.fit(); // Ensure terminal fits new visibility
  }
});

let availableBoards = [];
/** Boards known to the bridge by VID/PID (from boards.json), including
 *  boards whose platform core is NOT installed yet. */
let knownBoardsCatalog = [];
/** @type {Map<string, string>} devicePairKey -> FQBN learned from
 *  successful uploads (persisted in arduino-requirements.txt). Populated
 *  by the learned-device tracking feature; overrides all tiers. */
const learnedDeviceMap = new Map();

// Load Boards
async function loadBoards() {
  try {
    // Fetch both installed boards (API) and VID/PID metadata (JSON)
    const [apiRes, jsonRes] = await Promise.all([
      bridgeFetch("/api/boards", { timeoutMs: 30000 }),
      bridgeFetch("/boards.json"),
    ]);

    if (!apiRes.ok) throw new Error("Failed to load boards from API");
    const apiData = await apiRes.json();

    let knownBoards = [];
    if (jsonRes.ok) {
      const jsonData = await jsonRes.json();
      knownBoards = jsonData.boards || [];
    }
    knownBoardsCatalog = knownBoards;

    boardSelect.innerHTML = "";
    availableBoards = apiData.boards || [];

    // Merge VID/PID and uploadMode from knownBoards into availableBoards
    availableBoards.forEach((board) => {
      const known = knownBoards.find((kb) => kb.fqbn === board.fqbn);
      if (known) {
        board.vid = known.vid;
        board.pid = known.pid;
        board.uploadMode = known.uploadMode;
        board.uploadInstructions = known.uploadInstructions;
      }
    });

    availableBoards.sort((a, b) => a.name.localeCompare(b.name));

    availableBoards.forEach((board) => {
      const option = document.createElement("option");
      option.value = board.fqbn;
      option.textContent = board.name;
      if (board.fqbn === "arduino:avr:uno") option.selected = true;
      boardSelect.appendChild(option);
    });

    setBridgeStatus({ online: true });
    return true;
  } catch (error) {
    logger.error("Error loading boards", error);
    handleBridgeError("Load boards", error);
    boardSelect.innerHTML =
      '<option value="arduino:avr:uno">Arduino Uno (Fallback)</option>';
    return false;
  }
}

// Load Sketches (and optionally library examples)
async function loadSketches() {
  try {
    const response = await bridgeFetch("/api/sketches");
    if (!response.ok) throw new Error("Failed to load sketches");
    const data = await response.json();

    // Save current selection if it exists and is still valid
    const currentSelection = sketchSelect.value;

    sketchSelect.innerHTML = '<option value="">Select Sketch...</option>';
    const sketches = data.sketches || [];

    let selectionFound = false;

    // Add workspace sketches
    sketches.forEach((sketch) => {
      const option = document.createElement("option");
      option.value = sketch.path;
      option.textContent = sketch.name;
      sketchSelect.appendChild(option);

      if (sketch.path === currentSelection) {
        selectionFound = true;
      }
    });

    // If "Include Examples" is checked, load library examples
    if (includeExamplesCheck && includeExamplesCheck.checked) {
      await loadLibraryExamples(currentSelection, (found) => {
        if (found) selectionFound = true;
      });
    }

    // Add Refresh Option
    const refreshOption = document.createElement("option");
    refreshOption.value = "__REFRESH__";
    refreshOption.textContent = "🔄 Refresh List...";
    refreshOption.style.fontWeight = "bold";
    refreshOption.style.color = "#007acc";
    sketchSelect.appendChild(refreshOption);

    // Restore selection if it still exists
    if (selectionFound) {
      sketchSelect.value = currentSelection;
    }
    return true;
  } catch (error) {
    logger.error("Error loading sketches", error);
    handleBridgeError("Load sketches", error);
    return false;
  }
}

// Load library examples into the sketch dropdown
async function loadLibraryExamples(currentSelection, onSelectionFound) {
  try {
    // Get list of installed libraries
    const libResponse = await fetch("/api/cli/libraries/installed");
    if (!libResponse.ok) return;

    const libData = await libResponse.json();
    const libraries = libData.libraries || [];

    if (libraries.length === 0) return;

    // Add separator before examples
    const separator = document.createElement("option");
    separator.disabled = true;
    separator.textContent = "── Library Examples ──";
    separator.style.color = "#888";
    sketchSelect.appendChild(separator);

    // For each installed library, get its examples
    for (const lib of libraries) {
      const examplesResponse = await fetch(
        `/api/cli/libraries/${encodeURIComponent(lib.name)}/examples`,
      );

      if (!examplesResponse.ok) continue;

      const examplesData = await examplesResponse.json();
      if (
        !examplesData.success ||
        !examplesData.examples ||
        examplesData.examples.length === 0
      ) {
        continue;
      }

      // Add examples for this library
      examplesData.examples.forEach((example) => {
        const option = document.createElement("option");
        // Use the full path as value, prefixed to identify as example
        option.value = `__EXAMPLE__:${example.path}`;
        // Display as "LibraryName/ExampleName"
        const libNameClean = lib.name.replace(/_/g, " ");
        option.textContent = `📁 ${libNameClean}/${example.name}`;
        option.style.color = "#9cdcfe";
        sketchSelect.appendChild(option);

        if (option.value === currentSelection) {
          onSelectionFound(true);
        }
      });
    }
  } catch (error) {
    logger.error("Error loading library examples", error);
    // Don't throw - examples are optional
  }
}

// Handle "Include Examples" checkbox change
if (includeExamplesCheck) {
  includeExamplesCheck.addEventListener("change", () => {
    loadSketches();
  });
}

// Initialize - load boards and sketches
async function initialize() {
  const [boardsOk, sketchesOk] = await Promise.all([
    loadBoards(),
    loadSketches(),
    loadLearnedDevices(),
  ]);
  updateCompileButtons();
  void checkPlatformsInstalled();
  return boardsOk && sketchesOk;
}

/**
 * Load learned device mappings (VID:PID -> FQBN, proven by successful
 * uploads and persisted in arduino-requirements.txt) into the resolver's
 * map. Non-fatal: auto-detect simply falls back to the tier catalog.
 * @returns {Promise<boolean>} True when the list loaded
 */
async function loadLearnedDevices() {
  try {
    const res = await bridgeFetch("/api/devices/learned");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    learnedDeviceMap.clear();
    for (const d of data.devices || []) {
      const [vidHex, pidHex] = d.key.split(":");
      const vid = parseInt(vidHex, 16);
      const pid = parseInt(pidHex, 16);
      if (vid && pid && d.fqbn) {
        learnedDeviceMap.set(d.key.toLowerCase(), d.fqbn);
      }
    }
    if (learnedDeviceMap.size > 0) {
      logger.info(`Loaded ${learnedDeviceMap.size} learned device mapping(s)`);
    }
    return true;
  } catch (error) {
    logger.warn("Could not load learned devices", error);
    return false;
  }
}

/**
 * Record a successful upload as a learned device mapping (latest upload
 * wins per VID:PID). Fire-and-forget: failures only log.
 * @param {SerialPort} port - The port the device was CONNECTED on
 * @param {string} fqbn - Board that was successfully uploaded
 */
async function recordLearnedDevice(port, fqbn) {
  try {
    const info = port?.getInfo?.();
    if (!info?.usbVendorId || !info?.usbProductId || !fqbn) return;
    const hex = (n) => `0x${n.toString(16).padStart(4, "0")}`;
    const key = `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
    learnedDeviceMap.set(key, fqbn);
    const res = await bridgeFetch("/api/devices/learned", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vid: info.usbVendorId,
        pid: info.usbProductId,
        fqbn,
      }),
    });
    if (res.ok) {
      logger.info(`Learned device mapping: ${key} -> ${fqbn}`);
    }
  } catch (error) {
    logger.warn("Could not record learned device", error);
  }
}

/**
 * First-run onboarding: when no board platforms are installed in the
 * Codespace, compiling is impossible - guide the user to the Board Manager.
 */
async function checkPlatformsInstalled() {
  try {
    const res = await fetch("/api/cli/cores/installed");
    const data = await res.json();
    if (
      data.success &&
      Array.isArray(data.platforms) &&
      data.platforms.length === 0
    ) {
      showGuidance({
        title: "\ud83d\udc4b Welcome - install a board platform first",
        lines: [
          "No Arduino board platforms are installed in this Codespace yet, so sketches cannot be compiled.",
          'Open the Board Manager tab, search for your board (e.g. "uno" or "uno r4"), and click Install.',
          "The platform is saved to arduino-requirements.txt, so it is restored automatically next time.",
        ],
        actionLabel: "Open Board Manager",
        onAction: () => openViewWithSearch("boards", ""),
      });
    }
  } catch (error) {
    // Bridge offline is reported elsewhere; onboarding is best-effort.
    logger.warn("Platform onboarding check failed", error);
  }
}

// ---------------------------------------------------------------------------
// Startup gate: hold the UI behind a loading overlay until the bridge server
// is up AND the boards + sketches lists have loaded, so users never interact
// with empty dropdowns while the server is still starting.
// ---------------------------------------------------------------------------
const appLoadingEl = document.getElementById("appLoading");
const appLoadingStatusEl = document.getElementById("appLoadingStatus");
const appLoadingRetryBtn = document.getElementById("appLoadingRetry");

function setStartupStatus(text) {
  if (appLoadingStatusEl) appLoadingStatusEl.textContent = text;
}

/**
 * Poll the lightweight version endpoint until the bridge server answers.
 * @param {number} maxWaitMs - Give up after this long
 * @returns {Promise<boolean>} True when the server responded
 */
async function waitForBridgeServer(maxWaitMs = 60000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      const res = await fetch("/api/version");
      if (res.ok && isHtmlResponse(res)) {
        // Codespaces port sign-in page served with HTTP 200
        showPortAuthExpiredNotice();
        setStartupStatus(
          "Codespaces port session expired - reload the page to sign in again.",
        );
        return false;
      }
      if (res.ok) return true;
    } catch (e) {
      // Server not accepting connections yet - keep waiting
    }
    setStartupStatus(
      `Waiting for the bridge server to start… (attempt ${attempt})`,
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function startApp() {
  if (appLoadingRetryBtn) appLoadingRetryBtn.hidden = true;
  if (appLoadingEl) appLoadingEl.classList.remove("hidden");
  setStartupStatus("Connecting to the bridge server…");

  const serverUp = await waitForBridgeServer();
  if (!serverUp) {
    setStartupStatus(
      "The bridge server is not responding. Make sure the Arduino Bridge extension is running, then retry.",
    );
    if (appLoadingRetryBtn) appLoadingRetryBtn.hidden = false;
    return;
  }

  setStartupStatus("Loading boards and sketches…");
  const ready = await initialize();
  if (!ready) {
    setStartupStatus(
      "Could not load the boards or sketches list from the bridge server. Retry in a moment.",
    );
    if (appLoadingRetryBtn) appLoadingRetryBtn.hidden = false;
    return;
  }

  if (appLoadingEl) appLoadingEl.classList.add("hidden");

  // Sync IntelliSense to whatever board is now selected - the config file
  // may still be generated for a board used in a previous session
  void updateIntellisenseForBoard(boardSelect.value, false);
}

if (appLoadingRetryBtn) {
  appLoadingRetryBtn.addEventListener("click", () => void startApp());
}

startApp();

// Check if selected board uses UF2 download mode (no serial upload)
function getBoardUploadMode() {
  const fqbn = boardSelect.value;
  const board = availableBoards.find((b) => b.fqbn === fqbn);
  return board?.uploadMode || "serial";
}

function getBoardUploadInstructions() {
  const fqbn = boardSelect.value;
  const board = availableBoards.find((b) => b.fqbn === fqbn);
  return board?.uploadInstructions || "";
}

// Enable/Disable Compile Buttons
function updateCompileButtons() {
  const ready =
    sketchSelect.value &&
    boardSelect.value &&
    sketchSelect.value !== "__REFRESH__";

  const uploadMode = getBoardUploadMode();

  compileBtn.disabled = !ready;

  if (uploadMode === "uf2-download") {
    // UF2 boards: Change button text and enable without serial connection
    compileUploadBtn.textContent = "Compile & Download (.uf2)";
    compileUploadBtn.disabled = !ready;
  } else {
    // Serial upload boards: Require connection
    compileUploadBtn.textContent = "Compile & Upload";
    const hasPort = !!serialManager.provider.port;
    compileUploadBtn.disabled = !(ready && hasPort);
  }
}

sketchSelect.addEventListener("change", async (e) => {
  if (e.target.value === "__REFRESH__") {
    // Show loading state
    const originalText = e.target.options[e.target.selectedIndex].text;
    e.target.options[e.target.selectedIndex].text = "Refreshing...";

    await loadSketches();

    // Reset to default if we just refreshed
    if (sketchSelect.value === "__REFRESH__") {
      sketchSelect.value = "";
    }
    updateCompileButtons();
    return;
  }
  updateCompileButtons();
});

/** @type {string|null} FQBN the IntelliSense config was last generated for */
let lastIntellisenseFqbn = null;

/**
 * Regenerate .vscode/c_cpp_properties.json for a board. The SELECTED board
 * is the single source of truth for IntelliSense - called on manual
 * selection, auto-detect, and startup. Deduplicates repeat calls for the
 * same FQBN.
 * @param {string} fqbn - Fully qualified board name
 * @param {boolean} [announce=true] - Write a confirmation to the terminal
 */
async function updateIntellisenseForBoard(fqbn, announce = true) {
  if (!fqbn || fqbn === lastIntellisenseFqbn) return;
  try {
    const response = await bridgeFetch("/api/intellisense", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqbn }),
      timeoutMs: 60000,
    });
    if (response.ok) {
      lastIntellisenseFqbn = fqbn;
      logger.info(`IntelliSense updated for: ${fqbn}`);
      if (announce) {
        terminal.write(`\r\n✨ IntelliSense updated for ${fqbn}\r\n`);
      }
    } else {
      logger.warn("IntelliSense: Failed to update configuration");
    }
  } catch (error) {
    logger.warn("IntelliSense: Error updating configuration", error);
  }
}

boardSelect.addEventListener("change", async () => {
  updateCompileButtons();

  // Auto-select default baud rate for this board (only if not connected)
  if (!serialManager.provider.port) {
    const defaultBaud = getDefaultBaudRate(boardSelect.value);
    baudSelect.value = defaultBaud.toString();
  }

  // Update IntelliSense configuration for the selected board
  await updateIntellisenseForBoard(boardSelect.value);

  // Show info message for UF2/download boards
  const uploadMode = getBoardUploadMode();
  if (uploadMode === "uf2-download") {
    const board = availableBoards.find((b) => b.fqbn === boardSelect.value);
    const boardName = board?.name || "This board";
    terminal.write(
      `\r\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\r\n`,
    );
    terminal.write(`ℹ️  ${boardName} uses download mode.\r\n`);
    terminal.write(
      `   • Click "Compile & Download" to get the firmware file\r\n`,
    );
    terminal.write(
      `   • Flash the file to your board using the board's bootloader\r\n`,
    );
    terminal.write(
      `   • After flashing, use "Connect" to open the Serial Monitor\r\n`,
    );
    terminal.write(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\r\n`,
    );
  }
});

// Compile Function
async function compileSketch(sketchPathOverride = null) {
  // Defensive guards: recovered 1.1.x fix for compile attempts firing
  // before the DOM (or a selection) is ready
  if (!sketchSelect || !boardSelect) {
    logger.error("compileSketch: boardSelect/sketchSelect element is null!");
    terminal.write("\r\nInternal error: UI not ready - reload the page.\r\n");
    return null;
  }

  const sketchPath = sketchPathOverride || sketchSelect.value;
  const fqbn = boardSelect.value;

  if (!fqbn) {
    terminal.write("\r\nCompile aborted: No board selected\r\n");
    return null;
  }
  if (!sketchPath || sketchPath === "undefined" || sketchPath === "null") {
    terminal.write("\r\nCompile aborted: No sketch selected\r\n");
    return null;
  }

  logger.info(`Compiling sketch: '${sketchPath}' for board: '${fqbn}'`);
  terminal.write(`\r\nCompiling ${sketchPath} for ${fqbn}...\r\n`);

  // Silence the serial monitor while compiling so incoming device output
  // (e.g. plotter/heartbeat lines) doesn't interleave with the build log.
  serialManager.pause();

  try {
    const response = await bridgeFetch("/api/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sketchPath, fqbn: fqbn }),
      // First compile for a platform can download toolchains - allow long
      timeoutMs: 300000,
      retries: 1,
    });

    const data = await response.json();

    if (data.log) {
      terminal.write(data.log.replace(/\n/g, "\r\n") + "\r\n");
    }

    if (Array.isArray(data.missingIncludes) && data.missingIncludes.length) {
      // Separate local includes ("header.h") from library includes (<header.h>)
      const localIncludes = data.missingIncludes.filter(
        (item) => item.isLibraryInclude === false,
      );
      const libraryIncludes = data.missingIncludes.filter(
        (item) => item.isLibraryInclude !== false,
      );

      if (localIncludes.length > 0) {
        terminal.write(
          '\r\n⚠ Missing local files (using #include "file.h" syntax):\r\n',
        );
        localIncludes.forEach((item) => {
          terminal.write(
            `   • "${item.header}" → Add ${item.header} and ${item.query}.cpp to your sketch folder\r\n`,
          );
        });
      }

      if (libraryIncludes.length > 0) {
        terminal.write(
          "\r\n⚠ Missing libraries (using #include <lib.h> syntax):\r\n",
        );
        libraryIncludes.forEach((item) => {
          const suggestionNames = Array.isArray(item.suggestions)
            ? item.suggestions.map((lib) => lib.name).filter(Boolean)
            : [];

          if (suggestionNames.length) {
            terminal.write(
              `   • <${
                item.header
              }> → Install via Library Manager: ${suggestionNames.join(
                ", ",
              )}\r\n`,
            );
          } else {
            terminal.write(
              `   • <${item.header}> → Search Library Manager for "${item.query}"\r\n`,
            );
          }
        });
        terminal.write(
          "   💡 After installing, recompile to refresh IntelliSense\r\n",
        );

        // Popup with actionable install guidance for the missing libraries.
        const first = libraryIncludes[0];
        const firstSuggestion =
          (Array.isArray(first.suggestions) && first.suggestions[0]?.name) ||
          first.query ||
          first.header.replace(/\.h$/i, "");
        showGuidance({
          title: "📚 Missing library",
          lines: [
            "This sketch includes libraries that are not installed:",
            ...libraryIncludes.map((item) => {
              const names = Array.isArray(item.suggestions)
                ? item.suggestions.map((lib) => lib.name).filter(Boolean)
                : [];
              return names.length
                ? `<${item.header}> - install "${names.join('" or "')}"`
                : `<${item.header}> - search for "${item.query}"`;
            }),
            "Open the Library Manager tab, search for the library, click Install, then compile again.",
          ],
          actionLabel: "Open Library Manager",
          onAction: () => openViewWithSearch("libraries", firstSuggestion),
        });
      }
    }

    if (data.success && data.artifact) {
      terminal.write("Compilation Success!\r\n");
      return data.artifact.url;
    } else {
      terminal.write("Compilation Failed.\r\n");
      return null;
    }
  } catch (error) {
    terminal.write(`\r\nError: ${error.message}\r\n`);
    return null;
  } finally {
    // Balance the pause() above; the outer upload flow keeps its own pause.
    serialManager.resume();
  }
}

// Compile Button Handler
compileBtn.addEventListener("click", async () => {
  await compileSketch();
});

// Helper to handle the upload process (reusable for retries)
async function handleUpload(port, firmwareData, fqbn) {
  let activePort = port;
  try {
    // 4. Re-open port for Flashing
    // Ensure any previous connection is fully closed first
    if (serialManager.provider.port === activePort) {
      await serialManager.disconnect();
    }

    // Reopen the Web Serial port at 115200 before flashing. This matches the
    // published 1.1.1 behaviour (the version confirmed working for the UNO R4
    // Minima): keeping the serial port open here lets the DFU strategy's
    // WebUSB claimInterface() succeed, and serial-based strategies (AVR
    // STK500, BOSSA, ...) need the open port for their DTR reset toggle.
    if (!activePort.readable || !activePort.writable) {
      await activePort.open({ baudRate: 115200 });
    }

    // 5. Flash. The upload may return a different port when the device
    // re-enumerated into its bootloader (BOSSA/DFU boards).
    uploadReporter.phase("write", "Flashing firmware\u2026");
    activePort =
      (await uploadManager.upload(
        activePort,
        firmwareData,
        (progress, status) => {
          uploadReporter.progress(progress, status || "Flashing");
        },
        fqbn,
      )) || activePort;

    // Remember this VID:PID -> board pairing (latest successful upload wins)
    void recordLearnedDevice(port, fqbn);

    // 6. Reconnect Serial Monitor using current baud selection
    try {
      // Close port if still open
      if (activePort.readable || activePort.writable) {
        try {
          await activePort.close();
        } catch (closeError) {
          logger.warn("Port close warning (may already be closed)", closeError);
        }
      }

      const reconnectBaud =
        parseInt(baudSelect.value, 10) ||
        lastWorkingBaudRate ||
        getDefaultBaudRate(boardSelect.value);
      lastWorkingBaudRate = reconnectBaud;
      baudSelect.value = reconnectBaud.toString();

      // The device resets after flashing and usually re-enumerates as a
      // NEW SerialPort object - reconnecting to the old handle fails.
      // Wait for the restart, then look up the re-enumerated port by VID.
      terminal.write("\r\nWaiting for device to restart...\r\n");
      await new Promise((r) => setTimeout(r, 2000));

      uploadReporter.phase("reconnect", "Reconnecting serial monitor\u2026");
      let reconnectPort = activePort;
      const portInfo = activePort.getInfo();
      if (portInfo.usbVendorId) {
        try {
          const candidate = (await navigator.serial.getPorts()).find(
            (p) => p.getInfo().usbVendorId === portInfo.usbVendorId,
          );
          if (candidate) {
            reconnectPort = candidate;
            logger.info("Found re-enumerated port for reconnection");
          }
        } catch (enumError) {
          logger.warn("Could not enumerate ports for reconnection", enumError);
        }
      }

      // Retry the connection - re-enumeration timing varies by board
      let connected = false;
      for (let attempt = 1; attempt <= 3 && !connected; attempt++) {
        try {
          await serialManager.connect(reconnectBaud, reconnectPort);
          connected = true;
        } catch (attemptError) {
          logger.warn(`Reconnect attempt ${attempt}/3 failed`, attemptError);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      if (!connected) {
        throw new Error("Could not reconnect after 3 attempts");
      }

      try {
        await serialManager.write("\r\n");
      } catch (handshakeError) {
        logger.warn("Unable to send reconnection handshake", handshakeError);
      }

      // Success - update UI to connected state
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      updateCompileButtons();
      serialInput.disabled = false;
      sendBtn.disabled = false;

      // Resume serial monitor after successful upload
      serialManager.resume();
      uploadReporter.success("Upload complete - serial monitor reconnected");
    } catch (e) {
      logger.error("Reconnect failed", e);
      uploadReporter.success(
        "Upload complete - reconnect the serial monitor manually",
      );
      // Resume serial monitor even on reconnect failure
      serialManager.resume();
      // Reset UI to disconnected state
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      baudSelect.disabled = false;
      updateCompileButtons();
      serialInput.disabled = true;
      sendBtn.disabled = true;
    }
  } catch (error) {
    // Handle bootloader port switch - device has reset and needs new port selection
    if (error.code === "BOOTLOADER_PORT_NEEDED") {
      terminal.write(`\r\n\x1b[1;36m${error.message}\x1b[0m\r\n`);
      terminal.write(
        `\r\n\x1b[1;33mThe Arduino has entered bootloader mode and appears as a NEW USB device.\x1b[0m\r\n`,
      );
      terminal.write(
        `\x1b[1;33mPlease select the bootloader port (may show as "Arduino" or different name).\x1b[0m\r\n`,
      );

      // Show Modal for bootloader port selection
      openModal(bootloaderModal, modalCancelBtn);

      const handleBootloaderSelect = async () => {
        closeModal(bootloaderModal);
        cleanupBootloader();

        try {
          // Request new port - filter for Arduino bootloader
          const newPort = await navigator.serial.requestPort({
            filters: [
              { usbVendorId: 0x2341, usbProductId: 0x006d }, // R4 WiFi Bootloader
              { usbVendorId: 0x2341, usbProductId: 0x0054 }, // MKR WiFi 1010 Bootloader
              { usbVendorId: 0x2341, usbProductId: 0x0057 }, // Nano 33 IoT Bootloader
              { usbVendorId: 0x2341 }, // Any Arduino device as fallback
            ],
          });

          const info = newPort.getInfo();
          terminal.write(
            `\r\nSelected bootloader port (VID:${info.usbVendorId?.toString(
              16,
            )}, PID:${info.usbProductId?.toString(16)})\r\n`,
          );
          terminal.write("\r\nFlashing to bootloader...\r\n");

          // Flash directly to bootloader port (skip prepare)
          await uploadManager.flashToBootloader(
            newPort,
            firmwareData,
            (progress, status) => {
              uploadReporter.progress(progress, status || "Flashing");
            },
            fqbn,
          );

          // Remember the ORIGINAL (app-mode) pairing for auto-detect
          void recordLearnedDevice(port, fqbn);

          // Try to reconnect to the original port (device reboots after flash)
          try {
            await new Promise((r) => setTimeout(r, 2000)); // Wait for reboot
            const baudRate =
              parseInt(baudSelect.value, 10) ||
              lastWorkingBaudRate ||
              getDefaultBaudRate(boardSelect.value);
            lastWorkingBaudRate = baudRate;
            baudSelect.value = baudRate.toString();
            await serialManager.connect(baudRate, port);

            try {
              await serialManager.write("\r\n");
            } catch (handshakeError) {
              logger.warn(
                "Unable to send post-bootloader handshake",
                handshakeError,
              );
            }
            // Resume serial monitor after successful bootloader reconnect
            serialManager.resume();
            uploadReporter.success(
              "Upload complete - serial monitor reconnected",
            );
          } catch (e) {
            uploadReporter.success(
              "Upload complete - device rebooted, reconnect manually",
            );
            serialManager.resume();
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            baudSelect.disabled = false;
            updateCompileButtons();
          }
        } catch (e) {
          logger.error("Bootloader flash failed", e);
          uploadReporter.failure(
            e,
            "Double-tap RESET and try the upload again.",
          );
          serialManager.resume();
          connectBtn.disabled = false;
          disconnectBtn.disabled = true;
          baudSelect.disabled = false;
          updateCompileButtons();
        }
      };

      const handleBootloaderCancel = () => {
        closeModal(bootloaderModal);
        cleanupBootloader();
        terminal.write("\r\nUpload Cancelled.\r\n");
        serialManager.resume();
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        baudSelect.disabled = false;
        updateCompileButtons();
      };

      const cleanupBootloader = () => {
        modalSelectPortBtn.removeEventListener("click", handleBootloaderSelect);
        modalCancelBtn.removeEventListener("click", handleBootloaderCancel);
      };

      modalSelectPortBtn.addEventListener("click", handleBootloaderSelect);
      modalCancelBtn.addEventListener("click", handleBootloaderCancel);

      return;
    }

    if (error.code === "RESET_REQUIRED") {
      terminal.write(
        `\r\n\x1b[1;33mAction Required: ${error.message}\x1b[0m\r\n`,
      );

      // Show Modal
      openModal(bootloaderModal, modalCancelBtn);

      const handleSelect = async () => {
        closeModal(bootloaderModal);
        cleanup();

        try {
          const newPort = await navigator.serial.requestPort();
          terminal.write("\r\nResuming upload with new port...\r\n");
          await handleUpload(newPort, firmwareData, fqbn);
        } catch (e) {
          terminal.write("\r\nUpload Cancelled.\r\n");
          serialManager.resume();
          // Reset UI
          connectBtn.disabled = false;
          disconnectBtn.disabled = true;
          baudSelect.disabled = false;
          updateCompileButtons();
        }
      };

      const handleCancel = () => {
        closeModal(bootloaderModal);
        cleanup();
        terminal.write("\r\nUpload Cancelled.\r\n");
        serialManager.resume();
        // Reset UI
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        baudSelect.disabled = false;
        updateCompileButtons();
      };

      const cleanup = () => {
        modalSelectPortBtn.removeEventListener("click", handleSelect);
        modalCancelBtn.removeEventListener("click", handleCancel);
      };

      modalSelectPortBtn.addEventListener("click", handleSelect);
      modalCancelBtn.addEventListener("click", handleCancel);

      return;
    }

    logger.error("Upload failed", error);
    uploadReporter.failure(error);

    // Try to reconnect
    try {
      // Ensure port is closed before trying to reopen
      if (port && port.readable) {
        try {
          await port.close();
        } catch (e) {}
      }

      const baudRate =
        parseInt(baudSelect.value, 10) ||
        lastWorkingBaudRate ||
        getDefaultBaudRate(boardSelect.value);
      lastWorkingBaudRate = baudRate;
      baudSelect.value = baudRate.toString();
      // Retry: the board may be sitting in its DFU bootloader (no CDC port)
      // for ~10s after a failed touch/flash before rebooting into the app,
      // and a re-enumerated device needs a FRESH SerialPort object - the
      // saved one is dead. Refresh from getPorts() (granted ports) on each
      // retry per the Web Serial API guidance.
      let recovered = false;
      for (let attempt = 1; attempt <= 6 && !recovered; attempt++) {
        try {
          if (attempt > 1 || !port) {
            try {
              const granted = await navigator.serial.getPorts();
              // Prefer a connected granted port; fall back to the saved one.
              const fresh = granted.find((p) => p.connected !== false);
              if (fresh) {
                port = fresh;
              }
            } catch (portsError) {
              logger.warn("getPorts() refresh failed", portsError);
            }
          }
          // If we have a saved port, try to reuse it
          if (port) {
            await serialManager.connect(baudRate, port);
          } else {
            await serialManager.connect(baudRate);
          }
          recovered = true;
        } catch (retryError) {
          logger.warn(`Recovery attempt ${attempt} failed`, retryError);
          if (attempt < 6) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw retryError;
          }
        }
      }

      try {
        await serialManager.write("\r\n");
      } catch (handshakeError) {
        logger.warn("Unable to send recovery handshake", handshakeError);
      }
      // Resume serial monitor after error recovery
      serialManager.resume();
    } catch (e) {
      logger.error("Recovery reconnect failed", e);
      serialManager.resume();
      // Reset UI to disconnected state
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      baudSelect.disabled = false;
      updateCompileButtons();
      serialInput.disabled = true;
      sendBtn.disabled = true;
    }
  }
}

// Compile & Upload Button Handler
compileUploadBtn.addEventListener("click", async () => {
  const fqbn = boardSelect.value;
  const sketchPath = sketchSelect.value;
  const uploadMode = getBoardUploadMode();

  // UF2 DOWNLOAD MODE (Pico, Teensy, etc.)
  if (uploadMode === "uf2-download") {
    terminal.write(`\r\n[UF2 Download Mode] Board: ${fqbn}\r\n`);

    // 1. Compile
    const artifactUrl = await compileSketch();
    if (!artifactUrl) return;

    // 2. Download the firmware file
    try {
      terminal.write("Preparing firmware for download...\r\n");
      const response = await bridgeFetch(artifactUrl, { timeoutMs: 60000 });
      if (!response.ok)
        throw new Error("Failed to download firmware from server");

      const firmwareBlob = await response.blob();

      // Determine filename from URL or generate one
      const urlParts = artifactUrl.split("/");
      let filename = urlParts[urlParts.length - 1];

      // Ensure proper extension based on board type
      if (fqbn.includes("rp2040") || fqbn.includes("rpipico")) {
        if (!filename.endsWith(".uf2")) {
          filename = sketchPath.split("/").pop().replace(".ino", "") + ".uf2";
        }
      } else if (fqbn.includes("teensy")) {
        if (!filename.endsWith(".hex")) {
          filename = sketchPath.split("/").pop().replace(".ino", "") + ".hex";
        }
      }

      // Create download link and trigger browser download
      const downloadUrl = URL.createObjectURL(firmwareBlob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      terminal.write(
        `\r\n\x1b[1;32mFirmware downloaded: ${filename}\x1b[0m\r\n`,
      );

      // Show upload instructions
      const instructions = getBoardUploadInstructions();
      if (instructions) {
        terminal.write(`\r\n\x1b[1;33mNext Steps:\x1b[0m ${instructions}\r\n`);
      }
    } catch (error) {
      terminal.write(`\r\n\x1b[1;31mError: ${error.message}\x1b[0m\r\n`);
    }

    return;
  }

  // SERIAL UPLOAD MODE (AVR, BOSSA, ESP32, etc.)
  if (!serialManager.provider.port) return;

  // Capture port immediately to ensure we have it even if disconnected during compile
  const savedPort = serialManager.provider.port;

  // Check for board mismatch before starting upload
  const shouldProceed = await checkBoardMismatch(savedPort, fqbn);
  if (!shouldProceed) {
    return; // User cancelled due to mismatch
  }

  // Pause serial monitor during compile/upload to avoid garbled output
  serialManager.pause();
  terminal.write("\r\n[Serial Monitor paused during compile/upload]\r\n");

  // All uploads use client-side Web Serial (BOSSA, AVR, ESP32, etc.)
  // Note: Server-side upload was attempted but doesn't work in GitHub Codespaces
  // since the Arduino is connected to the user's browser, not the server.

  const boardName = availableBoards.find((b) => b.fqbn === fqbn)?.name || fqbn;
  const sketchName = sketchPath.split("/").pop();
  uploadReporter.start(`${sketchName} \u2192 ${boardName}`);

  // 1. Compile
  uploadReporter.phase("compile", "Compiling sketch\u2026");
  const artifactUrl = await compileSketch();
  if (!artifactUrl) {
    uploadReporter.failure(
      "Compilation failed",
      "See the compiler output above.",
    );
    // Resume on compile failure
    serialManager.resume();
    terminal.write("[Serial Monitor resumed]\r\n");
    return;
  }

  // 2. Download Firmware
  let firmwareData;
  try {
    uploadReporter.phase("prepare", "Preparing firmware and port\u2026");
    const response = await bridgeFetch(artifactUrl, { timeoutMs: 60000 });
    if (!response.ok) throw new Error("Failed to download firmware");
    firmwareData = await response.arrayBuffer();

    // 3. Disconnect Serial Monitor
    if (serialManager.provider.port) {
      await serialManager.disconnect();
    }

    // Start Upload Process
    await handleUpload(savedPort, firmwareData, fqbn);
  } catch (error) {
    uploadReporter.failure(error);
  }
});

// Get default baud rate for a board (used when user hasn't selected a baud)
function getDefaultBaudRate(fqbn) {
  // Legacy AVR boards (Uno, Mega, Nano) traditionally used 9600
  // but 115200 is fine for them too and more responsive
  // Only return 9600 for very old/slow boards if needed
  return 115200;
}

// ==========================================
// I2C Scanner Tool
// ==========================================

/** Compile path of the bundled I2C scanner sketch (resolved server-side) */
const I2C_SCANNER_SKETCH = "__TOOL__:i2c-scanner";

/** Baud rate used by the bundled I2C scanner sketch */
const I2C_SCANNER_BAUD = 115200;

/**
 * Compile and upload the bundled I2C scanner sketch, then show the scan
 * results in the serial monitor. Reuses the standard upload pipeline, so
 * board-specific protocols are untouched.
 */
async function runI2cScan() {
  const fqbn = boardSelect.value;

  if (!fqbn) {
    terminal.write("\r\n[I2C] Select a board first.\r\n");
    return;
  }

  if (getBoardUploadMode() === "uf2-download") {
    terminal.write(
      "\r\n[I2C] This board uses download mode, so the scanner cannot be uploaded automatically.\r\n",
    );
    terminal.write(
      "[I2C] Compile the bundled I2C scanner manually or use a serial-upload board.\r\n",
    );
    return;
  }

  if (!serialManager.provider.port) {
    terminal.write("\r\n[I2C] Connect to the board first.\r\n");
    return;
  }

  const confirmed = window.confirm(
    "The I2C scanner will REPLACE the sketch currently on the board. " +
      "Re-upload your own sketch afterwards to restore it.\n\nContinue?",
  );
  if (!confirmed) {
    terminal.write("\r\n[I2C] Scan cancelled.\r\n");
    return;
  }

  // Capture port immediately in case it is lost during compile
  const savedPort = serialManager.provider.port;

  // Check for board mismatch before starting upload
  const shouldProceed = await checkBoardMismatch(savedPort, fqbn);
  if (!shouldProceed) {
    return;
  }

  serialManager.pause();
  terminal.write("\r\n[I2C] Compiling scanner sketch...\r\n");

  const artifactUrl = await compileSketch(I2C_SCANNER_SKETCH);
  if (!artifactUrl) {
    serialManager.resume();
    terminal.write("[Serial Monitor resumed]\r\n");
    return;
  }

  // The scanner prints at 115200 baud - reconnect at that rate after upload
  baudSelect.value = I2C_SCANNER_BAUD.toString();
  lastWorkingBaudRate = I2C_SCANNER_BAUD;

  try {
    uploadReporter.start(`I2C scanner \u2192 ${fqbn}`);
    uploadReporter.phase("prepare", "Preparing firmware and port\u2026");
    const response = await bridgeFetch(artifactUrl, { timeoutMs: 60000 });
    if (!response.ok) throw new Error("Failed to download firmware");
    const firmwareData = await response.arrayBuffer();

    if (serialManager.provider.port) {
      await serialManager.disconnect();
    }

    await handleUpload(savedPort, firmwareData, fqbn);
    terminal.write(
      "\r\n[I2C] Scanner running — results appear above every 10 seconds.\r\n",
    );
  } catch (error) {
    uploadReporter.failure(error);
    serialManager.resume();
  }
}

if (i2cScanBtn) {
  i2cScanBtn.addEventListener("click", runI2cScan);
}

/**
 * Check if the connected port's VID/PID matches the selected board.
 * Returns a promise that resolves to true if upload should proceed,
 * false if user cancelled.
 * @param {SerialPort} port - The connected serial port
 * @param {string} fqbn - The selected board FQBN
 * @returns {Promise<boolean>} - true if upload should proceed
 */
function checkBoardMismatch(port, fqbn) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(true); // No port, let upload handle the error
      return;
    }

    const portInfo = port.getInfo();
    const selectedBoard = availableBoards.find((b) => b.fqbn === fqbn);

    // If no VID/PID info or no board metadata, skip check
    if (!portInfo.usbVendorId || !portInfo.usbProductId || !selectedBoard) {
      resolve(true);
      return;
    }

    // Tier-driven policy: warn ONLY when the device positively identifies
    // as a DIFFERENT tier-1 (official) board, the selected board does not
    // list the pair in any tier, and no learned mapping covers it.
    const { warn, detectedName } = shouldWarnMismatch(
      portInfo.usbVendorId,
      portInfo.usbProductId,
      fqbn,
      knownBoardsCatalog,
      learnedDeviceMap,
    );
    if (!warn) {
      resolve(true);
      return;
    }

    // Format VID/PID for display
    const vidHex = portInfo.usbVendorId
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
    const pidHex = portInfo.usbProductId
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
    const connectedLabel = `${detectedName} (VID:${vidHex}, PID:${pidHex})`;

    // Update modal content
    mismatchConnected.textContent = connectedLabel;
    mismatchSelected.textContent = selectedBoard.name;

    // Show modal
    openModal(mismatchModal, mismatchCancelBtn);

    const handleContinue = () => {
      closeModal(mismatchModal);
      cleanup();
      logger.warn(
        `Board Mismatch: User chose to proceed. Connected: ${connectedLabel}, Selected: ${selectedBoard.name}`,
      );
      resolve(true);
    };

    const handleCancel = () => {
      closeModal(mismatchModal);
      cleanup();
      terminal.write(
        "\r\n\x1b[1;33mUpload cancelled due to board mismatch.\x1b[0m\r\n",
      );
      resolve(false);
    };

    const cleanup = () => {
      mismatchContinueBtn.removeEventListener("click", handleContinue);
      mismatchCancelBtn.removeEventListener("click", handleCancel);
    };

    mismatchContinueBtn.addEventListener("click", handleContinue);
    mismatchCancelBtn.addEventListener("click", handleCancel);
  });
}

// Connect Button Handler
connectBtn.addEventListener("click", async () => {
  // Request the port first (user selects from dialog). Cancelling the
  // browser's port picker throws NotFoundError/NotAllowedError - that is a
  // normal user action, not a fault, so show a friendly message instead of
  // a red error.
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (error) {
    if (
      error &&
      (error.name === "NotFoundError" || error.name === "NotAllowedError")
    ) {
      terminal.write(
        "\r\n[Bridge] Connection cancelled — no serial port selected.\r\n",
      );
      // The Web Serial picker throws the same error for "user cancelled"
      // and "the list was empty", so offer driver/cable guidance covering
      // the empty-list case and let the user dismiss it if they cancelled.
      showGuidance({
        title: "No serial device selected",
        lines: [
          "If the port list was EMPTY, the computer has not detected the board as a serial device.",
          "1. Check the USB cable - it must be a DATA cable, not charge-only. The power LED turning on does not prove data works; try a different cable and USB port.",
          "2. Check the driver - boards using CP210x, CH340 or FTDI chips need a driver installed on THIS computer (see the Drivers tab).",
          "3. Check the board's firmware/bootloader - a board with corrupted firmware may not appear as a serial device; double-tap RESET to enter the bootloader.",
          "If you simply cancelled the dialog, dismiss this message.",
        ],
        actionLabel: "Open driver guide",
        onAction: () => openViewWithSearch("drivers"),
      });
      return;
    }
    logger.error("Port selection failed", error);
    terminal.write(`\r\nError: ${error.message}\r\n`);
    return;
  }

  try {
    // Get port info for board detection
    const portInfo = port.getInfo();

    if (portInfo.usbVendorId && portInfo.usbProductId) {
      // Three-tier resolution: learned mapping -> tier 1 (official Arduino
      // VID:PIDs) -> tier 2 (most common board per clone chip). Tier 3 is
      // never auto-selected.
      const resolved = resolveBoardForDevice(
        portInfo.usbVendorId,
        portInfo.usbProductId,
        knownBoardsCatalog,
        learnedDeviceMap,
      );

      if (resolved) {
        const installed = availableBoards.find((b) => b.fqbn === resolved.fqbn);
        if (installed) {
          boardSelect.value = resolved.fqbn;
          terminal.write(`\r\nAuto-detected board: ${installed.name}\r\n`);
          updateCompileButtons();
          // Setting .value programmatically does NOT fire the change event,
          // so regenerate IntelliSense for the detected board explicitly
          void updateIntellisenseForBoard(resolved.fqbn);
        } else {
          // Board recognised but its platform core is not installed yet
          const platformId = resolved.fqbn.split(":").slice(0, 2).join(":");
          const boardName = resolved.name || resolved.fqbn;
          terminal.write(
            `\r\nDetected ${boardName}, but its board platform (${platformId}) is not installed.\r\n`,
          );
          showGuidance({
            title: "\ud83d\udce6 Board platform required",
            lines: [
              `Your ${boardName} was detected, but the "${platformId}" platform needed to compile for it is not installed.`,
              "Open the Board Manager tab, find the board, and click Install (this can take a minute or two).",
              "When the install finishes, select your sketch and compile again.",
            ],
            actionLabel: "Open Board Manager",
            onAction: () =>
              openViewWithSearch(
                "boards",
                boardName.replace(/^Arduino\s+/i, ""),
              ),
          });
        }
      }
    }

    // Use selected baud rate (fallback to board default if unset)
    const selectedBaud =
      parseInt(baudSelect.value, 10) || getDefaultBaudRate(boardSelect.value);
    lastWorkingBaudRate = selectedBaud;
    baudSelect.value = selectedBaud.toString();

    // Connect with SerialManager using the selected baud rate and port
    await serialManager.connect(selectedBaud, port);

    // Send newline so sketches can detect the serial monitor opening
    try {
      await serialManager.write("\r\n");
    } catch (handshakeError) {
      logger.warn("Unable to send connection handshake", handshakeError);
    }

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    updateCompileButtons();

    // Enable Input
    serialInput.disabled = false;
    sendBtn.disabled = false;

    terminal.write("\r\nConnected to Serial Port\r\n");
  } catch (error) {
    logger.error("Connection failed", error);
    terminal.write(`\r\nError: ${error.message}\r\n`);
  }
});

// Disconnect Button Handler
disconnectBtn.addEventListener("click", async () => {
  try {
    await serialManager.disconnect();

    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    // baudSelect.disabled = false; // Always enabled now
    updateCompileButtons();

    // Disable Input
    serialInput.disabled = true;
    sendBtn.disabled = true;

    terminal.write("\r\nDisconnected\r\n");
  } catch (error) {
    console.error("Disconnect failed:", error);
  }
});

// Baud Rate Change Handler
baudSelect.addEventListener("change", async () => {
  let newBaudRate = parseInt(baudSelect.value, 10);
  if (Number.isNaN(newBaudRate)) {
    newBaudRate = lastWorkingBaudRate || getDefaultBaudRate(boardSelect.value);
    baudSelect.value = newBaudRate.toString();
  }

  // Always track the selected baud rate for reconnection
  lastWorkingBaudRate = newBaudRate;

  // If connected, reconnect with new baud rate
  if (serialManager.provider.port) {
    const savedPort = serialManager.provider.port;

    terminal.write(`\r\nChanging baud rate to ${newBaudRate}...\r\n`);

    try {
      await serialManager.disconnect();
      await serialManager.connect(newBaudRate, savedPort);
      try {
        await serialManager.write("\r\n");
      } catch (handshakeError) {
        console.warn(
          "[Client] Unable to send baud-change handshake:",
          handshakeError,
        );
      }
      terminal.write(`Baud rate changed to ${newBaudRate}\r\n`);
    } catch (error) {
      console.error("Failed to change baud rate:", error);
      terminal.write(`\r\nError changing baud rate: ${error.message}\r\n`);

      // If reconnection failed, update UI to disconnected state
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      updateCompileButtons();
      serialInput.disabled = true;
      sendBtn.disabled = true;
    }
  }
});

// Handle incoming data for Terminal
serialManager.provider.on("data", (data) => {
  // Stay silent while a compile/upload is in progress so device output
  // (plotter/heartbeat lines) doesn't interleave with the build log.
  if (serialManager.paused) {
    return;
  }
  terminal.write(data);
});

// Keep the UI in sync when the device is lost unexpectedly (unplug/reset).
// Intentional disconnects (user click, upload flow) manage the UI themselves.
serialManager.provider.on("disconnect", (info) => {
  if (info && info.unexpected) {
    terminal.write(
      "\r\n\x1b[1;33m[Bridge] Device connection lost — attempting to reconnect...\x1b[0m\r\n",
    );
    updateConnectionUIState(false);
    updateCompileButtons();
  }
});

serialManager.provider.on("reconnect", () => {
  terminal.write(
    "\r\n\x1b[1;32m[Bridge] Reconnected to serial port.\x1b[0m\r\n",
  );
  updateConnectionUIState(true);
  updateCompileButtons();
});

serialManager.provider.on("reconnect_failed", () => {
  terminal.write(
    "\r\n\x1b[1;31m[Bridge] Could not reconnect — please reconnect manually.\x1b[0m\r\n",
  );
  updateConnectionUIState(false);
  updateCompileButtons();
});

// Handle parsed lines for Plotter
serialManager.on("line", (line) => {
  // Simple parser for "Arduino Serial Plotter" format
  // Supports: "val1, val2, val3" or "val1 val2" or "label:val1"

  const trimmed = line.trim();
  if (!trimmed) return;

  // 1. Try to match "Label:Value" pairs first?
  // Actually, standard Arduino plotter is simpler: just look for numbers.
  // But "Label:Value" is a common extension.

  // Regex to find numbers.
  // This splits by comma or space, then checks if parts are numbers.
  const parts = trimmed.split(/[\s,]+/);
  const values = [];

  for (const part of parts) {
    // Check for "Label:Value"
    if (part.includes(":")) {
      const subparts = part.split(":");
      const val = parseFloat(subparts[1]);
      if (!isNaN(val)) values.push(val);
    } else {
      const val = parseFloat(part);
      if (!isNaN(val)) values.push(val);
    }
  }

  if (values.length > 0) {
    const timestamp = new Date().toLocaleTimeString();
    plotter.addData(timestamp, values);
  }
});

// Handle terminal input (direct typing)
terminal.onData((data) => {
  serialManager.write(data);
});

// Handle Input Bar Send
function sendData() {
  const data = serialInput.value;
  const endings = {
    none: "",
    nl: "\n",
    cr: "\r",
    nlcr: "\r\n",
  };
  const ending = endings[lineEndingSelect.value] || "";

  // Send if there is data or just a line ending
  if (data || ending) {
    serialManager.write(data + ending);
    serialInput.value = "";
  }
}

sendBtn.addEventListener("click", sendData);

serialInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    sendData();
  }
});

// ==========================================
// Main Navigation Setup
// ==========================================

function setupNavigation() {
  const navTabs = document.querySelectorAll(".nav-tab");
  const views = document.querySelectorAll(".view-container");
  const inputBar = document.querySelector(".input-bar");
  const toolbarGroup = document.querySelector(".toolbar-group");

  // Handle navigation tab clicks
  navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetView = tab.dataset.view;

      // Update active tab
      navTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      // Update active view
      views.forEach((v) => v.classList.remove("active"));
      const targetViewEl = document.getElementById(`${targetView}-view`);
      if (targetViewEl) {
        targetViewEl.classList.add("active");
      }

      // Show/hide serial-specific UI elements
      const isSerialView = targetView === "serial";
      if (inputBar) {
        inputBar.style.display = isSerialView ? "flex" : "none";
      }
      if (toolbarGroup) {
        toolbarGroup.style.display = isSerialView ? "flex" : "none";
      }

      // Resize terminal when switching to serial view
      if (isSerialView && terminal && terminal.fit) {
        setTimeout(() => terminal.fit(), 100);
      }
    });
  });

  // Handle hash-based routing (for deep links)
  function handleHashRoute() {
    const hash = window.location.hash.replace("#/", "").replace("#", "");
    const validViews = [
      "serial",
      "boards",
      "libraries",
      "reference",
      "drivers",
    ];

    if (validViews.includes(hash)) {
      const tab = document.querySelector(`.nav-tab[data-view="${hash}"]`);
      if (tab) {
        tab.click();
      }
    }
  }

  // Listen for hash changes
  window.addEventListener("hashchange", handleHashRoute);

  // Check initial hash on load
  if (window.location.hash) {
    handleHashRoute();
  }
}
