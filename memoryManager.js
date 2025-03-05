/**
 * Memory management utilities for the SEI Voting Monitor
 */

import * as contractReader from './blockScanner.js';
import * as walletBalances from './walletBalances.js';

// Default thresholds in MB
const DEFAULT_WARNING_THRESHOLD = 1024;    // 1GB
const DEFAULT_CRITICAL_THRESHOLD = 1536;   // 1.5GB
const DEFAULT_TARGET_USAGE = 768;          // 750MB

// Memory monitoring state
let isMonitoring = false;
let monitorInterval = null;
let lastMemoryReport = Date.now();
let memoryReportInterval = 15 * 60 * 1000; // 15 minutes
let warningThreshold = DEFAULT_WARNING_THRESHOLD;
let criticalThreshold = DEFAULT_CRITICAL_THRESHOLD;
let targetUsage = DEFAULT_TARGET_USAGE;

/**
 * Get current memory usage in MB
 * @returns {Object} Memory usage statistics
 */
export function getMemoryUsage() {
    const memUsage = process.memoryUsage();
    
    return {
        rss: Math.round(memUsage.rss / 1024 / 1024),           // Resident Set Size
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // Total heap size
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),   // Used heap
        external: Math.round(memUsage.external / 1024 / 1024),   // External memory (buffers)
        arrayBuffers: Math.round((memUsage.arrayBuffers || 0) / 1024 / 1024) // Buffer allocations
    };
}

/**
 * Perform adaptive cache management based on memory pressure
 * @param {boolean} force Force cache clearing regardless of thresholds
 * @returns {Object} Action taken and current memory usage
 */
export function manageMemory(force = false) {
    const memUsage = getMemoryUsage();
    const heapUsedMB = memUsage.heapUsed;
    let action = 'none';
    
    // Generate cache statistics for logging
    const contractReaderCacheStats = contractReader.getCacheStats ? contractReader.getCacheStats() : { blockCache: { size: 'unknown' }, txCache: { size: 'unknown' } };
    const walletBalancesCacheStats = walletBalances.getCacheStats ? walletBalances.getCacheStats() : { addressCache: { size: 'unknown' }, balanceCache: { size: 'unknown' } };
    
    // Log cache statistics
    console.log('Cache statistics:');
    console.log(`  Contract reader: ${JSON.stringify(contractReaderCacheStats)}`);
    console.log(`  Wallet balances: ${JSON.stringify(walletBalancesCacheStats)}`);
    
    // Check if memory usage exceeds thresholds or force is true
    if (force || heapUsedMB > criticalThreshold) {
        // Critical threshold exceeded - aggressive clearing
        console.log(`CRITICAL MEMORY PRESSURE: ${heapUsedMB}MB used exceeds ${criticalThreshold}MB threshold. Aggressive cache clearing...`);
        
        // Clear all caches
        contractReader.clearCaches();
        walletBalances.clearCaches(true, true);
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log('Garbage collection triggered');
        }
        
        action = 'aggressive_clearing';
    } else if (heapUsedMB > warningThreshold) {
        // Warning threshold exceeded - selective clearing
        console.log(`WARNING: Memory usage (${heapUsedMB}MB) exceeds warning threshold (${warningThreshold}MB). Selective cache clearing...`);
        
        // Get cache statistics to make smart decisions about what to clear
        // Balance cache is usually the largest, so clear it first
        walletBalances.clearCaches(false, true);
        
        // Limit other caches to a reasonable size
        contractReader.limitCacheSizes(2000, 5000);
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log('Garbage collection triggered');
        }
        
        action = 'selective_clearing';
    } else if (Date.now() - lastMemoryReport > memoryReportInterval) {
        // Just log memory usage periodically
        console.log('Memory usage report:');
        console.log(`  RSS: ${memUsage.rss}MB`);
        console.log(`  Heap total: ${memUsage.heapTotal}MB`);
        console.log(`  Heap used: ${heapUsedMB}MB`);
        console.log(`  External: ${memUsage.external}MB`);
        console.log(`  Array buffers: ${memUsage.arrayBuffers}MB`);
        
        lastMemoryReport = Date.now();
        action = 'report_only';
    }
    
    // Return current status and action taken
    return {
        action,
        memoryUsage: memUsage,
        cacheStats: {
            contractReader: contractReaderCacheStats,
            walletBalances: walletBalancesCacheStats
        }
    };
}

/**
 * Start automated memory monitoring
 * @param {number} interval Check interval in milliseconds
 * @param {Object} options Configuration options
 * @returns {boolean} Whether monitoring was started
 */
export function startMemoryMonitoring(interval = 60000, options = {}) {
    if (isMonitoring) {
        console.log('Memory monitoring is already active');
        return false;
    }
    
    // Configure thresholds
    warningThreshold = options.warningThreshold || DEFAULT_WARNING_THRESHOLD;
    criticalThreshold = options.criticalThreshold || DEFAULT_CRITICAL_THRESHOLD;
    targetUsage = options.targetUsage || DEFAULT_TARGET_USAGE;
    memoryReportInterval = options.reportInterval || memoryReportInterval;
    
    console.log(`Starting memory monitoring with ${interval}ms interval`);
    console.log(`  Warning threshold: ${warningThreshold}MB`);
    console.log(`  Critical threshold: ${criticalThreshold}MB`);
    console.log(`  Target usage: ${targetUsage}MB`);
    
    // Initial memory check
    manageMemory();
    
    // Set up periodic monitoring
    monitorInterval = setInterval(() => {
        manageMemory();
    }, interval);
    
    isMonitoring = true;
    return true;
}

/**
 * Stop automated memory monitoring
 * @returns {boolean} Whether monitoring was stopped
 */
export function stopMemoryMonitoring() {
    if (!isMonitoring) {
        console.log('Memory monitoring is not active');
        return false;
    }
    
    clearInterval(monitorInterval);
    monitorInterval = null;
    isMonitoring = false;
    
    console.log('Memory monitoring stopped');
    return true;
}

/**
 * Set memory management thresholds
 * @param {Object} options Configuration options
 */
export function setMemoryThresholds(options = {}) {
    if (options.warningThreshold) {
        warningThreshold = options.warningThreshold;
    }
    
    if (options.criticalThreshold) {
        criticalThreshold = options.criticalThreshold;
    }
    
    if (options.targetUsage) {
        targetUsage = options.targetUsage;
    }
    
    if (options.reportInterval) {
        memoryReportInterval = options.reportInterval;
    }
    
    console.log('Memory management thresholds updated:');
    console.log(`  Warning threshold: ${warningThreshold}MB`);
    console.log(`  Critical threshold: ${criticalThreshold}MB`);
    console.log(`  Target usage: ${targetUsage}MB`);
}

/**
 * Reset memory management to default settings
 */
export function resetMemoryThresholds() {
    warningThreshold = DEFAULT_WARNING_THRESHOLD;
    criticalThreshold = DEFAULT_CRITICAL_THRESHOLD;
    targetUsage = DEFAULT_TARGET_USAGE;
    memoryReportInterval = 15 * 60 * 1000;
    
    console.log('Memory management thresholds reset to defaults');
}