// Updated contractReader.js with enhanced voting detection

import { ethers } from 'ethers';
import axios from 'axios';
import { retry, sleep } from './utils.js';

// Constants for performance optimization
const INITIAL_FETCH_BATCH_SIZE = 5000;  // For initial historical fetch
const LIVE_FETCH_BATCH_SIZE = 100;      // For live monitoring
const MAX_CONCURRENT_BATCHES = 3;       // Concurrency limit
const REQUEST_THROTTLE_MS = 100;        // Throttle between requests

// Voting detection constants - VERIFIED from testing
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();
const VOTE_METHOD_SIG = '0xc7b8896b'; // Method used in all voting transactions

// Cache implementation with TTL and hit tracking
class Cache {
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
  
  getStats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits / (this.hits + this.misses || 1)
    };
  }
}

// Export caches for shared use
export const blockCache = new Cache('blocks', 2000);
export const txCache = new Cache('transactions', 5000);
export const receiptCache = new Cache('receipts', 5000);

/**
 * Get current block height with fallback
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Current block height
 */
export async function getCurrentBlockHeight(primaryRpc, fallbackRpc) {
    return await retry(async () => {
        try {
            const provider = new ethers.JsonRpcProvider(primaryRpc);
            const blockNumber = await provider.getBlockNumber();
            console.log(`Current block height from primary RPC: ${blockNumber}`);
            return blockNumber;
        } catch (error) {
            console.error('Primary RPC failed, trying fallback:', error.message);
            const provider = new ethers.JsonRpcProvider(fallbackRpc);
            const blockNumber = await provider.getBlockNumber();
            console.log(`Current block height from fallback RPC: ${blockNumber}`);
            return blockNumber;
        }
    }, 3, 1000);
}

/**
 * Check if a transaction is a vote based on multiple detection methods
 * @param {Object} tx Transaction object
 * @param {Object} receipt Transaction receipt
 * @returns {Object} Vote check results
 */
function isVoteTransaction(tx, receipt) {
    if (!tx || !receipt) return { isVote: false };
    
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
    
    // Method 3: Has logs from implementation contract
    const hasImplLogs = receipt.logs && receipt.logs.some(log => 
        log.address && log.address.toLowerCase() === IMPLEMENTATION_ADDRESS
    );
    
    // Method 4: Has logs from proxy contract
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
        valueInSei: tx.value > 0n ? ethers.formatEther(tx.value) : '0',
        data: tx.data
    };
}

/**
 * Get block with transactions
 * @param {number} blockNumber Block number
 * @param {ethers.JsonRpcProvider} provider Ethers provider
 * @returns {Promise<Object>} Block with transactions
 */
async function getBlockWithTransactions(blockNumber, provider) {
    const cacheKey = `block-${blockNumber}`;
    if (blockCache.has(cacheKey)) {
        return blockCache.get(cacheKey);
    }
    
    try {
        const blockPromise = provider.getBlock(blockNumber, true);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNumber}`)), 10000);
        });
        
        const block = await Promise.race([blockPromise, timeoutPromise]);
        
        if (!block) {
            throw new Error(`Block ${blockNumber} not found`);
        }
        
        blockCache.set(cacheKey, block);
        return block;
    } catch (error) {
        console.error(`Error getting block ${blockNumber}:`, error.message);
        throw error;
    }
}

/**
 * Get transaction receipt
 * @param {string} txHash Transaction hash
 * @param {ethers.JsonRpcProvider} provider Ethers provider
 * @returns {Promise<Object>} Transaction receipt
 */
async function getTransactionReceipt(txHash, provider) {
    const cacheKey = `receipt-${txHash}`;
    if (receiptCache.has(cacheKey)) {
        return receiptCache.get(cacheKey);
    }
    
    try {
        const receiptPromise = provider.getTransactionReceipt(txHash);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Receipt retrieval timed out for tx ${txHash}`)), 10000);
        });
        
        const receipt = await Promise.race([receiptPromise, timeoutPromise]);
        
        if (receipt) {
            receiptCache.set(cacheKey, receipt);
        }
        
        return receipt;
    } catch (error) {
        console.error(`Error getting receipt for ${txHash}:`, error.message);
        throw error;
    }
}

