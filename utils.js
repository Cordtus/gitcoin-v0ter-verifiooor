/**
 * Utility functions for SEI Voting Monitor
 */

/**
 * Convert decimal number to hex string
 * @param {number} decimalNumber Decimal number to convert
 * @returns {string} Hex string with '0x' prefix
 */
export function decimalToHex(decimalNumber) {
  if (isNaN(decimalNumber)) {
    throw new Error("Please provide a valid decimal number.");
  }
  
  // Convert decimal to hexadecimal
  const hexValue = parseInt(decimalNumber).toString(16);
  return `0x${hexValue}`;
}

/**
 * Convert hex string to decimal number
 * @param {string} hexString Hex string (with or without '0x' prefix)
 * @returns {number} Decimal number
 */
export function hexToDecimal(hexString) {
  if (typeof hexString !== 'string' || hexString.trim() === '') {
    throw new Error("Please provide a valid hexadecimal string.");
  }
  
  // Remove '0x' prefix if present
  const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
  
  // Convert the hex string to decimal
  const decimalValue = parseInt(cleanHex, 16);
  
  if (isNaN(decimalValue)) {
    throw new Error("Invalid hexadecimal string. Could not convert to decimal.");
  }
  
  return decimalValue;
}

/**
 * Format a date object to UTC ISO string
 * @param {Date} date Date object
 * @returns {string} Formatted UTC ISO string
 */
export function formatDateUTC(date) {
  return date.toISOString();
}

/**
 * Format SEI balance to standard 6 decimal places
 * @param {number} amount Amount in SEI
 * @returns {number} Formatted amount with 6 decimal places
 */
export function formatSeiBalance(amount) {
  return Number(amount.toFixed(6));
}

/**
 * Convert wei (asei) to SEI with proper decimal places
 * @param {string|number|BigInt} weiAmount Amount in wei/asei (10^18)
 * @returns {number} Amount in SEI with 6 decimal places
 */
export function weiToSei(weiAmount) {
  // Handle different input types
  let amount;
  if (typeof weiAmount === 'bigint') {
    amount = Number(weiAmount) / 1e18;
  } else if (typeof weiAmount === 'string') {
    amount = Number(weiAmount) / 1e18;
  } else {
    amount = weiAmount / 1e18;
  }
  
  // Format to 6 decimal places
  return Number(amount.toFixed(6));
}

/**
 * Convert usei to SEI
 * @param {string|number} useiAmount Amount in usei (10^6)
 * @returns {number} Amount in SEI with 6 decimal places
 */
export function useiToSei(useiAmount) {
  // Handle string input
  const amount = typeof useiAmount === 'string' ? Number(useiAmount) : useiAmount;
  
  // Format to 6 decimal places
  return Number((amount / 1e6).toFixed(6));
}

/**
 * Convert SEI to usei
 * @param {number} seiAmount Amount in SEI
 * @returns {number} Amount in usei (integer)
 */
export function seiToUsei(seiAmount) {
  return Math.floor(seiAmount * 1e6);
}

/**
 * Sleep for the specified time
 * @param {number} ms Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after the specified time
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn Function to retry
 * @param {number} maxRetries Maximum number of retries
 * @param {number} initialDelay Initial delay in milliseconds
 * @returns {Promise<any>} Promise that resolves with the function result
 */
export async function retry(fn, maxRetries = 5, initialDelay = 1000) {
  let retries = 0;
  let delay = initialDelay;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries > maxRetries) {
        throw error;
      }
      
      console.log(`Retry ${retries}/${maxRetries} after ${delay}ms delay...`);
      await sleep(delay);
      
      // Exponential backoff with jitter
      delay = delay * 2 * (0.8 + Math.random() * 0.4);
    }
  }
}