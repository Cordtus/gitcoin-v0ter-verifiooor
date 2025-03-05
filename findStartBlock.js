// contractReader.js

import { ethers } from 'ethers';

/**
 * Find the exact block number for a target date
 * @param {Date} targetDate The target date to find the block for
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Block number
 */
export async function findStartBlock(targetDate, primaryRpc, fallbackRpc) {
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    try {
        console.log(`Finding exact block for date: ${targetDate.toISOString()}`);
        
        // Get current block and its timestamp
        const currentBlock = await provider.getBlockNumber();
        const currentBlockData = await provider.getBlock(currentBlock);
        const currentTimestamp = new Date(Number(currentBlockData.timestamp) * 1000);
        
        console.log(`Current block: ${currentBlock}, timestamp: ${currentTimestamp.toISOString()}`);
        
        // Calculate an approximate block based on SEI's 400ms block time
        const timeDiff = targetDate.getTime() - currentTimestamp.getTime();
        const BLOCK_TIME_MS = 400;
        const blockDiff = Math.floor(timeDiff / BLOCK_TIME_MS);
        
        let estimatedBlock = Math.max(0, currentBlock + blockDiff);
        console.log(`Initial block estimate: ${estimatedBlock}`);
        
        // Binary search to find the exact block
        let lowerBound = Math.max(0, estimatedBlock - 5000); // Search 5000 blocks below estimate
        let upperBound = estimatedBlock + 5000; // Search 5000 blocks above estimate
        
        while (lowerBound <= upperBound) {
            const midBlock = Math.floor((lowerBound + upperBound) / 2);
            const blockData = await provider.getBlock(midBlock);
            const blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
            
            console.log(`Checking block ${midBlock}, timestamp: ${blockTimestamp.toISOString()}`);
            
            // If we're within 1 minute of the target, consider it found
            const diffMs = Math.abs(blockTimestamp.getTime() - targetDate.getTime());
            if (diffMs < 60000) {
                console.log(`Found closest block: ${midBlock}`);
                
                // Refine further to get exact block
                return findExactBlockNearTarget(provider, midBlock, targetDate);
            }
            
            if (blockTimestamp.getTime() < targetDate.getTime()) {
                lowerBound = midBlock + 1;
            } else {
                upperBound = midBlock - 1;
            }
        }
        
        // If we exit the loop without finding, return our best estimate
        return estimatedBlock;
    } catch (error) {
        console.error('Error finding start block:', error.message);
        throw error;
    }
}

/**
 * Find the exact block at or just after the target date
 * @param {ethers.Provider} provider Ethers provider
 * @param {number} approximateBlock Approximate block near the target time
 * @param {Date} targetDate Target date
 * @returns {Promise<number>} Exact block number
 */
async function findExactBlockNearTarget(provider, approximateBlock, targetDate) {
    let currentBlock = approximateBlock;
    let blockData = await provider.getBlock(currentBlock);
    let blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
    
    // If before target date, move forward to find first block after target
    if (blockTimestamp.getTime() < targetDate.getTime()) {
        while (blockTimestamp.getTime() < targetDate.getTime()) {
            currentBlock++;
            blockData = await provider.getBlock(currentBlock);
            blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
        }
        return currentBlock;
    } 
    // If after target date, move backward to find last block before target
    else {
        while (blockTimestamp.getTime() >= targetDate.getTime() && currentBlock > 0) {
            currentBlock--;
            blockData = await provider.getBlock(currentBlock);
            blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
        }
        // Return the block right after the last block before target
        return currentBlock + 1;
    }
}