/**
 * Process a block for voting transactions
 * @param {number} blockNumber Block number to process
 * @param {ethers.JsonRpcProvider} provider Ethers provider
 * @returns {Promise<Array>} Array of vote objects
 */
async function processBlockForVotes(blockNumber, provider) {
    try {
        const block = await getBlockWithTransactions(blockNumber, provider);
        
        if (!block || !block.transactions || block.transactions.length === 0) {
            return [];
        }
        
        // Filter potentially relevant transactions
        const relevantTxs = block.transactions.filter(tx => 
            tx.to && (
                tx.to.toLowerCase() === PROXY_ADDRESS || 
                tx.to.toLowerCase() === IMPLEMENTATION_ADDRESS
            )
        );
        
        if (relevantTxs.length === 0) {
            return [];
        }
        
        const votes = [];
        
        for (const tx of relevantTxs) {
            const receipt = await getTransactionReceipt(tx.hash, provider);
            
            if (!receipt || receipt.status !== 1) {
                continue; // Skip failed transactions
            }
            
            const voteCheck = isVoteTransaction(tx, receipt);
            
            if (voteCheck.isVote) {
                console.log(`Vote found at block ${blockNumber}: ${tx.hash} (${voteCheck.detectionMethod})`);
                
                votes.push({
                    transactionHash: tx.hash,
                    blockNumber: Number(block.number),
                    from: tx.from,
                    to: tx.to,
                    value: voteCheck.valueInSei,
                    voteAmount: parseFloat(voteCheck.valueInSei), // For consistent type
                    timestamp: new Date(Number(block.timestamp) * 1000),
                    method: voteCheck.detectionMethod,
                    success: true
                });
            }
        }
        
        return votes;
    } catch (error) {
        console.error(`Error processing block ${blockNumber}:`, error.message);
        return [];
    }
}

/**
 * Fetch voting events using enhanced detection
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress] 
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @param {boolean} isInitialFetch Whether this is the initial historical fetch
 * @returns {Promise<Array>} Array of voting events
 */
export async function fetchVotingEvents(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc, isInitialFetch = true) {
    const batchSize = isInitialFetch ? INITIAL_FETCH_BATCH_SIZE : LIVE_FETCH_BATCH_SIZE;
    console.log(`Fetching voting transactions from block ${fromBlock} to ${toBlock} (${isInitialFetch ? 'initial' : 'live'} mode)`);
    
    // Create provider (fail over if needed)
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
        await provider.getBlockNumber(); // Test connection
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    // Create batches
    const batches = [];
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, toBlock);
        batches.push({ start, end });
    }
    
    console.log(`Processing ${batches.length} batches of ${batchSize} blocks each`);
    
    // Process batches with controlled concurrency
    const allVotes = new Map(); // Use Map to ensure unique votes by hash
    let processedBatches = 0;
    
    // Process batches with limited concurrency
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
        const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
        
        // Process each batch in parallel
        const batchPromises = currentBatches.map(async ({ start, end }) => {
            const batchVotes = [];
            
            // Process blocks in smaller sub-batches
            const SUB_BATCH_SIZE = 20;
            for (let blockNum = start; blockNum <= end; blockNum += SUB_BATCH_SIZE) {
                const subEnd = Math.min(blockNum + SUB_BATCH_SIZE - 1, end);
                
                // Process each block in the sub-batch
                for (let currentBlock = blockNum; currentBlock <= subEnd; currentBlock++) {
                    const blockVotes = await processBlockForVotes(currentBlock, provider);
                    batchVotes.push(...blockVotes);
                }
                
                // Brief pause between sub-batches
                if (blockNum + SUB_BATCH_SIZE <= end) {
                    await sleep(10);
                }
            }
            
            return batchVotes;
        });
        
        // Wait for current batch to complete
        const batchResults = await Promise.all(batchPromises);
        
        // Add votes to the Map
        for (const votes of batchResults) {
            for (const vote of votes) {
                allVotes.set(vote.transactionHash, vote);
            }
        }
        
        // Update progress
        processedBatches += currentBatches.length;
        const progress = Math.round((processedBatches / batches.length) * 100);
        console.log(`Progress: ${progress}% (${processedBatches}/${batches.length} batches, ${allVotes.size} votes found)`);
        
        // Brief pause between batch groups
        if (i + MAX_CONCURRENT_BATCHES < batches.length) {
            await sleep(REQUEST_THROTTLE_MS);
        }
    }
    
    // Convert votes Map to Array
    return Array.from(allVotes.values());
}

