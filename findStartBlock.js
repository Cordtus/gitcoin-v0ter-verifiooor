// findStartBlock.js
// Efficiently finds the start block for the SEI voting period

import { ethers } from 'ethers';
import { retry, sleep, decimalToHex } from './utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simplified LRU Cache using Map
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
  }
  
  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

const blockTimeCache = new LRUCache(1000);

// Voting period dates in UTC and average block time in ms
const VOTING_START_DATE = new Date('2025/02/27 05:00Z');
const VOTING_END_DATE = new Date('2025/03/12 17:00Z');
const SEI_BLOCK_TIME_MS = 400;

// RPC endpoints
const RPC_ENDPOINTS = {
  primary: 'https://evm-rpc.sei.basementnodes.ca',
  fallback: 'https://evm.sei-main-eu.ccvalidators.com:443',
  cosmos: 'https://rpc.sei.basementnodes.ca'
};

/**
 * Get current Cosmos block data
 * @returns {Promise<{blockHeight: number, blockTime: Date}>}
 */
async function getCurrentCosmosBlock() {
  try {
    const response = await axios.get(`${RPC_ENDPOINTS.cosmos}/block`, { timeout: 5000 });
    if (response.data?.block?.header) {
      const blockHeight = parseInt(response.data.block.header.height);
      const blockTime = new Date(response.data.block.header.time);
      console.log(`Current Cosmos block: ${blockHeight}, time: ${blockTime.toISOString()}`);
      return { blockHeight, blockTime };
    }
    throw new Error('Invalid response format from Cosmos API');
  } catch (error) {
    console.error('Error fetching current Cosmos block:', error.message);
    throw error;
  }
}

/**
 * Get block data with caching
 * @param {number} blockNumber Block number
 * @param {ethers.Provider} provider Ethers provider
 * @returns {Promise<Object>} Block data
 */
