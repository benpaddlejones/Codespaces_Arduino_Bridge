/**
 * Environment configuration utilities
 *
 * Provides helpers for reading and writing the workspace-level
 * arduino-bridge configuration file that declares required boards
 * and libraries.
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

export const CONFIG_FILE_NAME = "arduino-bridge.config.json";

const DEFAULT_CONFIG: EnvironmentConfig = {
  version: 1,
  platforms: [],
  libraries: [],
};

/**
 * Ensure the config file exists and return its normalized contents
 */
export async function ensureEnvironmentConfig(
  workspaceRoot: string
): Promise<EnvironmentConfig> {
  const configPath = getConfigPath(workspaceRoot);

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
  workspaceRoot: string
): Promise<EnvironmentConfig> {
  const configPath = getConfigPath(workspaceRoot);

  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${CONFIG_FILE_NAME}: ${message}`);
  }
}

/**
 * Write the config file with sorted content for merge friendliness
 */
export async function writeEnvironmentConfig(
  workspaceRoot: string,
  config: EnvironmentConfig
): Promise<void> {
  const configPath = getConfigPath(workspaceRoot);
  await writeConfigFile(configPath, config);
}

export function getConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_FILE_NAME);
}

function normalizeConfig(config: any, configPath: string): EnvironmentConfig {
  const version = Number.isInteger(config?.version) ? config.version : 1;

  const platforms = Array.isArray(config?.platforms)
    ? config.platforms
        .map(normalizePlatform)
        .filter((item): item is PlatformRequirement => Boolean(item))
    : [];

  const libraries = Array.isArray(config?.libraries)
    ? config.libraries
        .map(normalizeLibrary)
        .filter((item): item is LibraryRequirement => Boolean(item))
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
  platforms: PlatformRequirement[]
): PlatformRequirement[] {
  return [...platforms].sort((a, b) => a.id.localeCompare(b.id));
}

function sortLibraries(libraries: LibraryRequirement[]): LibraryRequirement[] {
  return [...libraries].sort((a, b) => a.name.localeCompare(b.name));
}

function serializeConfig(config: EnvironmentConfig): string {
  const payload = {
    version: config.version,
    platforms: config.platforms.map((item) =>
      item.version ? { id: item.id, version: item.version } : { id: item.id }
    ),
    libraries: config.libraries.map((item) =>
      item.version
        ? { name: item.name, version: item.version }
        : { name: item.name }
    ),
  };

  return JSON.stringify(payload, null, 2) + "\n";
}

async function writeConfigFile(
  configPath: string,
  config: EnvironmentConfig
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
