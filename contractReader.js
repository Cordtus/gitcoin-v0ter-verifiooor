import axios from 'axios';
import { fetchLogs } from 'sei-logs-wrapper';
import { ethers } from 'ethers';

/**
 * Makes an API request with fallback support
 * @param {Object} options Request options
 * @param {string} primaryUrl Primary API URL
 * @param {string} fallbackUrl Fallback API URL
 * @returns {Promise<Object>} API response
 */
async function makeRequestWithFallback(options, primaryUrl, fallbackUrl) {
    try {
        const response = await axios({
            ...options,
            url: primaryUrl
        });
        return response;
    } catch (error) {
        console.log(`Request to primary endpoint failed: ${error.message}`);
        console.log(`Trying fallback endpoint: ${fallbackUrl}`);
        
        try {
            const response = await axios({
                ...options,
                url: fallbackUrl
            });
            return response;
        } catch (fallbackError) {
            console.error(`Fallback request also failed: ${fallbackError.message}`);
            throw fallbackError;
        }
    }
}

/**
 * Makes a JSON-RPC request with fallback support
 * @param {string} method RPC method
 * @param {Array} params RPC parameters
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<any>} RPC response
 */
async function rpcRequestWithFallback(method, params, primaryRpc, fallbackRpc) {
    const options = {
        method: 'POST',
        data: {
            jsonrpc: '2.0',
            id: 1,
            method,
            params
        },
        headers: {
            'Content-Type': 'application/json'
        }
    };
    
    const response = await makeRequestWithFallback(options, primaryRpc, fallbackRpc);
    return response.data.result;
}

/**
 * Estimate block height for a given date
 * @param {Date} date Target date
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Estimated block height
 */
async function estimateBlockHeight(date, primaryRpc, fallbackRpc) {
    try {
        // Get current block info
        const currentBlockHex = await rpcRequestWithFallback(
            'eth_blockNumber', 
            [], 
            primaryRpc, 
            fallbackRpc
        );
        
        const currentBlock = parseInt(currentBlockHex, 16);
        
        // Current timestamp
        const now = new Date();
        
        // SEI block time is approximately 400ms
        const BLOCK_TIME_MS = 400;
        
        // Calculate time difference in milliseconds
        const timeDiffMs = date.getTime() - now.getTime();
        
        // Estimate block difference
        const blockDiff = Math.floor(timeDiffMs / BLOCK_TIME_MS);
        
        // Calculate target block
        return Math.max(0, currentBlock + blockDiff); // Ensure we don't go below 0
    } catch (error) {
        console.error('Error estimating block height:', error.message);
        throw error;
    }
}

/**
 * Get current block height
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Current block height
 */
async function getCurrentBlockHeight(primaryRpc, fallbackRpc) {
    try {
        const currentBlockHex = await rpcRequestWithFallback(
            'eth_blockNumber',
            [],
            primaryRpc,
            fallbackRpc
        );
        
        return parseInt(currentBlockHex, 16);
    } catch (error) {
        console.error('Error getting current block height:', error.message);
        throw error;
    }
}

/**
 * Get block details by number
 * @param {number} blockNumber Block number
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Object>} Block details
 */
async function getBlockByNumber(blockNumber, primaryRpc, fallbackRpc) {
    try {
        const blockHex = `0x${blockNumber.toString(16)}`;
        
        const block = await rpcRequestWithFallback(
            'eth_getBlockByNumber',
            [blockHex, false],
            primaryRpc,
            fallbackRpc
        );
        
        return block;
    } catch (error) {
        console.error(`Error getting block ${blockNumber}:`, error.message);
        throw error;
    }
}

/**
 * Fetch voting events from logs with fallback
 * @param {number} fromBlock Start block
 * @param {number} toBlock End block
 * @param {Array<string>} addresses Contract addresses to monitor
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Array>} Event logs
 */
async function fetchVotingEvents(fromBlock, toBlock, addresses, primaryRpc, fallbackRpc) {
    const filter = {
        fromBlock: fromBlock,  // sei-logs-wrapper handles conversion
        toBlock: toBlock,      // sei-logs-wrapper handles conversion
        address: addresses
    };
    
    try {
        console.log(`Fetching logs from block ${fromBlock} to ${toBlock}...`);
        
        try {
            // Try primary node first
            const logs = await fetchLogs(filter, primaryRpc, 'eth_getLogs');
            console.log(`Found ${logs.length} logs using primary node`);
            return logs;
        } catch (primaryError) {
            console.log(`Primary node failed: ${primaryError.message}`);
            console.log('Trying archive node...');
            
            // If primary fails, use archive node
            const logs = await fetchLogs(filter, fallbackRpc, 'eth_getLogs');
            console.log(`Found ${logs.length} logs using archive node`);
            return logs;
        }
    } catch (error) {
        console.error('Error fetching logs from both nodes:', error.message);
        throw error;
    }
}

/**
 * Get transaction details with fallback
 * @param {string} txHash Transaction hash
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Object|null>} Transaction details or null
 */
async function getTransactionDetails(txHash, primaryRpc, fallbackRpc) {
    try {
        // Get transaction
        const tx = await rpcRequestWithFallback(
            'eth_getTransactionByHash',
            [txHash],
            primaryRpc,
            fallbackRpc
        );
        
        if (!tx) {
            console.error(`Transaction ${txHash} not found`);
            return null;
        }
        
        // Get receipt
        const receipt = await rpcRequestWithFallback(
            'eth_getTransactionReceipt',
            [txHash],
            primaryRpc,
            fallbackRpc
        );
        
        if (!receipt || receipt.status !== '0x1') {
            return null; // Transaction failed
        }
        
        // Get block
        const block = await getBlockByNumber(
            parseInt(tx.blockNumber, 16),
            primaryRpc,
            fallbackRpc
        );
        
        // Check if this is a voting transaction (has value)
        const value = ethers.BigNumber.from(tx.value);
        const isVotingTransaction = !value.isZero();
        
        return {
            hash: txHash,
            blockNumber: parseInt(tx.blockNumber, 16),
            blockHash: tx.blockHash,
            from: tx.from.toLowerCase(),
            to: tx.to.toLowerCase(),
            value: ethers.utils.formatEther(tx.value),
            timestamp: new Date(parseInt(block.timestamp, 16) * 1000),
            success: receipt.status === '0x1',
            isVotingTransaction
        };
    } catch (error) {
        console.error(`Error getting transaction details for ${txHash}:`, error.message);
        return null;
    }
}

/**
 * Get transaction receipt with fallback
 * @param {string} txHash Transaction hash
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Object|null>} Transaction receipt or null
 */
async function getTransactionReceipt(txHash, primaryRpc, fallbackRpc) {
    try {
        const receipt = await rpcRequestWithFallback(
            'eth_getTransactionReceipt',
            [txHash],
            primaryRpc,
            fallbackRpc
        );
        
        return receipt;
    } catch (error) {
        console.error(`Error getting transaction receipt for ${txHash}:`, error.message);
        return null;
    }
}

export {
    estimateBlockHeight,
    getCurrentBlockHeight,
    getBlockByNumber,
    fetchVotingEvents,
    getTransactionDetails,
    getTransactionReceipt,
    rpcRequestWithFallback
};
