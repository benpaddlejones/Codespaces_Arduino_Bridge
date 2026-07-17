/**
 * DriversUI - USB driver directory and troubleshooting guide.
 *
 * Renders a static catalogue of the serial/DFU drivers a student may need
 * on the machine running the browser (Windows / macOS / Linux), plus a
 * "no serial device found" troubleshooting checklist. All content is static
 * data defined in this module - no user input is ever rendered.
 *
 * @module ui/DriversUI
 */

import { Logger } from "../../shared/Logger.js";

/** @type {Logger} */
const logger = new Logger("DriversUI");

/**
 * Troubleshooting checklist shown at the top of the view. Ordered by how
 * often each cause is the real problem in a classroom.
 * @type {{title: string, steps: string[]}}
 */
const CHECKLIST = {
  title: "No serial device found? Work through this list",
  steps: [
    "Use a USB DATA cable - many phone-charger cables have no data wires. The board's power LED turning on does NOT prove the cable carries data. If in doubt, swap the cable first.",
    "Try a different USB port (avoid unpowered hubs) and replug the board.",
    "Check the board is recognised by the computer: Windows - Device Manager (look under 'Ports (COM & LPT)' or for a yellow warning under 'Other devices'); macOS - System Information > USB; Linux - run 'lsusb' or 'dmesg | tail' after plugging in.",
    "If the device shows a warning or appears without a COM/tty port, install the matching driver from the directory below, then replug the board.",
    "Make sure the board has working firmware/bootloader: a brand-new or corrupted board may not enumerate as a serial device at all. If the board was mid-upload when unplugged, double-tap RESET to enter the bootloader.",
    "Use Chrome or Edge in a full browser window - Web Serial does not work in other browsers or embedded webviews.",
    "On Linux, add yourself to the serial group: sudo usermod -a -G dialout $USER (log out and back in), and remove brltty if it grabs CP210x adapters: sudo apt remove brltty.",
  ],
};

/**
 * Driver directory data. Each entry describes one driver family: which
 * chips/boards need it, and per-OS download links and instructions.
 * @type {Array<{
 *   id: string,
 *   icon: string,
 *   name: string,
 *   appliesTo: string,
 *   hint: string,
 *   os: Array<{os: string, status: string, url?: string, urlLabel?: string, steps: string[]}>
 * }>}
 */
