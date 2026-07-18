/**
 * Board resolver - three-tier board identification policy.
 *
 * Resolution order for a connected VID:PID (see TODOS'md spec):
 *   1. Learned mapping (successful upload recorded in
 *      arduino-requirements.txt) - always wins.
 *   2. Tier 1 - official Arduino VID:PIDs from the official boards.txt.
 *   3. Tier 2 - probable non-Arduino devices; each VID:PID appears exactly
 *      once in tier 2 (the most common board for that chip).
 *   Tier 3 entries (duplicates sharing an already-used VID:PID) are NEVER
 *   auto-selected - they only suppress mismatch warnings.
 *
 * Pure module (no browser APIs) so tests can import it under Node.
 */

/**
 * Test whether a catalog entry lists the given VID:PID pair.
 * @param {object} board - Catalog entry with hex-string vid[]/pid[] arrays
 * @param {number} vid - USB vendor id
 * @param {number} pid - USB product id
 * @returns {boolean} True when both ids are listed
 */
export function boardListsPair(board, vid, pid) {
  if (!Array.isArray(board.vid) || !Array.isArray(board.pid)) return false;
  return (
    board.vid.some((v) => parseInt(v, 16) === vid) &&
    board.pid.some((p) => parseInt(p, 16) === pid)
  );
}

/**
 * Build the canonical learned-map key for a VID:PID pair.
 * @param {number} vid - USB vendor id
 * @param {number} pid - USB product id
 * @returns {string} Key in the form "0xVVVV:0xPPPP"
 */
export function devicePairKey(vid, pid) {
  const hex = (n) => `0x${n.toString(16).padStart(4, "0")}`;
  return `${hex(vid)}:${hex(pid)}`;
}

/**
 * Resolve the board to auto-select for a connected device.
 * @param {number} vid - USB vendor id of the connected port
 * @param {number} pid - USB product id of the connected port
 * @param {object[]} catalog - boards.json entries (with tier field)
 * @param {Map<string, string>} [learnedMap] - devicePairKey -> FQBN learned
 *   from successful uploads
 * @returns {{fqbn: string, name: string|null, source: string}|null} The
 *   resolved board and which stage matched ("learned", "tier1", "tier2"),
 *   or null when nothing matches
 */
export function resolveBoardForDevice(vid, pid, catalog, learnedMap) {
  if (!vid || !pid) return null;

  // 1. Learned mapping always wins
  const learnedFqbn = learnedMap?.get(devicePairKey(vid, pid));
  if (learnedFqbn) {
    const entry = catalog.find((b) => b.fqbn === learnedFqbn);
    return { fqbn: learnedFqbn, name: entry?.name || null, source: "learned" };
  }

  // 2. Tier 1, then 3. tier 2. Tier 3 is never auto-selected.
  for (const tier of [1, 2]) {
    const match = catalog.find(
      (b) => b.tier === tier && boardListsPair(b, vid, pid),
    );
    if (match) {
      return { fqbn: match.fqbn, name: match.name, source: `tier${tier}` };
    }
  }

  return null;
}

/**
 * Decide whether selecting `selectedFqbn` for the connected device warrants
 * a mismatch warning. Policy: warn ONLY when the device positively
 * identifies as a DIFFERENT tier-1 board and the selected board does not
 * list the connected pair in ANY tier (2 and 3 exist precisely to describe
 * plausible alternates for shared chips), and no learned mapping covers the
 * pair.
 * @param {number} vid - USB vendor id of the connected port
 * @param {number} pid - USB product id of the connected port
 * @param {string} selectedFqbn - FQBN the user selected
 * @param {object[]} catalog - boards.json entries (with tier field)
 * @param {Map<string, string>} [learnedMap] - learned device mappings
 * @returns {{warn: boolean, detectedName: string|null}} Warning decision and
 *   the name of the positively identified board (for the dialog)
 */
export function shouldWarnMismatch(
  vid,
  pid,
  selectedFqbn,
  catalog,
  learnedMap,
) {
  if (!vid || !pid || !selectedFqbn) return { warn: false, detectedName: null };

  // Learned pairs never warn - the user has proven this combination works
  if (learnedMap?.has(devicePairKey(vid, pid))) {
    return { warn: false, detectedName: null };
  }

  // If ANY entry for the selected FQBN (any tier) lists the pair, no warning
  const selectedEntries = catalog.filter((b) => b.fqbn === selectedFqbn);
  if (selectedEntries.some((b) => boardListsPair(b, vid, pid))) {
    return { warn: false, detectedName: null };
  }

  // Warn only when the device is positively identified as a different
  // tier-1 (official) board. Tier-2/3 chips are shared across countless
  // boards, so a non-match there proves nothing.
  const tier1Match = catalog.find(
    (b) => b.tier === 1 && boardListsPair(b, vid, pid),
  );
  if (tier1Match && tier1Match.fqbn !== selectedFqbn) {
    return { warn: true, detectedName: tier1Match.name };
  }

  return { warn: false, detectedName: null };
}
