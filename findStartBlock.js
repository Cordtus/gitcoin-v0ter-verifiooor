// contractReader.js

import { ethers } from 'ethers';
import axios from 'axios';
import { retry, sleep } from './utils.js';

// Cache for block time lookups to minimize redundant API calls
const blockTimeCache = new Map();

/**
 * Find the exact block number for a target date in UTC with optimized skipping
 * @param {Date} targetDate The target date to find the block for (should be in UTC)
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Block number
 */
export async function findStartBlock(targetDate, primaryRpc, fallbackRpc) {
    // Ensure target date is in UTC
    const targetUTC = new Date(targetDate.toISOString());
    console.log(`Finding exact block for date (UTC): ${targetUTC.toISOString()}`);
    
    // Get current block using EVM RPC
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    const currentBlockNumber = await provider.getBlockNumber();
    console.log(`Current EVM block: ${currentBlockNumber}`);
    
    // Get current block timestamp
    const currentBlockData = await getBlock(currentBlockNumber, provider);
    const currentBlockTime = new Date(Number(currentBlockData.timestamp) * 1000);
    
    console.log(`Current block time: ${currentBlockTime.toISOString()}`);
    
    // Calculate time difference and estimate blocks
    const timeDiffMs = targetUTC.getTime() - currentBlockTime.getTime();
    const BLOCK_TIME_MS = 400; // SEI average block time in milliseconds
    const estimatedBlockDiff = Math.floor(timeDiffMs / BLOCK_TIME_MS);
    const estimatedBlock = Math.max(0, currentBlockNumber + estimatedBlockDiff);
    
    console.log(`Initial block estimate: ${estimatedBlock} (${estimatedBlockDiff} blocks from current)`);
    
    // If the estimated block is in the future, use current block
    if (estimatedBlock > currentBlockNumber) {
        console.log(`Estimated block is in the future, using current block`);
        return currentBlockNumber;
    }
    
    // Adaptive search range based on the time difference magnitude
    // Larger time differences get larger search ranges
    const timeDistanceHours = Math.abs(timeDiffMs) / (1000 * 60 * 60);
    const searchRangeBlocks = Math.min(
        50000, // Cap at 50,000 blocks
        Math.max(
            5000,  // Minimum of 5,000 blocks
            Math.ceil(timeDistanceHours * 9000) // ~9,000 blocks per hour
        )
    );
    
    // Set up binary search bounds with the adaptive range
    let lowerBound = Math.max(0, estimatedBlock - searchRangeBlocks);
    let upperBound = Math.min(currentBlockNumber, estimatedBlock + searchRangeBlocks);
    
    console.log(`Setting search range: ${lowerBound} to ${upperBound} (${upperBound - lowerBound} blocks)`);
    
    // Optimized binary search with adaptive step sizes
    let closestBlock = estimatedBlock;
    let closestDiff = Infinity;
    let iterations = 0;
    const MAX_ITERATIONS = 20; // Prevent infinite loops
    
    while (lowerBound <= upperBound && iterations < MAX_ITERATIONS) {
        iterations++;
        
        // Calculate midpoint
        const midBlock = Math.floor((lowerBound + upperBound) / 2);
        
        // Get block time
        const blockData = await getBlock(midBlock, provider);
        const blockTime = new Date(Number(blockData.timestamp) * 1000);
        
        console.log(`[Iteration ${iterations}] Checking block ${midBlock}, time: ${blockTime.toISOString()}`);
        
        // Calculate time difference
        const diffMs = Math.abs(blockTime.getTime() - targetUTC.getTime());
        
        // Keep track of closest block
        if (diffMs < closestDiff) {
            closestBlock = midBlock;
            closestDiff = diffMs;
        }
        
        // Exit early if we're within 1 second of the target
        if (diffMs < 1000) {
            console.log(`Found very close block: ${midBlock} (within 1 second)`);
            return refineExactBlock(midBlock, targetUTC, provider);
        }
        
        // Adjust bounds for next iteration
        if (blockTime.getTime() < targetUTC.getTime()) {
            lowerBound = midBlock + 1;
        } else {
            upperBound = midBlock - 1;
        }
        
        // Adaptive skipping for faster convergence
        // As we get closer to the target, we reduce the skip size
        if (diffMs > 3600000) { // More than 1 hour away
            // Skip by larger chunks (e.g., 9000 blocks ~= 1 hour)
            const skipSize = Math.ceil(diffMs / 400);
            if (blockTime.getTime() < targetUTC.getTime()) {
                lowerBound = midBlock + Math.ceil(skipSize / 3);
            } else {
                upperBound = midBlock - Math.ceil(skipSize / 3);
            }
        }
    }
    
    // If we couldn't find a block within 1 second, use the closest we found
    console.log(`Using closest block after ${iterations} iterations: ${closestBlock} (off by ${closestDiff}ms)`);
    
    // Final refinement
    return refineExactBlock(closestBlock, targetUTC, provider);
}

