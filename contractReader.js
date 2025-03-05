// contractReader.js

import { ethers } from 'ethers';
import axios from 'axios';
import { retry, sleep } from './utils.js';

// Constants for performance optimization
const INITIAL_FETCH_BATCH_SIZE = 10000; // Larger batch size for initial fetch
const LIVE_FETCH_BATCH_SIZE = 100;      // Smaller batch size for live monitoring
const MAX_CONCURRENT_BATCHES = 5;       // Maximum number of concurrent batch requests
const REQUEST_THROTTLE_MS = 50;         // Milliseconds to wait between requests

// Cache for blocks and transactions
const blockCache = new Map();
const txCache = new Map();

// Cache statistics
let blockCacheHits = 0;
let blockCacheMisses = 0;
let txCacheHits = 0;
let txCacheMisses = 0;

/**
 * Get current block height
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Current block height
 */
export async function getCurrentBlockHeight(primaryRpc, fallbackRpc) {
    return await retry(async () => {
        try {
            const provider = new ethers.JsonRpcProvider(primaryRpc);
            return await provider.getBlockNumber();
        } catch (error) {
            console.error('Primary RPC failed, trying fallback:', error.message);
            const provider = new ethers.JsonRpcProvider(fallbackRpc);
            return await provider.getBlockNumber();
        }
    });
}

/**
 * Fetch voting events using best available method
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
    
    // Defaulting to block scanning method (trace_filter disabled)
    return await fetchVotingWithBlockScan(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc, batchSize);
}

/**
 * Check if the primary node has the block data
 * @param {number} blockNumber Block to check
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<{hasBlock: boolean, useArchive: boolean}>} Result of check
 */
export async function checkBlockAvailability(blockNumber, primaryRpc, fallbackRpc) {
    return await retry(async () => {
        try {
            console.log(`Checking if block ${blockNumber} is available on primary node...`);
            
            // Try primary provider
            try {
                const provider = new ethers.JsonRpcProvider(primaryRpc);
                
                // Set timeout for block check
                const blockPromise = provider.getBlock(blockNumber);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Block availability check timed out')), 10000);
                });
                
                const block = await Promise.race([blockPromise, timeoutPromise]);
                
                if (block) {
                    console.log(`Block ${blockNumber} is available on primary node`);
                    // Add to cache
                    blockCache.set(blockNumber, block);
                    return { hasBlock: true, useArchive: false };
                }
            } catch (error) {
                console.log(`Primary node failed for block check: ${error.message}`);
            }
            
            // Try archive provider
            try {
                const provider = new ethers.JsonRpcProvider(fallbackRpc);
                
                // Set timeout for block check
                const blockPromise = provider.getBlock(blockNumber);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Block availability check timed out')), 10000);
                });
                
                const block = await Promise.race([blockPromise, timeoutPromise]);
                
                if (block) {
                    console.log(`Block ${blockNumber} is available on archive node`);
                    // Add to cache
                    blockCache.set(blockNumber, block);
                    return { hasBlock: true, useArchive: true };
                }
            } catch (error) {
                console.log(`Archive node also failed for block check: ${error.message}`);
            }
            
            console.log(`Block ${blockNumber} not found on either node`);
            return { hasBlock: false, useArchive: false };
        } catch (error) {
            console.error(`Error checking block availability: ${error.message}`);
            return { hasBlock: false, useArchive: true }; // Default to archive on error
        }
    }, 3, 1000); // Retry up to 3 times with 1s initial delay
}

/**
 * Clear caches to free memory
 */
export function clearCaches() {
    console.log(`Clearing caches: ${blockCache.size} blocks, ${txCache.size} transactions`);
    blockCache.clear();
    txCache.clear();
    // Reset statistics
    blockCacheHits = 0;
    blockCacheMisses = 0;
    txCacheHits = 0;
    txCacheMisses = 0;
}