const DRIVER_DATA = [
  {
    id: "arduino-official",
    icon: "♾️",
    name: "Official Arduino boards (native USB)",
    appliesTo:
      "Genuine UNO R3, UNO R4 Minima/WiFi, Nano, Leonardo, Micro, Mega 2560, Nano R4 (VID 0x2341)",
    hint: "Modern operating systems recognise genuine Arduino boards without extra drivers. Installing the Arduino IDE registers all official drivers in one go and is the easiest blanket fix on Windows.",
    os: [
      {
        os: "Windows",
        status: "Usually built in (Windows 10/11)",
        url: "https://www.arduino.cc/en/software",
        urlLabel: "Arduino IDE (bundles all official drivers)",
        steps: [
          "Windows 10/11 installs the driver automatically when online - plug in and wait a minute.",
          "If the board never appears, install the Arduino IDE - its installer registers signed drivers for every official board.",
        ],
      },
      {
        os: "macOS",
        status: "Built in - no driver needed",
        steps: ["Plug in and the port appears as /dev/cu.usbmodem*."],
      },
      {
        os: "Linux / ChromeOS",
        status: "Built in - no driver needed",
        steps: [
          "Port appears as /dev/ttyACM*. Ensure your user is in the dialout group.",
        ],
      },
    ],
  },
  {
    id: "cp210x",
    icon: "🔀",
    name: "Silicon Labs CP210x (CP2102 / CP2102N / CP2104)",
    appliesTo:
      "Most ESP32 dev kits, NodeMCU v1.0, many Arduino-compatible boards (VID 0x10C4)",
    hint: "Only download this driver from Silicon Labs (the chip maker). Avoid third-party 'driver downloader' sites.",
    os: [
      {
        os: "Windows",
        status: "Driver required (if not installed by Windows Update)",
        url: "https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers",
        urlLabel: "CP210x Universal Windows Driver (silabs.com)",
        steps: [
          "Download the 'CP210x Universal Windows Driver' zip and extract it.",
          "Right-click silabser.inf and choose Install (or run CP210xVCPInstaller_x64.exe).",
          "Replug the board - it should appear under 'Ports (COM & LPT)' in Device Manager.",
        ],
      },
      {
        os: "macOS",
        status: "Built in since macOS 10.14",
        url: "https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers",
        urlLabel: "Legacy macOS VCP driver (only for old macOS)",
        steps: [
          "Recent macOS needs no driver - the port appears as /dev/cu.usbserial-* or /dev/cu.SLAB_USBtoUART.",
        ],
      },
      {
        os: "Linux / ChromeOS",
        status: "Built in (cp210x kernel module)",
        steps: [
          "Port appears as /dev/ttyUSB*.",
          "Ubuntu gotcha: the brltty package can claim CP210x devices - sudo apt remove brltty.",
        ],
      },
    ],
  },
  {
    id: "ch340",
    icon: "🔁",
    name: "WCH CH340 / CH341 / CH9102",
    appliesTo:
      "Most low-cost UNO/Nano clones, many ESP8266/ESP32 boards (VID 0x1A86)",
    hint: "Download only from WCH (wch-ic.com), the chip manufacturer.",
    os: [
      {
        os: "Windows",
        status: "Driver usually required",
        url: "https://www.wch-ic.com/downloads/CH341SER_EXE.html",
        urlLabel: "CH341SER installer (wch-ic.com)",
        steps: [
          "Download and run CH341SER.EXE, click Install.",
          "Replug the board - it appears under 'Ports (COM & LPT)' as USB-SERIAL CH340.",
        ],
      },
      {
        os: "macOS",
        status: "Built in since macOS 13; driver for older versions",
        url: "https://www.wch-ic.com/downloads/CH34XSER_MAC_ZIP.html",
        urlLabel: "CH34X macOS driver (wch-ic.com)",
        steps: [
          "macOS 13+ needs no driver (port: /dev/cu.usbserial-*).",
          "Older macOS: install the CH34X driver and allow it in System Settings > Privacy & Security.",
        ],
      },
      {
        os: "Linux / ChromeOS",
        status: "Built in (ch341 kernel module)",
        steps: ["Port appears as /dev/ttyUSB*. Same brltty caveat as CP210x."],
      },
    ],
  },
  {
    id: "ftdi",
    icon: "🔂",
    name: "FTDI FT232R / FT231X",
    appliesTo:
      "Older official Arduino boards (Nano v3, Duemilanove), SparkFun/Adafruit FTDI adapters (VID 0x0403)",
    hint: "Download only from FTDI (ftdichip.com).",
    os: [
      {
        os: "Windows",
        status: "Usually installed by Windows Update",
        url: "https://ftdichip.com/drivers/vcp-drivers/",
        urlLabel: "FTDI VCP drivers (ftdichip.com)",
        steps: [
          "Windows 10/11 normally installs the driver automatically when online.",
          "Offline machines: download the 'setup executable' from the VCP drivers page and run it.",
        ],
      },
      {
        os: "macOS",
        status: "Built in since macOS 10.9",
        steps: ["Port appears as /dev/cu.usbserial-*."],
      },
      {
        os: "Linux / ChromeOS",
        status: "Built in (ftdi_sio kernel module)",
        steps: ["Port appears as /dev/ttyUSB*."],
      },
    ],
  },
  {
    id: "r4-winusb",
    icon: "🛠️",
    name: "UNO R4 family DFU upload driver (WinUSB via Zadig)",
    appliesTo:
      "UNO R4 Minima, UNO R4 WiFi, Nano R4 - uploads only (the serial monitor works without it)",
    hint: "Windows-only, one-time per PC. Without WinUSB the upload device chooser is EMPTY because Chrome cannot see the board's DFU bootloader (Device Manager shows e.g. 'Santiago DFU' with a Code 28 warning).",
    os: [
      {
        os: "Windows",
        status: "Driver required for uploads",
        url: "https://zadig.akeo.ie",
        urlLabel: "Zadig (zadig.akeo.ie)",
        steps: [
          "Option A - Zadig (fastest): download Zadig, double-tap the board's RESET button (LED pulses), then Options > List All Devices > select the board's DFU device (e.g. 'Santiago DFU') > target driver WinUSB > Install Driver. Repeat once per board model.",
          "Option B - Arduino IDE: install the IDE plus the 'Arduino UNO R4 Boards' package; its driver installer covers all R4 boards.",
          "After installing, the first upload shows a one-time USB pairing dialog; later uploads are automatic.",
        ],
      },
      {
        os: "macOS",
        status: "No driver needed",
        steps: ["DFU uploads work out of the box."],
      },
      {
        os: "Linux / ChromeOS",
        status: "No driver needed",
        steps: ["DFU uploads work out of the box."],
      },
    ],
  },
  {
    id: "zadig",
    icon: "🧰",
    name: "Zadig - generic Windows USB driver installer",
    appliesTo:
      "Any USB device Windows shows with a yellow warning (Code 28) that a browser needs to access via WebUSB",
    hint: "Zadig replaces the driver bound to a USB device. Only ever change the driver of the DEVICE YOU MEAN TO FIX - rebinding a keyboard/mouse driver by accident will disable it.",
    os: [
      {
        os: "Windows",
        status: "Portable tool - no install needed",
        url: "https://zadig.akeo.ie",
        urlLabel: "zadig.akeo.ie (official site)",
        steps: [
          "Download and run zadig.exe (no installation).",
          "Options > List All Devices, pick the exact device, choose WinUSB as the target driver, click Install/Replace Driver.",
        ],
      },
      {
        os: "macOS / Linux",
        status: "Not needed",
        steps: ["These systems allow WebUSB access without driver changes."],
      },
    ],
  },
];

