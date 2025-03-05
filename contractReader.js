// contractReader.js

import { ethers } from 'ethers';
import axios from 'axios';

/**
 * Get current block height
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Current block height
 */
export async function getCurrentBlockHeight(primaryRpc, fallbackRpc) {
    try {
        const provider = new ethers.JsonRpcProvider(primaryRpc);
        return await provider.getBlockNumber();
    } catch (error) {
        console.error('Primary RPC failed, trying fallback:', error.message);
        const provider = new ethers.JsonRpcProvider(fallbackRpc);
        return await provider.getBlockNumber();
    }
}

/**
 * Fetch voting events using best available method
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress]
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Array>} Array of voting events
 */
export async function fetchVotingEvents(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc) {
    console.log(`Fetching voting transactions from block ${fromBlock} to ${toBlock}`);
    
    // Try trace_filter first (most efficient)
    try {
        return await fetchVotingWithTraceFilter(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc);
    } catch (error) {
        console.log(`trace_filter failed: ${error.message}`);
        console.log('Falling back to block scanning method');
        return await fetchVotingWithBlockScan(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc);
    }
}

/**
 * Fetch voting events using trace_filter
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress]
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Array>} Array of voting events
 */
async function fetchVotingWithTraceFilter(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc) {
    const proxyAddress = ethers.getAddress(addresses[0].toLowerCase());
    const implAddress = ethers.getAddress(addresses[1].toLowerCase());
    
    const traceFilterPayload = {
        jsonrpc: "2.0",
        id: 1,
        method: "trace_filter",
        params: [{
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
            fromAddress: [proxyAddress],
            toAddress: [implAddress],
            after: 0,
            count: 10000
        }]
    };
    
    let response, rpcUrl;
    
    try {
        // Try primary RPC first
        rpcUrl = primaryRpc;
        response = await axios.post(primaryRpc, traceFilterPayload);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        console.log('Trying fallback RPC...');
        
        // Try fallback RPC
        rpcUrl = fallbackRpc;
        response = await axios.post(fallbackRpc, traceFilterPayload);
    }
    
    if (response.data.error) {
        throw new Error(`RPC error: ${response.data.error.message}`);
    }
    
    // Process and return results
    const traces = response.data.result;
    console.log(`Found ${traces.length} voting transactions with trace_filter`);
    
    // Get provider for block and transaction details
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Process traces in batches to avoid overwhelming the provider
    const BATCH_SIZE = 20;
    let results = [];
    
    for (let i = 0; i < traces.length; i += BATCH_SIZE) {
        const batch = traces.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (trace) => {
            try {
                const blockNumber = parseInt(trace.blockNumber, 16);
                
                // Get transaction to find original sender
                const tx = await provider.getTransaction(trace.transactionHash);
                // Get block for timestamp
                const block = await provider.getBlock(blockNumber);
                
                if (!tx || !block) return null;
                
                return {
                    transactionHash: trace.transactionHash,
                    blockNumber: blockNumber,
                    from: tx.from, // Original sender of the transaction
                    to: tx.to, // The proxy address
                    value: parseInt(trace.action.value, 16), // Value in wei
                    timestamp: new Date(Number(block.timestamp) * 1000),
                    success: true,
                    isVotingTransaction: true
                };
            } catch (error) {
                console.error(`Error processing trace ${trace.transactionHash}:`, error.message);
                return null;
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results = results.concat(batchResults.filter(r => r !== null));
    }
    
    return results;
}

/**
 * Fallback method if trace_filter isn't available
 * @param {number} fromBlock Starting block
 * @param {number} toBlock Ending block
 * @param {Array<string>} addresses Addresses to monitor [proxyAddress, implAddress]
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Array>} Array of voting events
 */
async function fetchVotingWithBlockScan(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc) {
    const proxyAddress = ethers.getAddress(addresses[0].toLowerCase());
    const results = [];
    
    let provider;
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (error) {
        console.log(`Primary RPC failed: ${error.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    // Process in batches to avoid overwhelming the node
    const BATCH_SIZE = 100;
    
    for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += BATCH_SIZE) {
        const endBlock = Math.min(currentBlock + BATCH_SIZE - 1, toBlock);
        console.log(`Scanning blocks ${currentBlock} to ${endBlock}`);
        
        for (let blockNum = currentBlock; blockNum <= endBlock; blockNum++) {
            try {
                // Get block with transactions
                const block = await provider.getBlock(blockNum, true);
                
                if (!block || !block.transactions) continue;
                
                // Filter transactions to the proxy with value > 0
                for (const txHash of block.transactions) {
                    try {
                        const tx = await provider.getTransaction(txHash);
                        
                        // Skip if not a transaction to proxy or has no value
                        if (!tx || !tx.to || 
                            tx.to.toLowerCase() !== proxyAddress.toLowerCase() || 
                            tx.value === 0n) {
                            continue;
                        }
                        
                        // Check if transaction was successful
                        const receipt = await provider.getTransactionReceipt(txHash);
                        
                        if (receipt && receipt.status) {
                            results.push({
                                transactionHash: tx.hash,
                                blockNumber: blockNum,
                                from: tx.from,
                                to: tx.to,
                                value: Number(tx.value), // Convert BigInt to Number
                                timestamp: new Date(Number(block.timestamp) * 1000),
                                success: true,
                                isVotingTransaction: true
                            });
                        }
                    } catch (txError) {
                        console.error(`Error processing tx ${txHash}:`, txError.message);
                    }
                }
            } catch (error) {
                console.error(`Error processing block ${blockNum}:`, error.message);
            }
        }
    }
    
    console.log(`Found ${results.length} voting transactions with block scanning`);
    return results;
}

/**
 * Get transaction details for a specific hash
 * @param {string} txHash Transaction hash
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Object>} Transaction details
 */
export async function getTransactionDetails(txHash, primaryRpc, fallbackRpc) {
    let provider;
    
    try {
        provider = new ethers.JsonRpcProvider(primaryRpc);
    } catch (primaryError) {
        console.log(`Primary RPC failed: ${primaryError.message}`);
        provider = new ethers.JsonRpcProvider(fallbackRpc);
    }
    
    try {
        // Get transaction data
        const tx = await provider.getTransaction(txHash);
        if (!tx) {
            console.log(`Transaction ${txHash} not found`);
            return null;
        }
        
        // Get receipt for status
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
            console.log(`Receipt for ${txHash} not found`);
            return null;
        }
        
        // Get block for timestamp
        const block = await provider.getBlock(tx.blockNumber);
        
        return {
            hash: tx.hash,
            blockNumber: Number(tx.blockNumber),
            from: tx.from,
            to: tx.to,
            value: Number(tx.value), // Convert BigInt to Number
            timestamp: new Date(Number(block.timestamp) * 1000),
            success: receipt.status === 1,
            isVotingTransaction: tx.to && tx.to.toLowerCase() === addresses[0].toLowerCase() && tx.value > 0n
        };
    } catch (error) {
        console.error(`Error getting transaction details for ${txHash}:`, error.message);
        return null;
    }
}

/**
 * Check if the primary node has the block data
 * @param {number} blockNumber Block to check
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<{hasBlock: boolean, useArchive: boolean}>} Result of check
 */
export async function checkBlockAvailability(blockNumber, primaryRpc, fallbackRpc) {
    try {
        console.log(`Checking if block ${blockNumber} is available on primary node...`);
        
        // Try primary provider
        try {
            const provider = new ethers.JsonRpcProvider(primaryRpc);
            const block = await provider.getBlock(blockNumber);
            
            if (block) {
                console.log(`Block ${blockNumber} is available on primary node`);
                return { hasBlock: true, useArchive: false };
            }
        } catch (error) {
            console.log(`Primary node failed for block check: ${error.message}`);
        }
        
        // Try archive provider
        try {
            const provider = new ethers.JsonRpcProvider(fallbackRpc);
            const block = await provider.getBlock(blockNumber);
            
            if (block) {
                console.log(`Block ${blockNumber} is available on archive node`);
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
}