/**
 * IntelliSense Configuration Builder
 *
 * Pure functions that turn `arduino-cli board details` build properties
 * into a cpptools c_cpp_properties.json configuration. Kept free of any
 * vscode/server dependencies so the exact logic the extension ships can
 * be exercised by the automated test suite (test/intellisense.test.mjs).
 *
 * @module config/intellisenseConfig
 */

import * as path from "path";

/** Options that influence how an IntelliSense configuration is generated. */
export interface IntelliSenseBuildOptions {
  /** Home directory used for the user sketchbook libraries path */
  homeDir: string;
}

/** A single c_cpp_properties.json configuration entry. */
export interface IntelliSenseConfiguration {
  name: string;
  compilerPath?: string;
  compilerArgs: string[];
  intelliSenseMode: string;
  includePath: string[];
  forcedInclude: string[];
  cStandard: string;
  cppStandard: string;
  defines: string[];
}

/** The full c_cpp_properties.json file shape produced for the workspace. */
export interface IntelliSenseConfigFile {
  version: number;
  configurations: IntelliSenseConfiguration[];
}

/**
 * Parse the flat "key=value" build_properties array from
 * `arduino-cli board details --format json`.
 * @param buildProperties - Raw build property strings
 * @returns Key/value map of build properties
 */
export function parseBuildProperties(
  buildProperties: string[],
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of buildProperties || []) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      props[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return props;
}

/**
 * Build a cpptools configuration for a board from its build properties.
 *
 * Key details that make Arduino built-ins resolve without false errors:
 * - compilerPath points at the real cross compiler so cpptools queries its
 *   intrinsic defines and system include paths
 * - compilerArgs carries the MCU flag; without -mmcu, avr-g++ defines no
 *   chip macros (__AVR_ATmega328P__), avr/io.h declares no registers, and
 *   register-guarded core symbols like `Serial` (#if defined(UBRR0H))
 *   disappear
 * - Arduino.h is force-included, mirroring what the Arduino build system
 *   injects into every .ino file
 *
 * @param buildProperties - Raw build_properties from board details
 * @param options - Environment options (home directory)
 * @returns The config file object, or an error string when properties are unusable
 */
export function buildIntelliSenseConfig(
  buildProperties: string[],
  options: IntelliSenseBuildOptions,
): { config?: IntelliSenseConfigFile; error?: string } {
  const props = parseBuildProperties(buildProperties);

  const platformPath = props["runtime.platform.path"];
  if (!platformPath) {
    return { error: "Board details did not include a platform path" };
  }

  const compilerDir = props["compiler.path"] || "";
  const cppCmd = props["compiler.cpp.cmd"] || "g++";
  const core = props["build.core"] || "arduino";
  const variant = props["build.variant"];
  const arch = (props["build.arch"] || "").toUpperCase();
  const board = props["build.board"] || "";
  const fcpu = props["build.f_cpu"];
  const mcu = props["build.mcu"];
  const ideVersion = props["runtime.ide.version"] || "10607";

  const corePath = path.join(platformPath, "cores", core);
  const includePath = [
    "${workspaceFolder}/**",
    corePath,
    ...(variant ? [path.join(platformPath, "variants", variant)] : []),
    path.join(platformPath, "libraries", "**"),
    path.join(options.homeDir, "Arduino", "libraries", "**"),
  ];

  // Toolchain-internal headers (avr/io.h, cmsis, etc.)
  const toolRoot = compilerDir.replace(/[/\\]?bin[/\\]?$/, "");
  if (toolRoot) {
    if (arch === "AVR") {
      includePath.push(path.join(toolRoot, "avr", "include"));
    } else {
      includePath.push(path.join(toolRoot, "arm-none-eabi", "include"));
    }
  }

  const defines = [
    `ARDUINO=${ideVersion}`,
    ...(fcpu ? [`F_CPU=${fcpu}`] : []),
    ...(board ? [`ARDUINO_${board}`] : []),
    ...(arch ? [`ARDUINO_ARCH_${arch}`] : []),
  ];

  const compilerArgs: string[] = [];
  if (mcu) {
    compilerArgs.push(arch === "AVR" ? `-mmcu=${mcu}` : `-mcpu=${mcu}`);
  }

  return {
    config: {
      version: 4,
      configurations: [
        {
          name: "Arduino",
          compilerPath: compilerDir
            ? path.join(compilerDir, cppCmd)
            : undefined,
          compilerArgs,
          intelliSenseMode: arch === "AVR" ? "gcc-x64" : "gcc-arm",
          includePath,
          forcedInclude: [path.join(corePath, "Arduino.h")],
          cStandard: "c11",
          cppStandard: arch === "AVR" ? "c++11" : "c++17",
          defines,
        },
      ],
    },
  };
}
