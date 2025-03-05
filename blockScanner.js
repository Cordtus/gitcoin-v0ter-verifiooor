// blockScanner.js - Enhanced for detecting SEI voting transactions

import { ethers } from 'ethers';
import { retry, sleep, decimalToHex } from './utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Performance optimization constants
const MAX_CONCURRENT_BATCHES = Math.max(2, Math.min(os.cpus().length - 1, 4));
const BATCH_SIZE = 50;
const SUB_BATCH_SIZE = 10;
const REQUEST_THROTTLE_MS = 50;
const BLOCK_TIMEOUT_MS = 8000;
const RECEIPT_TIMEOUT_MS = 5000;

// SEI voting contract parameters
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();
const VOTE_METHOD_SIG = '0xc7b8896b'; // Verified vote method signature

// Cache for blocks and transactions
const blockCache = new Map();
const txCache = new Map();
const receiptCache = new Map();

// Cache statistics
let blockCacheHits = 0;
let blockCacheMisses = 0;
let txCacheHits = 0;
let txCacheMisses = 0;
let receiptCacheHits = 0;
let receiptCacheMisses = 0;

/**
 * Get block with transactions
 * @param {number} blockNumber Block number
 * @param {ethers.JsonRpcProvider} provider Ethers provider
 * @returns {Promise<Object>} Block with transactions
 */
async function getBlockWithTransactions(blockNumber, provider) {
  // Check cache first
  const cacheKey = `block-${blockNumber}`;
  if (blockCache.has(cacheKey)) {
    blockCacheHits++;
    return blockCache.get(cacheKey);
  }
  
  blockCacheMisses++;
  
  try {
    // Get block with timeout
    const blockPromise = provider.getBlock(blockNumber, true);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Block ${blockNumber} retrieval timed out`)), BLOCK_TIMEOUT_MS);
    });
    
    const block = await Promise.race([blockPromise, timeoutPromise]);
    
    if (!block) {
      throw new Error(`Block ${blockNumber} not found`);
    }
    
    // Cache result
    blockCache.set(cacheKey, block);
    return block;
  } catch (error) {
    // Try fallback approach - get block header then fetch transactions separately
    try {
      const blockHeaderPromise = provider.getBlock(blockNumber);
      const headerTimeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Block header ${blockNumber} timed out`)), BLOCK_TIMEOUT_MS);
      });
      
      const blockHeader = await Promise.race([blockHeaderPromise, headerTimeoutPromise]);
      
      if (!blockHeader) {
        throw new Error(`Block ${blockNumber} header not found`);
      }
      
      // Build block with transactions
      const baseBlock = {
        ...blockHeader,
        transactions: blockHeader.transactions || [], // May only have tx hashes
        _needsTransactionDetails: blockHeader.transactions && 
                                blockHeader.transactions.length > 0 && 
                                typeof blockHeader.transactions[0] === 'string'
      };
      
      // Cache the base block
      blockCache.set(cacheKey, baseBlock);
      return baseBlock;
    } catch (fallbackError) {
      console.error(`Failed to get block ${blockNumber}:`, fallbackError.message);
      throw fallbackError;
    }
  }
}

/**
 * Get transaction receipt
 * @param {string} txHash Transaction hash
 * @param {ethers.JsonRpcProvider} provider Ethers provider
 * @returns {Promise<Object>} Transaction receipt
 */