async function getBlock(blockNumber, provider) {
  const cached = blockTimeCache.get(blockNumber);
  if (cached) return cached;
  try {
    const blockPromise = provider.getBlock(blockNumber);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNumber}`)), 8000)
    );
    const block = await Promise.race([blockPromise, timeoutPromise]);
    if (!block) throw new Error(`Block ${blockNumber} not found`);
    blockTimeCache.set(blockNumber, block);
    return block;
  } catch (error) {
    console.error(`Error getting block ${blockNumber}:`, error.message);
    throw error;
  }
}

/**
 * Find the closest block to a target date using binary search
 * @param {Date} targetDate Target date
 * @param {number} startBlock Starting block for search
 * @param {number} endBlock Ending block for search
 * @param {ethers.Provider} provider Ethers provider
 * @returns {Promise<number>} Closest block number
 */
async function findBlockForDate(targetDate, startBlock, endBlock, provider) {
  console.log(`Finding block closest to ${targetDate.toISOString()}`);
  console.log(`Search range: ${startBlock} to ${endBlock}`);
  
  const targetTime = targetDate.getTime() / 1000;
  let lowerBound = startBlock;
  let upperBound = endBlock;
  let closestBlock = -1;
  let closestDiff = Infinity;
  let iterations = 0;
  const MAX_ITERATIONS = 20;
  const visitedBlocks = new Set();
  
  while (lowerBound <= upperBound && iterations < MAX_ITERATIONS) {
    iterations++;
    let midBlock = Math.floor((lowerBound + upperBound) / 2);
    
    if (visitedBlocks.has(midBlock)) {
      let found = false;
      for (let offset = 1; offset < 10; offset++) {
        let candidate = midBlock + offset;
        if (candidate <= upperBound && !visitedBlocks.has(candidate)) {
          midBlock = candidate;
          found = true;
          break;
        }
        candidate = midBlock - offset;
        if (candidate >= lowerBound && !visitedBlocks.has(candidate)) {
          midBlock = candidate;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    
    visitedBlocks.add(midBlock);
    const blockData = await getBlock(midBlock, provider);
    const blockTimeSecs = Number(blockData.timestamp);
    const blockTime = new Date(blockTimeSecs * 1000);
    console.log(`[Iteration ${iterations}] Checking block ${midBlock}, time: ${blockTime.toISOString()}`);
    
    const timeDiff = Math.abs(blockTimeSecs - targetTime);
    if (timeDiff < closestDiff) {
      closestBlock = midBlock;
      closestDiff = timeDiff;
    }
    if (timeDiff < 1) {
      console.log(`Found very close block: ${midBlock} (within 1 second)`);
      return midBlock;
    }
    
    if (blockTimeSecs < targetTime) {
      lowerBound = midBlock + 1;
    } else {
      upperBound = midBlock - 1;
    }
    
    // Adaptive skipping for faster convergence
    if (timeDiff > 3600) { // More than 1 hour away
      const skipBlocks = Math.ceil((upperBound - lowerBound) / 4);
      if (blockTimeSecs < targetTime) {
        lowerBound = midBlock + skipBlocks;
      } else {
        upperBound = midBlock - skipBlocks;
      }
    } else if (timeDiff > 600) { // More than 10 minutes away
      const skipBlocks = Math.ceil(timeDiff / SEI_BLOCK_TIME_MS * 1000);
      if (blockTimeSecs < targetTime) {
        lowerBound = midBlock + skipBlocks;
      } else {
        upperBound = midBlock - skipBlocks;
      }
    }
  }
  
  console.log(`Using closest block after ${iterations} iterations: ${closestBlock} (off by ${closestDiff}s)`);
  return closestBlock;
}

/**
 * Create provider with automatic fallback
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {ethers.Provider} Ethers provider
 */
function createProvider(primaryRpc, fallbackRpc) {
  try {
    const provider = new ethers.JsonRpcProvider(primaryRpc);
    console.log('Using primary RPC endpoint');
    return provider;
  } catch (error) {
    console.log(`Primary RPC failed: ${error.message}`);
    console.log('Using fallback RPC endpoint');
    return new ethers.JsonRpcProvider(fallbackRpc);
  }
}

/**
 * Find the start block for the voting period
 * @param {Date} targetDate Target date (UTC)
 * @param {string} primaryRpc Primary EVM RPC endpoint
 * @param {string} fallbackRpc Fallback EVM RPC endpoint 
 * @returns {Promise<number>} The block number that closely matches the target date
 */
export async function findStartBlock(targetDate, primaryRpc, fallbackRpc) {
  try {
    console.log(`Finding start block for voting period (${targetDate.toISOString()})`);
    
    // Get current block info
    await getCurrentCosmosBlock(); // Just for informational purposes
    const provider = createProvider(primaryRpc, fallbackRpc);
    const currentBlockNumber = await provider.getBlockNumber();
    console.log(`Current EVM block number: ${currentBlockNumber}`);
    
    const currentBlock = await getBlock(currentBlockNumber, provider);
    const currentBlockTime = new Date(Number(currentBlock.timestamp) * 1000);
    console.log(`Current EVM block time: ${currentBlockTime.toISOString()}`);
    
    // If target date is in the future, use current block
    if (targetDate > currentBlockTime) {
      console.log(`Target date is in the future, using current block ${currentBlockNumber}`);
      return currentBlockNumber;
    }
    
    // Calculate approximate start block
    const msTimeDiff = currentBlockTime.getTime() - targetDate.getTime();
    const approxBlocksBack = Math.ceil(msTimeDiff / SEI_BLOCK_TIME_MS);
    const approxStartBlock = Math.max(1, currentBlockNumber - approxBlocksBack);
    console.log(`Approximate start block: ${approxStartBlock} (using ${SEI_BLOCK_TIME_MS}ms average block time)`);
    
    // Refine the search range calculation in findStartBlock function
    const searchRange = Math.min(100000, approxBlocksBack); // Wider range
    const startSearchBlock = Math.max(1, approxStartBlock - searchRange);
    const endSearchBlock = Math.min(currentBlockNumber, approxStartBlock + searchRange);
    console.log(`Setting search range: ${startSearchBlock} to ${endSearchBlock}`);
    
    // Find exact start block using binary search
    const exactStartBlock = await findBlockForDate(targetDate, startSearchBlock, endSearchBlock, provider);
    console.log(`Found exact start block: ${exactStartBlock}`);
    
    // Convert to hex for EVM RPC calls
    const hexBlock = decimalToHex(exactStartBlock);
    console.log(`Start block in hex: ${hexBlock}`);
    
    return exactStartBlock;
  } catch (error) {
    console.error('Error finding start block:', error);
    throw error;
  }
}

/**
 * Get exact block range for voting period (start and end blocks)
 * @returns {Promise<Object>} Object with voting period information
 */
export async function getBlockRangeForVotingPeriod() {
  try {
    console.log('=== FINDING BLOCKS FOR SEI VOTING PERIOD ===');
    console.log(`Voting start date (UTC): ${VOTING_START_DATE.toISOString()}`);
    console.log(`Voting end date (UTC): ${VOTING_END_DATE.toISOString()}`);
    
    const provider = createProvider(RPC_ENDPOINTS.primary, RPC_ENDPOINTS.fallback);
    const currentBlockNumber = await provider.getBlockNumber();
    console.log(`Current block number: ${currentBlockNumber}`);
    
    // Find start block
    const startBlock = await findStartBlock(
      VOTING_START_DATE, 
      RPC_ENDPOINTS.primary, 
      RPC_ENDPOINTS.fallback
    );
    console.log(`\nVoting period start block: ${startBlock}`);
    
    // Find or estimate end block
    let endBlock = null;
    const now = new Date();
    
    if (now > VOTING_END_DATE) {
      // If voting period has ended, find the exact end block
      endBlock = await findStartBlock(
        VOTING_END_DATE,
        RPC_ENDPOINTS.primary,
        RPC_ENDPOINTS.fallback
      );
      console.log(`\nVoting period end block: ${endBlock}`);
    } else {
      // Calculate approximate end block for testing
      console.log('\nVoting end date is in the future, using approximate end block');
      const msFromStartToEnd = VOTING_END_DATE.getTime() - VOTING_START_DATE.getTime();
      const approxBlocksFromStartToEnd = Math.ceil(msFromStartToEnd / SEI_BLOCK_TIME_MS);
      endBlock = startBlock + approxBlocksFromStartToEnd;
      console.log(`Approximate end block (based on ${SEI_BLOCK_TIME_MS}ms block time): ${endBlock}`);
    }
    
    // Generate result object with test ranges
    const result = {
      generatedAt: new Date().toISOString(),
      votingPeriod: {
        startDate: VOTING_START_DATE.toISOString(),
        endDate: VOTING_END_DATE.toISOString(),
        startBlock,
        endBlock: endBlock || 'Not yet reached'
      },
      testRanges: {
        fullRange: { 
          start: startBlock, 
          end: endBlock || currentBlockNumber 
        },
        initialSample: { 
          start: startBlock, 
          end: startBlock + 5000 // First 5000 blocks (~33 minutes)
        },
        midSample: {
          start: Math.max(startBlock, Math.floor((startBlock + (endBlock || currentBlockNumber)) / 2) - 2500),
          end: Math.min((endBlock || currentBlockNumber), Math.floor((startBlock + (endBlock || currentBlockNumber)) / 2) + 2500)
        },
        latestSample: { 
          start: Math.max(startBlock, currentBlockNumber - 5000), 
          end: currentBlockNumber 
        }
      },
      currentBlock: currentBlockNumber
    };
    
    // Save to file
    const outputFile = path.join(__dirname, 'sei_voting_block_range.json');
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    
    // Print recommended ranges
    console.log('\n=== RECOMMENDED BLOCK RANGES FOR TESTING ===');
    console.log(`Full voting period: ${result.testRanges.fullRange.start} to ${result.testRanges.fullRange.end}`);
    console.log(`Initial sample: ${result.testRanges.initialSample.start} to ${result.testRanges.initialSample.end}`);
    console.log(`Mid-period sample: ${result.testRanges.midSample.start} to ${result.testRanges.midSample.end}`);
    console.log(`Latest sample: ${result.testRanges.latestSample.start} to ${result.testRanges.latestSample.end}`);
    console.log(`\nResults saved to: ${outputFile}`);
    
    // Example for test script
    console.log('\n=== COPY-PASTE FOR TEST SCRIPT ===');
    console.log(`const TEST_START_BLOCK = ${result.testRanges.initialSample.start}; // Initial voting period sample`);
    console.log(`const TEST_END_BLOCK = ${result.testRanges.initialSample.end};`);
    
    return result;
  } catch (error) {
    console.error('Error determining block range:', error);
    throw error;
  }
}

// Execute if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  getBlockRangeForVotingPeriod().catch(console.error);
}