/**
 * Find the exact block at or just after the target date
 * @param {number} approximateBlock Approximate block near the target time
 * @param {Date} targetDate Target date in UTC
 * @param {ethers.Provider} provider Ethers provider
 * @returns {Promise<number>} Exact block number
 */
async function refineExactBlock(approximateBlock, targetDate, provider) {
    console.log(`Refining exact block around ${approximateBlock}...`);
    
    let searchBlock = approximateBlock;
    let blockData = await getBlock(searchBlock, provider);
    let blockTime = new Date(Number(blockData.timestamp) * 1000);
    
    // If before target date, move forward to find first block after target
    if (blockTime.getTime() < targetDate.getTime()) {
        console.log('Block is before target date, moving forward...');
        
        let previousBlock = searchBlock;
        let previousTime = blockTime;
        let consecutiveBlocksMoved = 0;
        
        while (blockTime.getTime() < targetDate.getTime()) {
            previousBlock = searchBlock;
            previousTime = blockTime;
            
            // Adaptive skip size based on how far we are from target
            const timeGap = targetDate.getTime() - blockTime.getTime();
            const blocksToSkip = Math.max(1, Math.min(100, Math.ceil(timeGap / 400)));
            
            searchBlock += blocksToSkip;
            consecutiveBlocksMoved += blocksToSkip;
            
            // Safety check - break if we've moved too many blocks
            if (consecutiveBlocksMoved > 1000) {
                console.log(`Safety limit reached after moving ${consecutiveBlocksMoved} blocks forward`);
                break;
            }
            
            blockData = await getBlock(searchBlock, provider);
            blockTime = new Date(Number(blockData.timestamp) * 1000);
            console.log(`Testing forward block ${searchBlock}: ${blockTime.toISOString()}`);
        }
        
        // Binary search between previous and current block for exact transition
        if (previousBlock < searchBlock - 1) {
            console.log(`Narrowing between blocks ${previousBlock} and ${searchBlock}`);
            let lower = previousBlock;
            let upper = searchBlock;
            
            while (lower < upper - 1) {
                const mid = Math.floor((lower + upper) / 2);
                const midData = await getBlock(mid, provider);
                const midTime = new Date(Number(midData.timestamp) * 1000);
                
                if (midTime.getTime() < targetDate.getTime()) {
                    lower = mid;
                } else {
                    upper = mid;
                }
            }
            
            searchBlock = upper;
            blockData = await getBlock(searchBlock, provider);
            blockTime = new Date(Number(blockData.timestamp) * 1000);
        }
        
        console.log(`Found first block after target: ${searchBlock} at ${blockTime.toISOString()}`);
        return searchBlock;
    } 
    // If after target date, move backward to find last block before target
    else {
        console.log('Block is after target date, moving backward...');
        
        let nextBlock = searchBlock;
        let nextTime = blockTime;
        let consecutiveBlocksMoved = 0;
        
        while (blockTime.getTime() >= targetDate.getTime() && searchBlock > 0) {
            nextBlock = searchBlock;
            nextTime = blockTime;
            
            // Adaptive skip size based on how far we are from target
            const timeGap = blockTime.getTime() - targetDate.getTime();
            const blocksToSkip = Math.max(1, Math.min(100, Math.ceil(timeGap / 400)));
            
            searchBlock -= blocksToSkip;
            consecutiveBlocksMoved += blocksToSkip;
            
            // Safety check - break if we've moved too many blocks
            if (consecutiveBlocksMoved > 1000) {
                console.log(`Safety limit reached after moving ${consecutiveBlocksMoved} blocks backward`);
                break;
            }
            
            blockData = await getBlock(searchBlock, provider);
            blockTime = new Date(Number(blockData.timestamp) * 1000);
            console.log(`Testing backward block ${searchBlock}: ${blockTime.toISOString()}`);
        }
        
        // Binary search between current and next block for exact transition
        if (searchBlock < nextBlock - 1) {
            console.log(`Narrowing between blocks ${searchBlock} and ${nextBlock}`);
            let lower = searchBlock;
            let upper = nextBlock;
            
            while (lower < upper - 1) {
                const mid = Math.floor((lower + upper) / 2);
                const midData = await getBlock(mid, provider);
                const midTime = new Date(Number(midData.timestamp) * 1000);
                
                if (midTime.getTime() < targetDate.getTime()) {
                    lower = mid;
                } else {
                    upper = mid;
                }
            }
            
            searchBlock = lower;
            nextBlock = upper;
        }
        
        // Return the block right after the last block before target
        console.log(`Found transition between blocks ${searchBlock} and ${nextBlock}`);
        return nextBlock;
    }
}