/**
 * Limit cache sizes to prevent memory issues
 * @param {number} maxBlocks Maximum number of blocks to cache
 * @param {number} maxTxs Maximum number of transactions to cache
 */
export function limitCacheSizes(maxBlocks = 1000, maxTxs = 5000) {
    // If caches are already under limits, do nothing
    if (blockCache.size <= maxBlocks && txCache.size <= maxTxs) {
        return;
    }
    
    console.log(`Limiting cache sizes to maxBlocks=${maxBlocks}, maxTxs=${maxTxs}`);
    
    // Limit block cache - remove oldest entries first (typically lowest block numbers)
    if (blockCache.size > maxBlocks) {
        const excessCount = blockCache.size - maxBlocks;
        console.log(`Removing ${excessCount} entries from block cache`);
        
        // Sort keys numerically (block numbers)
        const sortedKeys = [...blockCache.keys()].sort((a, b) => a - b);
        
        // Remove oldest blocks first
        const keysToDelete = sortedKeys.slice(0, excessCount);
        for (const key of keysToDelete) {
            blockCache.delete(key);
        }
    }
    
    // Limit tx cache - remove oldest entries (less frequently accessed)
    if (txCache.size > maxTxs) {
        const excessCount = txCache.size - maxTxs;
        console.log(`Removing ${excessCount} entries from transaction cache`);
        
        // Get keys (transaction hashes)
        const keys = [...txCache.keys()];
        
        // Remove oldest entries (first added)
        const keysToDelete = keys.slice(0, excessCount);
        for (const key of keysToDelete) {
            txCache.delete(key);
        }
    }
    
    console.log(`Cache sizes after limiting: blocks=${blockCache.size}, txs=${txCache.size}`);
}

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
    const blockCacheEfficiency = blockCacheHits + blockCacheMisses > 0 
        ? blockCacheHits / (blockCacheHits + blockCacheMisses) 
        : 0;
        
    const txCacheEfficiency = txCacheHits + txCacheMisses > 0 
        ? txCacheHits / (txCacheHits + txCacheMisses) 
        : 0;
    
    return {
        blockCache: {
            size: blockCache.size,
            hits: blockCacheHits,
            misses: blockCacheMisses,
            efficiency: blockCacheEfficiency.toFixed(2)
        },
        txCache: {
            size: txCache.size,
            hits: txCacheHits,
            misses: txCacheMisses,
            efficiency: txCacheEfficiency.toFixed(2)
        }
    };
}

/**
 * Improved error handling for RPC requests with detailed error logging
 * @param {Object} request RPC request details
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @param {number} timeout Request timeout in milliseconds
 * @returns {Promise<any>} Response data
 */