async function getTransactionReceipt(txHash, provider) {
  // Check cache first
  const cacheKey = `receipt-${txHash}`;
  if (receiptCache.has(cacheKey)) {
    receiptCacheHits++;
    return receiptCache.get(cacheKey);
  }
  
  receiptCacheMisses++;
  
  try {
    // Get receipt with timeout
    const receiptPromise = provider.getTransactionReceipt(txHash);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Receipt for ${txHash} timed out`)), RECEIPT_TIMEOUT_MS);
    });
    
    const receipt = await Promise.race([receiptPromise, timeoutPromise]);
    
    if (receipt) {
      receiptCache.set(cacheKey, receipt);
    }
    
    return receipt;
  } catch (error) {
    console.error(`Failed to get receipt for ${txHash}:`, error.message);
    return null;
  }
}

/**
 * Get provider with automatic fallback
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<ethers.JsonRpcProvider>} Ethers provider
 */
async function getProvider(primaryRpc, fallbackRpc) {
  try {
    const provider = new ethers.JsonRpcProvider(primaryRpc);
    await provider.getBlockNumber(); // Test connection
    console.log('Using primary RPC provider');
    return provider;
  } catch (error) {
    console.error(`Primary RPC failed: ${error.message}`);
    console.log('Using fallback RPC provider');
    return new ethers.JsonRpcProvider(fallbackRpc);
  }
}

/**
 * Check if a transaction is a vote based on enhanced detection criteria
 * @param {Object} tx Transaction object 
 * @param {Object} receipt Transaction receipt
 * @returns {Object} Vote check result
 */
function isVoteTransaction(tx, receipt) {
  // Method 1: Direct transfer to proxy
  const isDirectTransfer = 
    tx.to && 
    tx.to.toLowerCase() === PROXY_ADDRESS && 
    tx.value > 0n;
  
  // Method 2: Method call to proxy with vote signature
  const isMethodCall = 
    tx.to && 
    tx.to.toLowerCase() === PROXY_ADDRESS && 
    tx.data && 
    tx.data.startsWith(VOTE_METHOD_SIG);
  
  // Method 3: Check logs for implementation contract
  const hasImplLogs = receipt.logs && receipt.logs.some(log => 
    log.address && log.address.toLowerCase() === IMPLEMENTATION_ADDRESS
  );
  
  // Method 4: Check logs for proxy contract
  const hasProxyLogs = receipt.logs && receipt.logs.some(log => 
    log.address && log.address.toLowerCase() === PROXY_ADDRESS
  );
  
  // Final determination - ANY method is valid
  const isVote = (isDirectTransfer || isMethodCall || hasImplLogs || hasProxyLogs);
  
  let detectionMethod = '';
  if (isDirectTransfer) detectionMethod += 'direct-transfer,';
  if (isMethodCall) detectionMethod += 'method-call,';
  if (hasImplLogs) detectionMethod += 'impl-logs,';
  if (hasProxyLogs) detectionMethod += 'proxy-logs,';
  detectionMethod = detectionMethod.slice(0, -1); // Remove trailing comma
  
  return {
    isVote,
    detectionMethod: detectionMethod || 'none',
    value: tx.value,
    valueInSei: ethers.formatEther(tx.value),
    data: tx.data
  };
}

export async function scanBlockRangeForVotes(
  fromBlock, 
  toBlock, 
  addresses, 
  primaryRpc, 
  fallbackRpc,
  onVoteFound = null,
  saveProgress = false
) {
  console.log(`Scanning blocks ${fromBlock} to ${toBlock} for votes...`);
  
  // Get provider
  const provider = await getProvider(primaryRpc, fallbackRpc);
  
  // Make sure addresses are lowercase
  const proxyAddress = addresses[0].toLowerCase();
  const implAddress = addresses[1].toLowerCase();
  
  // Track votes by their hash
  const votes = new Map();
  
  // Create batches for parallel processing
  const batches = [];
  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, toBlock);
    batches.push({ start, end });
  }
  
  console.log(`Processing ${batches.length} batches using ${MAX_CONCURRENT_BATCHES} concurrent processes`);
  
  // Process batches with controlled concurrency
  let processedBatches = 0;
  let totalBlocksProcessed = 0;
  let lastProgressReport = Date.now();
  let lastProgressSave = Date.now();
  
  // Last processed block for saving progress
  let lastProcessedBlock = fromBlock - 1;
  
  // Process batches with concurrency control
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const batchPromises = currentBatches.map(async ({ start, end }) => {
      try {
        // Process smaller sub-batches
        const subBatchResults = [];
        
        for (let blockNum = start; blockNum <= end; blockNum += SUB_BATCH_SIZE) {
          const subBatchEnd = Math.min(blockNum + SUB_BATCH_SIZE - 1, end);
          
          // Process sub-batch blocks
          const subBatchVotes = await processBlockRange(
            blockNum, 
            subBatchEnd, 
            proxyAddress, 
            implAddress, 
            provider, 
            onVoteFound
          );
          
          subBatchResults.push(...subBatchVotes);
          
          // Brief pause between sub-batches
          await sleep(10);
        }
        
        return subBatchResults;
      } catch (batchError) {
        console.error(`Error processing batch ${start}-${end}:`, batchError.message);
        return []; // Return empty array to continue with other batches
      }
    });
    
    // Wait for all current batches to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Process results
    for (const results of batchResults) {
      for (const vote of results) {
        votes.set(vote.transactionHash, vote);
      }
    }
    
    // Update progress
    processedBatches += currentBatches.length;
    totalBlocksProcessed += currentBatches.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
    
    // Update the last processed block
    const lastBatchEnd = Math.max(...currentBatches.map(batch => batch.end));
    lastProcessedBlock = Math.max(lastProcessedBlock, lastBatchEnd);
    
    // Report progress
    const now = Date.now();
    if (now - lastProgressReport > 5000) {
      const progress = ((processedBatches / batches.length) * 100).toFixed(1);
      console.log(`Progress: ${progress}% (${processedBatches}/${batches.length} batches, ${votes.size} votes found)`);
      lastProgressReport = now;
    }
    
    // Save progress to disk if enabled
    if (saveProgress && now - lastProgressSave > 30000) {
      const saveFile = path.join(__dirname, 'data', 'last_processed_block.txt');
      
      // Ensure directory exists
      const dir = path.dirname(saveFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(saveFile, lastProcessedBlock.toString(), 'utf8');
      console.log(`Saved progress to ${saveFile}: block ${lastProcessedBlock}`);
      lastProgressSave = now;
    }
    
    // Brief pause between batches to avoid overwhelming the node
    if (i + MAX_CONCURRENT_BATCHES < batches.length) {
      await sleep(REQUEST_THROTTLE_MS);
    }
  }
  
  console.log(`Scan complete. Found ${votes.size} votes across ${totalBlocksProcessed} blocks.`);
  
  // Final save if enabled
  if (saveProgress) {
    const saveFile = path.join(__dirname, 'data', 'last_processed_block.txt');
    fs.writeFileSync(saveFile, lastProcessedBlock.toString(), 'utf8');
    console.log(`Saved final progress to ${saveFile}: block ${lastProcessedBlock}`);
  }
  
  return Array.from(votes.values());
}

/**
* Process a range of blocks to find votes
* @param {number} fromBlock Starting block
* @param {number} toBlock Ending block
* @param {string} proxyAddress Proxy contract address
* @param {string} implAddress Implementation contract address
* @param {ethers.Provider} provider Ethers provider
* @param {Function} onVoteFound Callback for each vote found (optional)
* @returns {Promise<Array>} Voting transactions
*/
async function processBlockRange(fromBlock, toBlock, proxyAddress, implAddress, provider, onVoteFound) {
  const blockVotes = [];
  
  // Get all blocks in parallel
  const blockPromises = [];
  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      blockPromises.push(getBlockWithTransactions(blockNum, provider));
  }
  
  const blocks = await Promise.all(blockPromises);
  
  // Process each block
  for (const block of blocks) {
      if (!block || !block.transactions) continue;
      
      let transactions;
      
      // If we only have transaction hashes, fetch full details
      if (block._needsTransactionDetails) {
        transactions = [];
        for (const txHash of block.transactions) {
            try {
            // Check cache first
            const cacheKey = `tx-${txHash}`;
            if (txCache.has(cacheKey)) {
                txCacheHits++;
                transactions.push(txCache.get(cacheKey));
                continue;
            }
            
            txCacheMisses++;
            const tx = await provider.getTransaction(txHash);
            if (tx) {
                txCache.set(cacheKey, tx);
                transactions.push(tx);
            }
            } catch (error) {
            console.error(`Error fetching tx ${txHash}:`, error.message);
            }
        }
      } else {
        transactions = block.transactions;
      }
      
      // Filter for transactions that might be votes
      const potentialVotes = transactions.filter(tx => 
        typeof tx === 'object' && tx.to && (
          tx.to.toLowerCase() === proxyAddress || 
          (tx.to.toLowerCase() === implAddress && tx.data && tx.data.length > 2)
        )
      );
      
      if (potentialVotes.length > 0) {
        // Check each potential vote
        for (const tx of potentialVotes) {
          try {
            // Check receipt
            const receipt = await getTransactionReceipt(tx.hash, provider);
            if (!receipt || receipt.status !== 1) continue; // Skip failed transactions
            
            // Determine if this is a vote using our enhanced criteria
            const voteCheck = isVoteTransaction(tx, receipt);
            
            if (voteCheck.isVote) {
              const voteInfo = {
                transactionHash: tx.hash,
                blockNumber: Number(block.number),
                from: tx.from,
                to: tx.to,
                value: voteCheck.valueInSei,
                voteAmount: parseFloat(voteCheck.valueInSei), // For consistent type
                timestamp: new Date(Number(block.timestamp) * 1000),
                method: voteCheck.detectionMethod,
                success: true
              };
              
              blockVotes.push(voteInfo);
              
              // Notify callback if provided
              if (onVoteFound) {
                onVoteFound(voteInfo);
              }
            }
          } catch (txError) {
            console.error(`Error processing transaction ${tx.hash}:`, txError.message);
          }
        }
      }
  }
  
  return blockVotes;
}

/**
* Clear caches to free memory
*/
export function clearCaches() {
  console.log(`Clearing caches: ${blockCache.size} blocks, ${txCache.size} transactions, ${receiptCache.size} receipts`);
  blockCache.clear();
  txCache.clear();
  receiptCache.clear();
  
  // Reset cache statistics
  blockCacheHits = 0;
  blockCacheMisses = 0;
  txCacheHits = 0;
  txCacheMisses = 0;
  receiptCacheHits = 0;
  receiptCacheMisses = 0;
}

/**
* Get cache statistics
* @returns {Object} Cache statistics
*/
export function getCacheStats() {
  return {
    blockCache: {
      size: blockCache.size,
      hits: blockCacheHits,
      misses: blockCacheMisses,
      efficiency: blockCacheHits + blockCacheMisses > 0 
        ? (blockCacheHits / (blockCacheHits + blockCacheMisses)).toFixed(2) 
        : 0
    },
    txCache: {
      size: txCache.size,
      hits: txCacheHits,
      misses: txCacheMisses,
      efficiency: txCacheHits + txCacheMisses > 0 
        ? (txCacheHits / (txCacheHits + txCacheMisses)).toFixed(2) 
        : 0
    },
    receiptCache: {
      size: receiptCache.size,
      hits: receiptCacheHits,
      misses: receiptCacheMisses,
      efficiency: receiptCacheHits + receiptCacheMisses > 0 
        ? (receiptCacheHits / (receiptCacheHits + receiptCacheMisses)).toFixed(2) 
        : 0
    }
  };
}