/**
 * Driver directory view: renders the troubleshooting checklist and the
 * per-OS driver catalogue into the #drivers-view container.
 */
export class DriversUI {
  /**
   * @param {string} containerId - DOM id of the view container element
   */
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.contentEl = document.getElementById("drivers-content");
  }

  /**
   * Render the static content. Safe to call once at startup.
   */
  init() {
    if (!this.contentEl) {
      logger.warn("Content element not found");
      return;
    }
    this.render();
  }

  /**
   * Build and inject the checklist + driver directory markup. All strings
   * come from the static module-level data above (no user input).
   */
  render() {
    let html = '<div class="reference-sections">';

    // Troubleshooting checklist
    html += `
      <div class="reference-section">
        <h3 class="section-title">
          <span class="section-icon">🔍</span>
          ${CHECKLIST.title}
        </h3>
        <ol class="driver-checklist">
          ${CHECKLIST.steps.map((s) => `<li>${s}</li>`).join("")}
        </ol>
      </div>
    `;

    // Driver directory
    for (const driver of DRIVER_DATA) {
      html += `
        <div class="reference-section" id="driver-${driver.id}">
          <h3 class="section-title">
            <span class="section-icon">${driver.icon}</span>
            ${driver.name}
          </h3>
          <p class="driver-applies"><strong>Applies to:</strong> ${driver.appliesTo}</p>
          <p class="driver-hint">${driver.hint}</p>
          <div class="driver-os-grid">
            ${driver.os.map((entry) => this.renderOsEntry(entry)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div>";
    this.contentEl.innerHTML = html;
  }

  /**
   * Render one per-OS card for a driver entry.
   * @param {{os: string, status: string, url?: string, urlLabel?: string, steps: string[]}} entry
   *   Static OS entry from DRIVER_DATA
   * @returns {string} HTML fragment
   */
  renderOsEntry(entry) {
    const link = entry.url
      ? `<a href="${entry.url}" target="_blank" rel="noopener" class="driver-link">⬇️ ${entry.urlLabel}</a>`
      : "";
    return `
      <div class="function-card driver-os-card">
        <div class="function-header">
          <code class="function-name">${entry.os}</code>
          <span class="driver-status">${entry.status}</span>
        </div>
        ${link}
        <ul class="driver-steps">
          ${entry.steps.map((s) => `<li>${s}</li>`).join("")}
        </ul>
      </div>
    `;
  }
}
