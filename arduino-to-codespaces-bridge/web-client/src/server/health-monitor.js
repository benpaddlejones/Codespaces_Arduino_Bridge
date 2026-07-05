/**
 * Health Monitor
 *
 * Periodically samples process health (memory, CPU, uptime), keeps a
 * bounded history, and performs self-healing actions (garbage collection)
 * when memory watermarks are exceeded. Ported from the MicroPython
 * bridge's resilience layer.
 *
 * @module server/health-monitor
 */

import { serverLogger } from "../shared/Logger.js";

// Health check configuration
const HEALTH_CHECK_INTERVAL_MS = 10000; // 10 seconds
const HEALTH_HISTORY_MAX = 100;
const MEMORY_WARNING_MB = 256;
const MEMORY_CRITICAL_MB = 512;

// Monitor state
let healthCheckInterval = null;
let lastHealthCheck = null;
let healthHistory = [];
let isRunning = false;

/**
 * Get current health metrics for the process
 * @returns {object} Snapshot of memory/CPU/uptime metrics
 */
export function getHealthMetrics() {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system,
    },
    pid: process.pid,
    nodeVersion: process.version,
  };
}

/**
 * Run garbage collection if the runtime exposes it (--expose-gc)
 */
function runGarbageCollection() {
  if (global.gc) {
    try {
      global.gc();
      serverLogger.info("[healthMonitor] Garbage collection completed");
    } catch (e) {
      serverLogger.warn(`[healthMonitor] GC failed: ${e.message}`);
    }
  } else {
    serverLogger.info(
      "[healthMonitor] GC not exposed. Start with --expose-gc for manual GC",
    );
  }
}

/**
 * Perform a health check, record it in history, and self-heal if needed
 * @returns {object} The health check result
 */
export function performHealthCheck() {
  const metrics = getHealthMetrics();
  const issues = [];

  if (metrics.memory.heapUsed > MEMORY_CRITICAL_MB) {
    issues.push(
      `CRITICAL: Memory usage ${metrics.memory.heapUsed}MB exceeds ${MEMORY_CRITICAL_MB}MB`,
    );
    serverLogger.warn(`[healthMonitor] ${issues[issues.length - 1]}`);
    runGarbageCollection();
  } else if (metrics.memory.heapUsed > MEMORY_WARNING_MB) {
    issues.push(
      `WARNING: Memory usage ${metrics.memory.heapUsed}MB exceeds ${MEMORY_WARNING_MB}MB`,
    );
    serverLogger.warn(`[healthMonitor] ${issues[issues.length - 1]}`);
  }

  const result = {
    ...metrics,
    healthy: issues.length === 0,
    issues,
  };

  healthHistory.push(result);
  if (healthHistory.length > HEALTH_HISTORY_MAX) {
    healthHistory = healthHistory.slice(-HEALTH_HISTORY_MAX);
  }

  lastHealthCheck = result;
  return result;
}

/**
 * Start periodic health monitoring
 * @param {object} [options] - Monitor options
 * @param {number} [options.interval] - Check interval in milliseconds
 */
export function startHealthMonitor(options = {}) {
  if (isRunning) {
    return;
  }

  const interval = options.interval || HEALTH_CHECK_INTERVAL_MS;
  serverLogger.info(
    `[healthMonitor] Starting health monitoring (every ${interval}ms)`,
  );

  performHealthCheck();

  healthCheckInterval = setInterval(() => {
    try {
      performHealthCheck();
    } catch (error) {
      serverLogger.error(
        `[healthMonitor] Health check error: ${error.message}`,
      );
    }
  }, interval);

  // Prevent the interval from keeping the process alive on its own
  healthCheckInterval.unref();
  isRunning = true;
}

/**
 * Stop the health monitor
 */
export function stopHealthMonitor() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  isRunning = false;
}

/**
 * Get recent health history
 * @param {number} [count=20] - Number of entries to return
 * @returns {object[]} Recent health check results
 */
export function getHealthHistory(count = 20) {
  return healthHistory.slice(-count);
}

/**
 * Get the last health check result
 * @returns {object|null} Last result, or null if no check has run yet
 */
export function getLastHealthCheck() {
  return lastHealthCheck;
}
