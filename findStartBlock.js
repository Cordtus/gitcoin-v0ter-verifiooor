import axios from 'axios';

/**
 * Find the exact block number for a target date
 * @param {Date} targetDate The target date to find the block for
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Block number
 */
export async function findStartBlock(targetDate, primaryRpc, fallbackRpc) {
    try {
        console.log(`Finding exact block for date: ${targetDate.toISOString()}`);
        
        // Get current block and its timestamp
        const currentBlock = await getCurrentBlock(primaryRpc, fallbackRpc);
        const currentBlockData = await getBlockByNumber(currentBlock, primaryRpc, fallbackRpc);
        const currentTimestamp = new Date(parseInt(currentBlockData.timestamp, 16) * 1000);
        
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
            const blockData = await getBlockByNumber(midBlock, primaryRpc, fallbackRpc);
            const blockTimestamp = new Date(parseInt(blockData.timestamp, 16) * 1000);
            
            console.log(`Checking block ${midBlock}, timestamp: ${blockTimestamp.toISOString()}`);
            
            // If we're within 1 minute of the target, consider it found
            const diffMs = Math.abs(blockTimestamp.getTime() - targetDate.getTime());
            if (diffMs < 60000) {
                console.log(`Found closest block: ${midBlock}`);
                
                // Refine further to get exact block
                return findExactBlockNearTarget(midBlock, targetDate, primaryRpc, fallbackRpc);
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
 * @param {number} approximateBlock Approximate block near the target time
 * @param {Date} targetDate Target date
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Exact block number
 */
async function findExactBlockNearTarget(approximateBlock, targetDate, primaryRpc, fallbackRpc) {
    let currentBlock = approximateBlock;
    let blockData = await getBlockByNumber(currentBlock, primaryRpc, fallbackRpc);
    let blockTimestamp = new Date(parseInt(blockData.timestamp, 16) * 1000);
    
    // If before target date, move forward to find first block after target
    if (blockTimestamp.getTime() < targetDate.getTime()) {
        while (blockTimestamp.getTime() < targetDate.getTime()) {
            currentBlock++;
            blockData = await getBlockByNumber(currentBlock, primaryRpc, fallbackRpc);
            blockTimestamp = new Date(parseInt(blockData.timestamp, 16) * 1000);
        }
        return currentBlock;
    } 
    // If after target date, move backward to find last block before target
    else {
        while (blockTimestamp.getTime() >= targetDate.getTime() && currentBlock > 0) {
            currentBlock--;
            blockData = await getBlockByNumber(currentBlock, primaryRpc, fallbackRpc);
            blockTimestamp = new Date(parseInt(blockData.timestamp, 16) * 1000);
        }
        // Return the block right after the last block before target
        return currentBlock + 1;
    }
}

/**
 * Get current block number
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<number>} Current block number
 */
async function getCurrentBlock(primaryRpc, fallbackRpc) {
    try {
        const response = await makeRpcRequest(
            { method: 'eth_blockNumber', params: [] },
            primaryRpc,
            fallbackRpc
        );
        return parseInt(response, 16);
    } catch (error) {
        console.error('Error getting current block:', error.message);
        throw error;
    }
}

/**
 * Get block data by number
 * @param {number} blockNumber Block number
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<Object>} Block data
 */
async function getBlockByNumber(blockNumber, primaryRpc, fallbackRpc) {
    try {
        const blockHex = `0x${blockNumber.toString(16)}`;
        return await makeRpcRequest(
            { method: 'eth_getBlockByNumber', params: [blockHex, false] },
            primaryRpc,
            fallbackRpc
        );
    } catch (error) {
        console.error(`Error getting block ${blockNumber}:`, error.message);
        throw error;
    }
}

/**
 * Make RPC request with fallback
 * @param {Object} request RPC request
 * @param {string} primaryRpc Primary RPC endpoint
 * @param {string} fallbackRpc Fallback RPC endpoint
 * @returns {Promise<any>} RPC response
 */
async function makeRpcRequest(request, primaryRpc, fallbackRpc) {
    const payload = {
        jsonrpc: '2.0',
        id: 1,
        ...request
    };
    
    try {
        const response = await axios.post(primaryRpc, payload);
        return response.data.result;
    } catch (primaryError) {
        console.log(`Primary RPC failed: ${primaryError.message}`);
        console.log('Trying fallback RPC...');
        
        try {
            const response = await axios.post(fallbackRpc, payload);
            return response.data.result;
        } catch (fallbackError) {
            console.error(`Fallback RPC also failed: ${fallbackError.message}`);
            throw fallbackError;
        }
    }
}
