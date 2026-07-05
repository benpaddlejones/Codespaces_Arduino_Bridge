/**
 * Intel HEX Utilities
 *
 * Shared helpers to detect and convert Intel HEX firmware images to flat
 * binary. Used by the DFU and BOSSA upload strategies (arduino-cli emits
 * .hex for some cores while the bootloaders expect raw binary).
 *
 * @module client/services/utils/intelHex
 */

/**
 * Check whether firmware bytes are Intel HEX (starts with ':')
 * @param {Uint8Array} bytes - Firmware bytes
 * @returns {boolean}
 */
export function isIntelHex(bytes) {
  return bytes.length > 0 && bytes[0] === 0x3a;
}

/**
 * Parse an Intel HEX image into flat binary.
 * Handles record types 00 (data), 02 (extended segment), 04 (extended
 * linear) and 01 (EOF). Gaps are filled with 0xFF.
 * @param {Uint8Array} bytes - Intel HEX file content
 * @returns {{data: Uint8Array, startAddress: number}}
 */
export function parseIntelHex(bytes) {
  const lines = new TextDecoder()
    .decode(bytes)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(":"));
  if (lines.length === 0) {
    throw new Error("No valid Intel HEX records found");
  }

  let minAddress = Infinity;
  let maxAddress = 0;
  let upperAddress = 0;

  for (const line of lines) {
    const byteCount = parseInt(line.substring(1, 3), 16);
    const address = parseInt(line.substring(3, 7), 16);
    const recordType = parseInt(line.substring(7, 9), 16);

    if (recordType === 0) {
      const absolute = upperAddress + address;
      minAddress = Math.min(minAddress, absolute);
      maxAddress = Math.max(maxAddress, absolute + byteCount);
    } else if (recordType === 2) {
      upperAddress = parseInt(line.substring(9, 13), 16) << 4;
    } else if (recordType === 4) {
      upperAddress = parseInt(line.substring(9, 13), 16) << 16;
    }
  }

  if (minAddress === Infinity) {
    throw new Error("No data records found in Intel HEX file");
  }

  const size = maxAddress - minAddress;
  const data = new Uint8Array(size);
  data.fill(0xff);
  upperAddress = 0;

  for (const line of lines) {
    const byteCount = parseInt(line.substring(1, 3), 16);
    const address = parseInt(line.substring(3, 7), 16);
    const recordType = parseInt(line.substring(7, 9), 16);

    if (recordType === 0) {
      const offset = upperAddress + address - minAddress;
      for (let i = 0; i < byteCount; i++) {
        data[offset + i] = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
      }
    } else if (recordType === 2) {
      upperAddress = parseInt(line.substring(9, 13), 16) << 4;
    } else if (recordType === 4) {
      upperAddress = parseInt(line.substring(9, 13), 16) << 16;
    } else if (recordType === 1) {
      break;
    }
  }

  return { data, startAddress: minAddress };
}