async function makeRpcRequestWithTimeout(request, primaryRpc, fallbackRpc, timeout = 10000) {
    const payload = {
        jsonrpc: '2.0',
        id: 1,
        ...request
    };
    
    // Track request metrics
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(2, 10);
    
    try {
        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`RPC request timed out after ${timeout}ms`)), timeout);
        });
        
        // Create the actual request promise
        const requestPromise = axios.post(primaryRpc, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Race between the request and the timeout
        const response = await Promise.race([requestPromise, timeoutPromise]);
        
        // Calculate response time
        const responseTime = Date.now() - startTime;
        
        // Log detailed metrics for slow responses
        if (responseTime > 1000) {
            console.log(`Slow RPC response [${requestId}]: ${responseTime}ms method=${request.method} params=${JSON.stringify(request.params)}`);
        }
        
        if (response.data.error) {
            throw new Error(`RPC error: ${response.data.error.message || JSON.stringify(response.data.error)}`);
        }
        
        return response.data.result;
    } catch (primaryError) {
        // Detailed error logging
        let errorType = 'unknown';
        if (primaryError.code === 'ECONNABORTED' || primaryError.message.includes('timeout')) {
            errorType = 'timeout';
        } else if (primaryError.response) {
            errorType = `http_${primaryError.response.status}`;
        } else if (primaryError.request) {
            errorType = 'no_response';
        } else if (primaryError.message.includes('RPC error')) {
            errorType = 'rpc_error';
        }
        
        console.log(`Primary RPC error [${requestId}]: ${errorType} - ${primaryError.message}`);
        console.log(`Trying fallback RPC for request [${requestId}]...`);
        
        try {
            // Create a new timeout promise for fallback
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Fallback RPC request timed out after ${timeout}ms`)), timeout);
            });
            
            // Create the fallback request promise
            const requestPromise = axios.post(fallbackRpc, payload, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            // Race between the fallback request and the timeout
            const response = await Promise.race([requestPromise, timeoutPromise]);
            
            // Calculate response time for fallback
            const fallbackResponseTime = Date.now() - startTime;
            console.log(`Fallback RPC response [${requestId}]: ${fallbackResponseTime}ms`);
            
            if (response.data.error) {
                throw new Error(`Fallback RPC error: ${response.data.error.message || JSON.stringify(response.data.error)}`);
            }
            
            return response.data.result;
        } catch (fallbackError) {
            // Log detailed fallback error
            let fallbackErrorType = 'unknown';
            if (fallbackError.code === 'ECONNABORTED' || fallbackError.message.includes('timeout')) {
                fallbackErrorType = 'timeout';
            } else if (fallbackError.response) {
                fallbackErrorType = `http_${fallbackError.response.status}`;
            } else if (fallbackError.request) {
                fallbackErrorType = 'no_response';
            } else if (fallbackError.message.includes('RPC error')) {
                fallbackErrorType = 'rpc_error';
            }
            
            console.error(`Fallback RPC also failed [${requestId}]: ${fallbackErrorType} - ${fallbackError.message}`);
            
            // Enhanced error for better debugging
            const enhancedError = new Error(`Both primary and fallback RPC requests failed: ${primaryError.message} | ${fallbackError.message}`);
            enhancedError.primaryError = primaryError;
            enhancedError.fallbackError = fallbackError;
            enhancedError.requestData = {
                method: request.method,
                params: request.params
            };
            
            throw enhancedError;
        }
    }
}

/*
 // Commented Out: Fetch voting events using trace_filter with optimized batching
async function fetchVotingWithTraceFilter(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc, batchSize) {
    const proxyAddress = ethers.getAddress(addresses[0].toLowerCase());
    const implAddress = ethers.getAddress(addresses[1].toLowerCase());
    
    let allResults = [];
    let activePromises = [];
    let processedResults = 0;
    
    // Create batches
    const batches = [];
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, toBlock);
        batches.push({ start, end });
    }
    
    console.log(`Processing ${batches.length} batches...`);
    const totalBatches = batches.length;
    
    // Process batches with concurrency control
    for (let i = 0; i < batches.length; i++) {
        const { start, end } = batches[i];
        
        // Create a promise for this batch
        const batchPromise = (async () => {
            try {
                const batchResults = await processSingleBatchWithTraceFilter(
                    start, end, proxyAddress, implAddress, primaryRpc, fallbackRpc
                );
                
                processedResults++;
                if (processedResults % 5 === 0 || processedResults === totalBatches) {
                    console.log(`Processed ${processedResults}/${totalBatches} batches (${Math.round(processedResults/totalBatches*100)}%)`);
                }
                
                return batchResults;
            } catch (error) {
                console.error(`Error processing batch ${start}-${end}:`, error.message);
                return []; // Return empty array on error to continue processing
            }
        })();
        
        activePromises.push(batchPromise);
        
        // Wait for some promises to complete if we hit concurrency limit
        if (activePromises.length >= MAX_CONCURRENT_BATCHES || i === batches.length - 1) {
            const batchResults = await Promise.all(activePromises);
            
            // Flatten and add to results
            for (const results of batchResults) {
                allResults = allResults.concat(results);
            }
            
            // Reset active promises
            activePromises = [];
            
            // Throttle to avoid overwhelming the node
            await sleep(REQUEST_THROTTLE_MS);
        }
    }
    
    console.log(`Found ${allResults.length} voting transactions with trace_filter`);
    return allResults;
}
*/

/**
 * Fallback method using block scanning with optimized batching
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress]
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @param {number} batchSize Size of each block batch
 * @returns {Promise<Array>} Array of voting events
 */
async function fetchVotingWithBlockScan(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc, batchSize) {
    const proxyAddress = ethers.getAddress(addresses[0].toLowerCase());
    
    // Create provider
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    let allResults = [];
    let activePromises = [];
    let processedResults = 0;
    
    // Create batches
    const batches = [];
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, toBlock);
        batches.push({ start, end });
    }
    
    console.log(`Processing ${batches.length} block scan batches...`);
    const totalBatches = batches.length;
    
    // Process batches with concurrency control
    for (let i = 0; i < batches.length; i++) {
        const { start, end } = batches[i];
        
        // Create a promise for this batch
        const batchPromise = (async () => {
            try {
                const batchResults = await processSingleBatchWithBlockScan(
                    start, end, proxyAddress, provider
                );
                
                processedResults++;
                if (processedResults % 5 === 0 || processedResults === totalBatches) {
                    console.log(`Processed ${processedResults}/${totalBatches} block scan batches (${Math.round(processedResults/totalBatches*100)}%)`);
                }
                
                return batchResults;
            } catch (error) {
                console.error(`Error processing block scan batch ${start}-${end}:`, error.message);
                return []; // Return empty array on error to continue processing
            }
        })();
        
        activePromises.push(batchPromise);
        
        // Wait for some promises to complete if we hit concurrency limit
        if (activePromises.length >= MAX_CONCURRENT_BATCHES || i === batches.length - 1) {
            const batchResults = await Promise.all(activePromises);
            
            // Flatten and add to results
            for (const results of batchResults) {
                allResults = allResults.concat(results);
            }
            
            // Reset active promises
            activePromises = [];
            
            // Throttle to avoid overwhelming the node
            await sleep(REQUEST_THROTTLE_MS);
        }
    }
    
    console.log(`Found ${allResults.length} voting transactions with block scanning`);
    return allResults;
}

/**
 * Process a single batch with block scanning
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {string} proxyAddress Proxy contract address
 * @param {ethers.Provider} provider Ethers provider
 * @returns {Promise<Array>} Array of processed transactions
 */
async function processSingleBatchWithBlockScan(fromBlock, toBlock, proxyAddress, provider) {
    const results = [];
    
    // Process in smaller sub-batches to avoid overwhelming the node
    const SUB_BATCH_SIZE = 10;
    
    for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += SUB_BATCH_SIZE) {
        const endBlock = Math.min(currentBlock + SUB_BATCH_SIZE - 1, toBlock);
        
        // Get blocks in parallel
        const blockPromises = [];
        for (let blockNum = currentBlock; blockNum <= endBlock; blockNum++) {
            // Check cache first
            if (blockCache.has(blockNum)) {
                blockCacheHits++;
                blockPromises.push(Promise.resolve(blockCache.get(blockNum)));
            } else {
                blockCacheMisses++;
                blockPromises.push(
                    (async () => {
                        try {
                            // Set up timeout for block retrieval
                            const timeoutPromise = new Promise((_, reject) => {
                                setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNum}`)), 10000);
                            });
                            
                            const blockPromise = provider.getBlock(blockNum, true);
                            const block = await Promise.race([blockPromise, timeoutPromise]);
                            
                            if (block) {
                                blockCache.set(blockNum, block);
                            }
                            return block;
                        } catch (error) {
                            console.error(`Error getting block ${blockNum}:`, error.message);
                            return null;
                        }
                    })()
                );
            }
        }
        
        const blocks = await Promise.all(blockPromises);
        
        // Process blocks and find transactions to proxy
        for (const block of blocks) {
            if (!block || !block.transactions) continue;
            
            // Filter for transactions that might be votes
            const potentialVoteTxs = block.transactions.filter(tx => 
                typeof tx === 'object' && tx.to && 
                tx.to.toLowerCase() === proxyAddress.toLowerCase() && 
                tx.value > 0n
            );
            
            // Process each potential vote transaction
            for (const tx of potentialVoteTxs) {
                try {
                    // Check if in cache first
                    if (txCache.has(tx.hash)) {
                        txCacheHits++;
                        const cached = txCache.get(tx.hash);
                        if (cached.success) {
                            results.push(cached);
                        }
                        continue;
                    }
                    
                    txCacheMisses++;
                    
                    // Check receipt status with timeout
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error(`Receipt retrieval timed out for tx ${tx.hash}`)), 10000);
                    });
                    
                    const receiptPromise = provider.getTransactionReceipt(tx.hash);
                    const receipt = await Promise.race([receiptPromise, timeoutPromise]);
                    
                    if (receipt && receipt.status) {
                        const result = {
                            transactionHash: tx.hash,
                            blockNumber: Number(block.number),
                            from: tx.from,
                            to: tx.to,
                            value: Number(tx.value), // Convert BigInt to Number
                            voteAmount: Number(ethers.formatEther(tx.value)), // Convert to SEI amount
                            timestamp: new Date(Number(block.timestamp) * 1000),
                            success: true,
                            isVotingTransaction: true
                        };
                        
                        // Cache the result
                        txCache.set(tx.hash, result);
                        results.push(result);
                    }
                } catch (txError) {
                    console.error(`Error processing tx ${tx.hash}:`, txError.message);
                }
            }
        }
        
        // Add a small delay between sub-batches
        await sleep(10);
    }
    
    return results;
}