/**
 * Listen for new votes in real-time with enhanced recovery
 * @param {number} fromBlock Block to start listening from
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress]
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @param {Function} callback Callback function for new votes
 * @returns {Object} Subscription object with stop method
 */
export function listenForVotes(fromBlock, addresses, primaryRpc, fallbackRpc, callback) {
    let running = true;
    let currentBlock = fromBlock;
    let provider;
    let reconnectAttempts = 0;
    let pollInterval = null;
    const MAX_RECONNECT_ATTEMPTS = 10;
    
    // Polling method for vote monitoring
    const setupPolling = () => {
        console.log('Using polling method for vote monitoring');
        
        // Create a provider for polling
        const getPollingProvider = () => {
            try {
                return new ethers.JsonRpcProvider(primaryRpc);
            } catch (error) {
                console.error('Error creating primary provider:', error.message);
                return new ethers.JsonRpcProvider(fallbackRpc);
            }
        };
        
        provider = getPollingProvider();
        
        // Start polling loop
        const pollForVotes = async () => {
            if (!running) return;
            
            try {
                let latestBlock;
                try {
                    latestBlock = await provider.getBlockNumber();
                } catch (error) {
                    console.error('Error getting block number, recreating provider:', error.message);
                    provider = getPollingProvider();
                    latestBlock = await provider.getBlockNumber();
                }
                
                // Check if we have new blocks to process
                if (latestBlock > currentBlock) {
                    // Don't process too many blocks at once to avoid timeouts
                    const batchEndBlock = Math.min(latestBlock, currentBlock + LIVE_FETCH_BATCH_SIZE);
                    
                    console.log(`Checking for new votes in blocks ${currentBlock + 1} to ${batchEndBlock}`);
                    
                    // Fetch votes using our enhanced method
                    const newVotes = await fetchVotingEvents(
                        currentBlock + 1,
                        batchEndBlock,
                        addresses,
                        primaryRpc,
                        fallbackRpc,
                        false // Not initial fetch
                    );
                    
                    // Process each vote through callback
                    if (newVotes.length > 0) {
                        console.log(`Found ${newVotes.length} new votes!`);
                        
                        for (const vote of newVotes) {
                            callback(vote);
                        }
                    }
                    
                    // Update current block, even if we found no votes
                    currentBlock = batchEndBlock;
                    console.log(`Updated current block to ${currentBlock}`);
                }
                
                // Reset reconnect attempts on success
                reconnectAttempts = 0;
                
                // Schedule next poll
                pollInterval = setTimeout(pollForVotes, 5000); // Poll every 5 seconds
            } catch (error) {
                console.error('Error in vote polling:', error);
                
                // Try again after a short delay with exponential backoff
                reconnectAttempts++;
                const delay = Math.min(60000, 5000 * Math.pow(1.5, reconnectAttempts));
                console.log(`Polling failed. Retrying in ${Math.round(delay/1000)} seconds (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.error(`Reached maximum reconnect attempts (${MAX_RECONNECT_ATTEMPTS}). Resetting attempts and recreating provider.`);
                    reconnectAttempts = 0;
                    provider = getPollingProvider();
                }
                
                pollInterval = setTimeout(pollForVotes, delay);
            }
        };
        
        // Start initial poll
        console.log(`Starting polling from block ${currentBlock}`);
        pollForVotes();
    };
    
    // Start with polling (more reliable)
    setupPolling();
    
    // Return control object
    return {
        stop: () => {
            console.log('Stopping vote listener');
            running = false;
            
            if (pollInterval) {
                clearTimeout(pollInterval);
                pollInterval = null;
            }
            
            if (provider && typeof provider.destroy === 'function') {
                provider.destroy();
            }
        },
        getCurrentBlock: () => currentBlock
    };
}

/**
 * Clear caches to free memory
 */
export function clearCaches() {
    console.log(`Clearing caches: ${blockCache.size()} blocks, ${txCache.size()} transactions, ${receiptCache.size()} receipts`);
    blockCache.clear();
    txCache.clear();
    receiptCache.clear();
}

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
    return {
        blockCache: blockCache.getStats(),
        txCache: txCache.getStats(),
        receiptCache: receiptCache.getStats()
    };
}

/**
 * Get transaction details for a specific hash
 * @param {string} txHash Transaction hash
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @param {Array<string>} addresses Addresses to monitor (optional)
 * @returns {Promise<Object>} Transaction details
 */
export async function getTransactionDetails(txHash, primaryRpc, fallbackRpc, addresses = []) {
    // Check cache first
    if (txCache.has(txHash)) {
        return txCache.get(txHash);
    }
    
    return await retry(async () => {
        let provider;
        
        try {
            provider = new ethers.JsonRpcProvider(primaryRpc);
        } catch (primaryError) {
            console.log(`Primary RPC failed: ${primaryError.message}`);
            provider = new ethers.JsonRpcProvider(fallbackRpc);
        }
        
        try {
            // Get transaction with timeout
            const txPromise = provider.getTransaction(txHash);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Transaction retrieval timed out for ${txHash}`)), 15000);
            });
            
            const tx = await Promise.race([txPromise, timeoutPromise]);
            
            if (!tx) {
                console.log(`Transaction ${txHash} not found`);
                return null;
            }
            
            // Get receipt for status
            const receiptPromise = provider.getTransactionReceipt(txHash);
            const receipt = await Promise.race([
                receiptPromise,
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Receipt retrieval timed out for ${txHash}`)), 15000);
                })
            ]);
            
            if (!receipt) {
                console.log(`Receipt for ${txHash} not found`);
                return null;
            }
            
            // Get block for timestamp
            const blockNumber = Number(tx.blockNumber);
            let block;
            
            if (blockCache.has(blockNumber)) {
                block = blockCache.get(blockNumber);
            } else {
                const blockPromise = provider.getBlock(blockNumber);
                
                block = await Promise.race([
                    blockPromise,
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNumber}`)), 15000);
                    })
                ]);
                
                if (block) {
                    blockCache.set(blockNumber, block);
                }
            }
            
            if (!block) {
                console.log(`Block ${blockNumber} not found`);
                return null;
            }
            
            // Check if this is a voting transaction using our enhanced detection
            const voteCheck = isVoteTransaction(tx, receipt);
            
            const details = {
                hash: tx.hash,
                blockNumber: blockNumber,
                from: tx.from,
                to: tx.to,
                value: Number(ethers.formatEther(tx.value)),
                voteAmount: Number(ethers.formatEther(tx.value)),
                timestamp: new Date(Number(block.timestamp) * 1000),
                success: receipt.status === 1,
                isVotingTransaction: voteCheck.isVote,
                detectionMethod: voteCheck.detectionMethod,
                gasUsed: Number(receipt.gasUsed),
                logs: receipt.logs.length
            };
            
            // Cache the result
            txCache.set(txHash, details);
            
            return details;
        } catch (error) {
            console.error(`Error getting transaction details for ${txHash}:`, error.message);
            return null;
        }
    }, 3, 1000);
}