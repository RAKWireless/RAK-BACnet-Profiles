/**
 * Hexadecimal Conversion Tools
 */

/**
 * Convert hexadecimal string to byte array
 * @param {string} hexString - Hexadecimal string, e.g. "040164" or "04 01 64"
 * @returns {number[]} Byte array, e.g. [4, 1, 100]
 */
function hexToBytes(hexString) {
  // Remove all spaces and hyphens
  const cleaned = hexString.replace(/[\s-]/g, '');
  
  // Validate if it's a valid hexadecimal string
  if (!/^[0-9A-Fa-f]*$/.test(cleaned)) {
    throw new Error(`Invalid hex string: ${hexString}`);
  }
  
  // Ensure length is even
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Hex string length must be even: ${hexString}`);
  }
  
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.substr(i, 2), 16));
  }
  
  return bytes;
}

/**
 * Convert byte array to hexadecimal string
 * @param {number[]|Uint8Array} bytes - Byte array
 * @param {string} separator - Separator (default is space)
 * @returns {string} Hexadecimal string
 */
function bytesToHex(bytes, separator = ' ') {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(separator);
}

/**
 * Format hexadecimal string (add space separation)
 * @param {string} hexString - Hexadecimal string
 * @returns {string} Formatted string
 */
function formatHex(hexString) {
  const cleaned = hexString.replace(/[\s-]/g, '');
  return cleaned.match(/.{1,2}/g).join(' ');
}

module.exports = {
  hexToBytes,
  bytesToHex,
  formatHex
};
