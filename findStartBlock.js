// contractReader.js

import { ethers } from 'ethers';
import axios from 'axios';

/**
 * Find the exact block number for a target date in UTC
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
    
    // Get cosmos RPC by modifying the EVM RPC URL
    const cosmosRpc = primaryRpc.replace('evm-rpc', 'rpc');
    const fallbackCosmosRpc = fallbackRpc.replace('evm', 'rpc');
    
    // Use the Cosmos RPC to get the block time for accuracy
    try {
        // Get current block time
        const currentBlockTime = await getBlockTimeFromCosmosRPC(cosmosRpc, currentBlockNumber);
        console.log(`Current block time: ${currentBlockTime.toISOString()}`);
        
        // Calculate approximate block based on SEI's average block time
        const timeDiffMs = targetUTC.getTime() - currentBlockTime.getTime();
        const BLOCK_TIME_MS = 400; // SEI average block time in milliseconds
        const blockDiff = Math.floor(timeDiffMs / BLOCK_TIME_MS);
        
        let estimatedBlock = Math.max(0, currentBlockNumber + blockDiff);
        console.log(`Initial block estimate: ${estimatedBlock}`);
        
        // Binary search to find the exact block
        let lowerBound = Math.max(0, estimatedBlock - 5000); // Search 5000 blocks below estimate
        let upperBound = estimatedBlock + 5000; // Search 5000 blocks above estimate
        
        let closestBlock = estimatedBlock;
        let closestDiff = Infinity;
        
        console.log(`Starting binary search between blocks ${lowerBound} and ${upperBound}...`);
        
        while (lowerBound <= upperBound) {
            const midBlock = Math.floor((lowerBound + upperBound) / 2);
            const blockTime = await getBlockTimeFromCosmosRPC(cosmosRpc, midBlock);
            
            console.log(`Checking block ${midBlock}, time: ${blockTime.toISOString()}`);
            
            const diffMs = Math.abs(blockTime.getTime() - targetUTC.getTime());
            
            // Keep track of the closest block we've found
            if (diffMs < closestDiff) {
                closestBlock = midBlock;
                closestDiff = diffMs;
            }
            
            // If we're within 1 second of the target, consider it found
            if (diffMs < 1000) {
                console.log(`Found very close block: ${midBlock}`);
                return midBlock;
            }
            
            if (blockTime.getTime() < targetUTC.getTime()) {
                lowerBound = midBlock + 1;
            } else {
                upperBound = midBlock - 1;
            }
        }
        
        // If we couldn't find a block within 1 second, use the closest we found
        console.log(`Using closest block: ${closestBlock} (off by ${closestDiff}ms)`);
        
        // Final refinement - find exact block at or just after target
        return findExactBlockNearTarget(cosmosRpc, closestBlock, targetUTC);
    } catch (error) {
        console.error('Error finding start block with Cosmos RPC:', error.message);
        console.log('Falling back to EVM-based approach...');
        
        try {
            // Fall back to EVM-based approach
            return findStartBlockWithEVM(provider, targetUTC);
        } catch (evmError) {
            console.error('Error in EVM fallback method:', evmError.message);
            throw evmError;
        }
    }
}

/**
 * Find the exact block at or just after the target date
 * @param {string} cosmosRpc Cosmos RPC endpoint
 * @param {number} approximateBlock Approximate block near the target time
 * @param {Date} targetDate Target date in UTC
 * @returns {Promise<number>} Exact block number
 */
async function findExactBlockNearTarget(cosmosRpc, approximateBlock, targetDate) {
    let searchBlock = approximateBlock;
    let blockTime = await getBlockTimeFromCosmosRPC(cosmosRpc, searchBlock);
    
    // If before target date, move forward to find first block after target
    if (blockTime.getTime() < targetDate.getTime()) {
        console.log('Block is before target date, moving forward...');
        
        while (blockTime.getTime() < targetDate.getTime()) {
            searchBlock++;
            blockTime = await getBlockTimeFromCosmosRPC(cosmosRpc, searchBlock);
            console.log(`Testing block ${searchBlock}: ${blockTime.toISOString()}`);
        }
        console.log(`Found first block after target: ${searchBlock}`);
        return searchBlock;
    } 
    // If after target date, move backward to find last block before target
    else {
        console.log('Block is after target date, moving backward...');
        
        while (blockTime.getTime() >= targetDate.getTime() && searchBlock > 0) {
            searchBlock--;
            blockTime = await getBlockTimeFromCosmosRPC(cosmosRpc, searchBlock);
            console.log(`Testing block ${searchBlock}: ${blockTime.toISOString()}`);
        }
        // Return the block right after the last block before target
        console.log(`Found first block after target: ${searchBlock + 1}`);
        return searchBlock + 1;
    }
}

