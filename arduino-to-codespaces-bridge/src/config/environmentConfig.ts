/**
 * Environment Configuration Utilities
 *
 * Provides functions for managing the workspace-level arduino-bridge configuration
 * file (arduino-requirements.txt). This configuration declares required board
 * platforms and libraries, enabling reproducible Arduino development environments.
 *
 * Features:
 * - **Configuration Schema**: Plain text format with platforms and libraries
 * - **Auto-normalization**: Cleans and validates configuration on read
 * - **Merge-friendly Output**: Sorted entries for clean git diffs
 * - **Concurrency Safety**: Write lock prevents file corruption from concurrent saves
 * - **Legacy Migration**: Transparently migrates arduino-bridge.config.json
 *
 * Configuration File Format:
 * ```text
 * # Platforms
 * platform arduino:avr 1.8.6
 *
 * # Libraries
 * library Servo 1.2.1
 * ```
 *
 * @module config/environmentConfig
 */

import * as fs from "fs";
import * as path from "path";

// Simple write lock to prevent concurrent file writes
let writeLock: Promise<void> = Promise.resolve();

export interface PlatformRequirement {
  id: string;
  version?: string | null;
}

export interface LibraryRequirement {
  name: string;
  version?: string | null;
}

export interface EnvironmentConfig {
  version: number;
  platforms: PlatformRequirement[];
  libraries: LibraryRequirement[];
}

export const CONFIG_FILE_NAME = "arduino-requirements.txt";
const LEGACY_CONFIG_FILE_NAME = "arduino-bridge.config.json";

const DEFAULT_CONFIG: EnvironmentConfig = {
  version: 1,
  platforms: [],
  libraries: [],
};

/**
 * Ensure the config file exists and return its normalized contents
 */
export async function ensureEnvironmentConfig(
  workspaceRoot: string,
): Promise<EnvironmentConfig> {
  const configPath = getConfigPath(workspaceRoot);
  const legacyPath = path.join(workspaceRoot, LEGACY_CONFIG_FILE_NAME);

  // Check for legacy JSON config first: read it, write the new format,
  // delete the old file (one-time migration).
  try {
    await fs.promises.access(legacyPath, fs.constants.F_OK);
    const raw = await fs.promises.readFile(legacyPath, "utf8");
    const parsed = JSON.parse(raw);
    const config = normalizeConfig(parsed, legacyPath);
    await writeConfigFile(configPath, config);
    await fs.promises.unlink(legacyPath);
    return config;
  } catch {
    // No legacy file
  }

  try {
    await fs.promises.access(configPath, fs.constants.F_OK);
  } catch {
    await writeConfigFile(configPath, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  return readEnvironmentConfig(workspaceRoot);
}

/**
 * Read and normalize the configuration file
 */
export async function readEnvironmentConfig(
  workspaceRoot: string,
): Promise<EnvironmentConfig> {
  const configPath = getConfigPath(workspaceRoot);

  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    return parseRequirementsTxt(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${CONFIG_FILE_NAME}: ${message}`);
  }
}

/**
 * Parse the plain-text requirements format:
 *   platform <id> [version]
 *   library <name|"quoted name"> [version]
 * Blank lines and #-comments are ignored.
 */
function parseRequirementsTxt(content: string): EnvironmentConfig {
  const platforms: PlatformRequirement[] = [];
  const libraries: LibraryRequirement[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("platform ")) {
      const parts = trimmed.substring(9).trim().split(/\s+/);
      if (parts.length > 0) {
        platforms.push({ id: parts[0], version: parts[1] || null });
      }
    } else if (trimmed.startsWith("library ")) {
      const rest = trimmed.substring(8).trim();
      // Name may be quoted (library names can contain spaces)
      const match = rest.match(/^(?:"([^"]+)"|([^\s]+))(?:\s+(.+))?$/);
      if (match) {
        const name = match[1] || match[2];
        const version = match[3] || null;
        if (name) {
          libraries.push({ name, version });
        }
      }
    }
  }

  return {
    version: 1,
    platforms: sortPlatforms(platforms),
    libraries: sortLibraries(libraries),
  };
}

/**
 * Write the config file with sorted content for merge friendliness
 */
export async function writeEnvironmentConfig(
  workspaceRoot: string,
  config: EnvironmentConfig,
): Promise<void> {
  const configPath = getConfigPath(workspaceRoot);
  await writeConfigFile(configPath, config);
}

export function getConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_FILE_NAME);
}

function normalizeConfig(config: any, _configPath: string): EnvironmentConfig {
  const version = Number.isInteger(config?.version) ? config.version : 1;

  const platforms = Array.isArray(config?.platforms)
    ? config.platforms
        .map((p: unknown) => normalizePlatform(p))
        .filter(
          (item: PlatformRequirement | null): item is PlatformRequirement =>
            Boolean(item),
        )
    : [];

  const libraries = Array.isArray(config?.libraries)
    ? config.libraries
        .map((l: unknown) => normalizeLibrary(l))
        .filter((item: LibraryRequirement | null): item is LibraryRequirement =>
          Boolean(item),
        )
    : [];

  const normalized: EnvironmentConfig = {
    version,
    platforms: sortPlatforms(platforms),
    libraries: sortLibraries(libraries),
  };

  // Note: We no longer auto-rewrite here to avoid race conditions.
  // Use writeEnvironmentConfig() explicitly when you need to persist changes.

  return normalized;
}

function normalizePlatform(input: any): PlatformRequirement | null {
  if (!input) {
    return null;
  }

  if (typeof input === "string") {
    return input.trim() ? { id: input.trim(), version: null } : null;
  }

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) {
    return null;
  }

  const version =
    typeof input.version === "string" && input.version.trim().length > 0
      ? input.version.trim()
      : null;

  return { id, version };
}

function normalizeLibrary(input: any): LibraryRequirement | null {
  if (!input) {
    return null;
  }

  if (typeof input === "string") {
    return input.trim() ? { name: input.trim(), version: null } : null;
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return null;
  }

  const version =
    typeof input.version === "string" && input.version.trim().length > 0
      ? input.version.trim()
      : null;

  return { name, version };
}

function sortPlatforms(
  platforms: PlatformRequirement[],
): PlatformRequirement[] {
  return [...platforms].sort((a, b) => a.id.localeCompare(b.id));
}

function sortLibraries(libraries: LibraryRequirement[]): LibraryRequirement[] {
  return [...libraries].sort((a, b) => a.name.localeCompare(b.name));
}

function serializeConfig(config: EnvironmentConfig): string {
  let output =
    "# Arduino Bridge Configuration\n# This file is automatically generated. Edits are preserved.\n\n";

  if (config.platforms.length > 0) {
    output += "# Platforms\n";
    for (const p of config.platforms) {
      output += `platform ${p.id}${p.version ? " " + p.version : ""}\n`;
    }
    output += "\n";
  }

  if (config.libraries.length > 0) {
    output += "# Libraries\n";
    for (const l of config.libraries) {
      const name = l.name.includes(" ") ? `"${l.name}"` : l.name;
      output += `library ${name}${l.version ? " " + l.version : ""}\n`;
    }
  }

  return output;
}

async function writeConfigFile(
  configPath: string,
  config: EnvironmentConfig,
): Promise<void> {
  // Use a lock to prevent concurrent writes that can corrupt the file
  const previousLock = writeLock;
  let releaseLock: () => void;
  writeLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    await previousLock; // Wait for any previous write to complete
    const serialized = serializeConfig(config);
    await fs.promises.writeFile(configPath, serialized, {
      encoding: "utf8",
      flag: "w",
    });
  } finally {
    releaseLock!();
  }
}