/**
 * Get block data with caching
 * @param {number} blockNumber Block number to get
 * @param {ethers.Provider} provider Ethers provider
 * @returns {Promise<Object>} Block data
 */
async function getBlock(blockNumber, provider) {
    // Check cache first
    if (blockTimeCache.has(blockNumber)) {
        return blockTimeCache.get(blockNumber);
    }
    
    try {
        // Set a timeout for the request
        const blockPromise = provider.getBlock(blockNumber);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNumber}`)), 10000);
        });
        
        const block = await Promise.race([blockPromise, timeoutPromise]);
        
        if (!block) {
            throw new Error(`Block ${blockNumber} not found`);
        }
        
        // Cache the result
        blockTimeCache.set(blockNumber, block);
        
        // Limit cache size to prevent memory issues
        if (blockTimeCache.size > 1000) {
            const oldestKey = blockTimeCache.keys().next().value;
            blockTimeCache.delete(oldestKey);
        }
        
        return block;
    } catch (error) {
        console.error(`Error getting block ${blockNumber}:`, error.message);
        throw error;
    }
}

/**
 * Check availability of a block on the given RPC
 * @param {number} blockNumber Block to check 
 * @param {string} rpcUrl RPC URL
 * @param {number} timeout Timeout in milliseconds
 * @returns {Promise<boolean>} Whether the block is available
 */
export async function checkBlockAvailability(blockNumber, rpcUrl, timeout = 5000) {
    return await retry(async () => {
        try {
            console.log(`Checking if block ${blockNumber} is available on ${rpcUrl}...`);
            
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            
            // Set timeout for block check
            const blockPromise = provider.getBlock(blockNumber);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Block availability check timed out')), timeout);
            });
            
            const block = await Promise.race([blockPromise, timeoutPromise]);
            
            if (block) {
                console.log(`Block ${blockNumber} is available on ${rpcUrl}`);
                return true;
            } else {
                console.log(`Block ${blockNumber} not found on ${rpcUrl}`);
                return false;
            }
        } catch (error) {
            console.error(`Error checking block availability: ${error.message}`);
            return false;
        }
    }, 3, 1000); // Retry up to 3 times with 1s initial delay
}

/**
 * Estimate the current block number for a future time
 * @param {Date} futureDate Future date to estimate block for
 * @param {string} primaryRpc Primary RPC endpoint 
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Estimated block number
 */
export async function estimateFutureBlock(futureDate, primaryRpc, fallbackRpc) {
    // Get current block and time
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    const currentBlockNumber = await provider.getBlockNumber();
    const currentBlockData = await getBlock(currentBlockNumber, provider);
    const currentTime = new Date(Number(currentBlockData.timestamp) * 1000);
    
    // Calculate time difference and estimate blocks
    const timeDiffMs = futureDate.getTime() - currentTime.getTime();
    if (timeDiffMs <= 0) {
        console.log(`Requested date is not in the future, returning current block`);
        return currentBlockNumber;
    }
    
    const BLOCK_TIME_MS = 400; // SEI average block time in milliseconds
    const estimatedBlockDiff = Math.floor(timeDiffMs / BLOCK_TIME_MS);
    const estimatedBlock = currentBlockNumber + estimatedBlockDiff;
    
    console.log(`Current block: ${currentBlockNumber}, time: ${currentTime.toISOString()}`);
    console.log(`Estimated block for ${futureDate.toISOString()}: ${estimatedBlock}`);
    console.log(`Approximately ${estimatedBlockDiff} blocks from now`);
    
    return estimatedBlock;
}

/**
 * Clear the block time cache
 */
export function clearBlockTimeCache() {
    const cacheSize = blockTimeCache.size;
    blockTimeCache.clear();
    console.log(`Cleared block time cache (${cacheSize} entries)`);
}