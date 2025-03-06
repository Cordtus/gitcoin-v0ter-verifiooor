/**
 * Unified caching system for SEI Voting Monitor
 */

// Cache implementation with TTL and hit tracking
export class Cache {
  constructor(name, maxSize = 5000, ttlMs = 30 * 60 * 1000) {
    this.name = name;
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.timestamps = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    
    const timestamp = this.timestamps.get(key);
    if (Date.now() - timestamp > this.ttlMs) {
      // Expired entry
      this.cache.delete(key);
      this.timestamps.delete(key);
      return false;
    }
    
    return true;
  }

  get(key) {
    if (!this.has(key)) {
      this.misses++;
      return null;
    }
    
    this.hits++;
    return this.cache.get(key);
  }

  set(key, value) {
    // Check if we need to evict entries
    if (this.cache.size >= this.maxSize) {
      // Find oldest entries
      const entries = [...this.timestamps.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, Math.ceil(this.maxSize * 0.2)); // Remove 20% oldest
      
      for (const [entryKey] of entries) {
        this.cache.delete(entryKey);
        this.timestamps.delete(entryKey);
      }
    }
    
    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());
  }
  
  clear() {
    this.cache.clear();
    this.timestamps.clear();
  }
  
  size() {
    return this.cache.size;
  }
  
  limitSize(newMax) {
    if (this.cache.size <= newMax) return;
    
    // Remove oldest entries to meet new max size
    const entries = [...this.timestamps.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.cache.size - newMax);
    
    for (const [key] of entries) {
      this.cache.delete(key);
      this.timestamps.delete(key);
    }
    
    this.maxSize = newMax;
  }
  
  getStats() {
    return {
      name: this.name,
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits / (this.hits + this.misses || 1)
    };
  }
}

// Create and export common caches
export const blockCache = new Cache('blocks', 2000);
export const txCache = new Cache('transactions', 5000);
export const receiptCache = new Cache('receipts', 5000);
export const addressCache = new Cache('addresses', 2000);
export const reverseAddressCache = new Cache('reverseAddresses', 2000);
export const balanceCache = new Cache('balances', 10000);

/**
 * Clear all caches or specific caches based on parameters
 * @param {Object} options Options for clearing caches
 */
export function clearCaches(options = {}) {
  const {
    blocks = true,
    transactions = true,
    receipts = true,
    addresses = false,
    reverseAddresses = false,
    balances = true
  } = options;

  let clearedCount = 0;
  
  if (blocks) {
    console.log(`Clearing block cache (${blockCache.size()} entries)`);
    blockCache.clear();
    clearedCount++;
  }
  
  if (transactions) {
    console.log(`Clearing transaction cache (${txCache.size()} entries)`);
    txCache.clear();
    clearedCount++;
  }
  
  if (receipts) {
    console.log(`Clearing receipt cache (${receiptCache.size()} entries)`);
    receiptCache.clear();
    clearedCount++;
  }
  
  if (addresses) {
    console.log(`Clearing address cache (${addressCache.size()} entries)`);
    addressCache.clear();
    clearedCount++;
  }
  
  if (reverseAddresses) {
    console.log(`Clearing reverse address cache (${reverseAddressCache.size()} entries)`);
    reverseAddressCache.clear();
    clearedCount++;
  }
  
  if (balances) {
    console.log(`Clearing balance cache (${balanceCache.size()} entries)`);
    balanceCache.clear();
    clearedCount++;
  }
  
  console.log(`Cleared ${clearedCount} caches`);
}

/**
 * Limit the size of caches
 * @param {number} maxBlocks Maximum block cache size
 * @param {number} maxTxs Maximum transaction cache size
 * @param {number} maxReceipts Maximum receipt cache size
 * @param {number} maxAddresses Maximum address cache size
 * @param {number} maxBalances Maximum balance cache size
 */
export function limitCacheSizes(
  maxBlocks = 2000,
  maxTxs = 5000,
  maxReceipts = 5000,
  maxAddresses = 2000,
  maxBalances = 10000
) {
  blockCache.limitSize(maxBlocks);
  txCache.limitSize(maxTxs);
  receiptCache.limitSize(maxReceipts);
  addressCache.limitSize(maxAddresses);
  balanceCache.limitSize(maxBalances);
  
  console.log('Cache sizes limited to:');
  console.log(`  Blocks: ${maxBlocks}`);
  console.log(`  Transactions: ${maxTxs}`);
  console.log(`  Receipts: ${maxReceipts}`);
  console.log(`  Addresses: ${maxAddresses}`);
  console.log(`  Balances: ${maxBalances}`);
}

/**
 * Get statistics for all caches
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
  return {
    blocks: blockCache.getStats(),
    transactions: txCache.getStats(),
    receipts: receiptCache.getStats(),
    addresses: addressCache.getStats(),
    reverseAddresses: reverseAddressCache.getStats(),
    balances: balanceCache.getStats(),
    totalEntries: 
      blockCache.size() + 
      txCache.size() + 
      receiptCache.size() + 
      addressCache.size() + 
      reverseAddressCache.size() + 
      balanceCache.size()
  };
}