/**
 * Get block time from Cosmos RPC for a specific block
 * @param {string} cosmosRpc Cosmos RPC endpoint
 * @param {number} blockHeight Block height
 * @returns {Promise<Date>} Block time as Date object
 */
async function getBlockTimeFromCosmosRPC(cosmosRpc, blockHeight) {
    try {
        const response = await axios.get(`${cosmosRpc}/block?height=${blockHeight}`);
        
        if (response.data && response.data.block && response.data.block.header && response.data.block.header.time) {
            return new Date(response.data.block.header.time);
        }
        
        throw new Error(`Invalid response format from Cosmos RPC for block ${blockHeight}`);
    } catch (error) {
        console.error(`Error getting block time for height ${blockHeight}:`, error.message);
        throw error;
    }
}

/**
 * Fallback method to find start block using EVM provider
 * @param {ethers.Provider} provider Ethers provider
 * @param {Date} targetUTC Target date in UTC
 * @returns {Promise<number>} Block number
 */
async function findStartBlockWithEVM(provider, targetUTC) {
    console.log('Using EVM method for block search');
    
    // Get current block and its timestamp
    const currentBlock = await provider.getBlockNumber();
    const currentBlockData = await provider.getBlock(currentBlock);
    const currentTimestamp = new Date(Number(currentBlockData.timestamp) * 1000);
    
    console.log(`Current block: ${currentBlock}, timestamp: ${currentTimestamp.toISOString()}`);
    
    // Calculate an approximate block based on SEI's 400ms block time
    const timeDiff = targetUTC.getTime() - currentTimestamp.getTime();
    const BLOCK_TIME_MS = 400;
    const blockDiff = Math.floor(timeDiff / BLOCK_TIME_MS);
    
    let estimatedBlock = Math.max(0, currentBlock + blockDiff);
    console.log(`Initial block estimate: ${estimatedBlock}`);
    
    // Binary search to find the exact block
    let lowerBound = Math.max(0, estimatedBlock - 5000);
    let upperBound = estimatedBlock + 5000;
    
    let closestBlock = estimatedBlock;
    let closestDiff = Infinity;
    
    while (lowerBound <= upperBound) {
        const midBlock = Math.floor((lowerBound + upperBound) / 2);
        const blockData = await provider.getBlock(midBlock);
        const blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
        
        console.log(`Checking block ${midBlock}, timestamp: ${blockTimestamp.toISOString()}`);
        
        const diffMs = Math.abs(blockTimestamp.getTime() - targetUTC.getTime());
        
        // Keep track of the closest block we've found
        if (diffMs < closestDiff) {
            closestBlock = midBlock;
            closestDiff = diffMs;
        }
        
        // If we're within 1 second of the target, consider it found
        if (diffMs < 1000) {
            console.log(`Found very close block: ${midBlock}`);
            return midBlock;
        }
        
        if (blockTimestamp.getTime() < targetUTC.getTime()) {
            lowerBound = midBlock + 1;
        } else {
            upperBound = midBlock - 1;
        }
    }
    
    // If we couldn't find a block within 1 second, use the closest we found
    console.log(`Using closest block: ${closestBlock} (off by ${closestDiff}ms)`);
    
    // Final refinement with EVM provider
    let refinedBlock = closestBlock;
    let blockData = await provider.getBlock(refinedBlock);
    let blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
    
    if (blockTimestamp.getTime() < targetUTC.getTime()) {
        // Move forward to find first block after target
        while (blockTimestamp.getTime() < targetUTC.getTime()) {
            refinedBlock++;
            blockData = await provider.getBlock(refinedBlock);
            blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
        }
        return refinedBlock;
    } else {
        // Move backward to find last block before target
        while (blockTimestamp.getTime() >= targetUTC.getTime() && refinedBlock > 0) {
            refinedBlock--;
            blockData = await provider.getBlock(refinedBlock);
            blockTimestamp = new Date(Number(blockData.timestamp) * 1000);
        }
        // Return the block right after the last block before target
        return refinedBlock + 1;
    }
}

/**
 * Helper function to convert decimal to hex
 * @param {number} decimalNumber Decimal number
 * @returns {string} Hex string with 0x prefix
 */
function decimalToHex(decimalNumber) {
  // Convert decimal to hexadecimal
  const hexValue = parseInt(decimalNumber).toString(16);
  return `0x${hexValue}`;
}

/**
 * Helper function to convert hex to decimal
 * @param {string} hexString Hex string (with or without 0x prefix)
 * @returns {number} Decimal number
 */
function hexToDecimal(hexString) {
  // Remove 0x prefix if present
  const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
  return parseInt(cleanHex, 16);
}