/**
 * Listen for new votes in real-time
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
    const MAX_RECONNECT_ATTEMPTS = 5;
    
    // Try to connect using WebSocket first for more efficient real-time updates
    const connectWebSocket = () => {
        try {
            // Use the correct WebSocket URL (don't attempt to convert from HTTP URL)
            const wsUrl = 'wss://evm-ws.sei.basementnodes.ca';
            console.log(`Attempting WebSocket connection to ${wsUrl}...`);
            
            provider = new ethers.WebSocketProvider(wsUrl);
            
            // Set up event handlers
            provider._websocket.on('open', () => {
                console.log('WebSocket connection established');
                reconnectAttempts = 0;
            });
            
            provider._websocket.on('error', (error) => {
                console.error('WebSocket error:', error.message);
            });
            
            provider._websocket.on('close', (code, reason) => {
                console.log(`WebSocket connection closed: ${code} - ${reason}`);
                if (running && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    setTimeout(connectWebSocket, 5000 * Math.pow(2, reconnectAttempts - 1)); // Exponential backoff
                } else if (running) {
                    console.log('Max reconnect attempts reached, falling back to polling');
                    fallbackToPolling();
                }
            });
            
            // Subscribe to new blocks
            provider.on('block', async (blockNumber) => {
                try {
                    if (blockNumber > currentBlock) {
                        console.log(`New block detected: ${blockNumber}`);
                        
                        // Fetch votes
                        const newVotes = await fetchVotingEvents(
                            currentBlock + 1,
                            blockNumber,
                            addresses,
                            primaryRpc,
                            fallbackRpc,
                            false // Live mode
                        );
                        
                        // Process each vote
                        for (const vote of newVotes) {
                            callback(vote);
                        }
                        
                        // Update current block
                        currentBlock = blockNumber;
                    }
                } catch (error) {
                    console.error('Error processing new block:', error);
                }
            });
            
            return true;
        } catch (error) {
            console.log(`WebSocket connection failed: ${error.message}`);
            return false;
        }
    };
    
    // Fall back to polling if WebSocket fails
    const fallbackToPolling = () => {
        console.log('Using polling method for vote monitoring');
        provider = new ethers.JsonRpcProvider(primaryRpc);
        
        // Start polling loop
        const pollInterval = async () => {
            try {
                if (!running) return;
                
                const latestBlock = await provider.getBlockNumber();
                
                // Check if we have new blocks to process
                if (latestBlock > currentBlock) {
                    console.log(`Checking for new votes in blocks ${currentBlock + 1} to ${latestBlock}`);
                    
                    // Fetch votes
                    const newVotes = await fetchVotingEvents(
                        currentBlock + 1,
                        latestBlock,
                        addresses,
                        primaryRpc,
                        fallbackRpc,
                        false // Live mode
                    );
                    
                    // Process each vote
                    for (const vote of newVotes) {
                        callback(vote);
                    }
                    
                    // Update current block
                    currentBlock = latestBlock;
                }
                
                // Schedule next poll
                setTimeout(pollInterval, 2000); // Poll every 2 seconds
            } catch (error) {
                console.error('Error in vote polling:', error);
                // Try again after a short delay with exponential backoff
                const delay = Math.min(30000, 2000 * Math.pow(2, reconnectAttempts));
                reconnectAttempts++;
                console.log(`Retrying in ${delay/1000} seconds (attempt ${reconnectAttempts})...`);
                setTimeout(pollInterval, delay);
            }
        };
        
        // Start initial poll
        pollInterval();
    };
    
    // First try WebSocket, fall back to polling if it fails
    const wsSuccess = connectWebSocket();
    if (!wsSuccess) {
        fallbackToPolling();
    }
    
    // Return control object
    return {
        stop: () => {
            running = false;
            if (provider) {
                if (provider instanceof ethers.WebSocketProvider && provider._websocket) {
                    provider._websocket.close();
                } else if (typeof provider.destroy === 'function') {
                    provider.destroy();
                }
            }
        }
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
        txCacheHits++;
        return txCache.get(txHash);
    }
    
    txCacheMisses++;
    
    return await retry(async () => {
        let provider;
        
        try {
            provider = new ethers.JsonRpcProvider(primaryRpc);
        } catch (primaryError) {
            console.log(`Primary RPC failed: ${primaryError.message}`);
            provider = new ethers.JsonRpcProvider(fallbackRpc);
        }
        
        try {
            // Set timeout for transaction retrieval
            const txPromise = provider.getTransaction(txHash);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Transaction retrieval timed out for ${txHash}`)), 10000);
            });
            
            // Get transaction data with timeout
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
                    setTimeout(() => reject(new Error(`Receipt retrieval timed out for ${txHash}`)), 10000);
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
                blockCacheHits++;
                block = blockCache.get(blockNumber);
            } else {
                blockCacheMisses++;
                const blockPromise = provider.getBlock(blockNumber);
                
                block = await Promise.race([
                    blockPromise,
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error(`Block retrieval timed out for block ${blockNumber}`)), 10000);
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
            
            // Check if this is a voting transaction (if addresses are provided)
            let isVotingTransaction = true;
            if (addresses.length > 0) {
                const proxyAddress = addresses[0].toLowerCase();
                isVotingTransaction = tx.to && tx.to.toLowerCase() === proxyAddress && tx.value > 0n;
            }
            
            const details = {
                hash: tx.hash,
                blockNumber: blockNumber,
                from: tx.from,
                to: tx.to,
                value: Number(tx.value), // Convert BigInt to Number
                voteAmount: Number(ethers.formatEther(tx.value)), // Convert to SEI amount
                timestamp: new Date(Number(block.timestamp) * 1000),
                success: receipt.status === 1,
                isVotingTransaction
            };
            
            // Cache the result
            txCache.set(txHash, details);
            
            return details;
        } catch (error) {
            console.error(`Error getting transaction details for ${txHash}:`, error.message);
            return null;
        }
    }, 3, 1000); // Retry up to 3 times with 1s initial delay
}
