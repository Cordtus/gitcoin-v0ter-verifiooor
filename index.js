// index.js - Main application entry point for SEI Voting Monitor

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

// Import configuration
import { 
  PROXY_ADDRESS, 
  IMPLEMENTATION_ADDRESS, 
  MIN_SEI_REQUIRED,
  VOTING_START_DATE,
  VOTING_END_DATE,
  RPC_ENDPOINTS,
  PATHS,
  BATCH,
  MEMORY
} from './config.js';

// Import functionality modules
import * as walletBalances from './walletBalances.js';
import { scanBlockRangeForVotes, clearCaches } from './blockScanner.js';
import { findStartBlock } from './findStartBlock.js';
import { monitorForVotes, saveMonitorCheckpoint, loadMonitorCheckpoint } from './realTimeMonitor.js';
import { generateReport } from './generateReport.js';
import { 
  startMemoryMonitoring, 
  stopMemoryMonitoring,
  manageMemory,
  getMemoryUsage
} from './memoryManager.js';
import { 
  sleep, 
  ensureDirectoryExists 
} from './utils.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Runtime state
let isRunning = true;
let isProcessingHistorical = false;
let lastCheckpointTime = Date.now();
let voteListener = null;
let pendingVotes = [];
let processingPromise = null;

// Ensure data directory exists
ensureDirectoryExists(PATHS.DATA_DIR);

/**
 * Load the last processed block
 * @returns {number} The last processed block
 */
function loadLastProcessedBlock() {
    try {
        if (fs.existsSync(PATHS.LAST_BLOCK_FILE)) {
            return parseInt(fs.readFileSync(PATHS.LAST_BLOCK_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading last processed block:', error);
    }
    return 0;
}

/**
 * Save the last processed block
 * @param {number} blockNumber The block number to save
 */
function saveLastProcessedBlock(blockNumber) {
    try {
        fs.writeFileSync(PATHS.LAST_BLOCK_FILE, blockNumber.toString(), 'utf8');
        console.log(`Last processed block saved: ${blockNumber}`);
        lastCheckpointTime = Date.now();
    } catch (error) {
        console.error('Error saving last processed block:', error);
    }
}

/**
 * Check for process lock file
 * @returns {boolean} True if locked, false otherwise
 */
function isLocked() {
    return fs.existsSync(PATHS.LOCK_FILE);
}

/**
 * Create lock file
 */
function createLock() {
    try {
        fs.writeFileSync(PATHS.LOCK_FILE, Date.now().toString(), 'utf8');
    } catch (error) {
        console.error('Error creating lock file:', error);
    }
}

/**
 * Remove lock file
 */
function removeLock() {
    try {
        if (fs.existsSync(PATHS.LOCK_FILE)) {
            fs.unlinkSync(PATHS.LOCK_FILE);
        }
    } catch (error) {
        console.error('Error removing lock file:', error);
    }
}

/**
 * Process a batch of votes with optimized balance checks
 * @param {Array} votes Array of vote objects
 */
async function processBatchOfVotes(votes) {
    if (!votes || votes.length === 0) return;
    
    console.log(`Processing batch of ${votes.length} votes...`);
    
    // Process in smaller sub-batches for balance checks
    const subBatches = [];
    for (let i = 0; i < votes.length; i += BATCH.PARALLEL_BALANCE_CHECKS) {
        subBatches.push(votes.slice(i, i + BATCH.PARALLEL_BALANCE_CHECKS));
    }
    
    for (const subBatch of subBatches) {
        // Process each vote in parallel
        const votePromises = subBatch.map(async (vote) => {
            try {
                // Convert EVM address to Cosmos address
                const cosmosAddress = await walletBalances.convertEvmToCosmos(
                    vote.from,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.fallback.rest
                );
                
                // Check balance at vote and one block before
                const balanceAtVote = await walletBalances.getSeiBalance(
                    cosmosAddress, 
                    vote.blockNumber,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.fallback.rest,
                    RPC_ENDPOINTS.primary.evmRpc,
                    RPC_ENDPOINTS.fallback.evmRpc
                );
                
                const balanceBeforeVote = await walletBalances.getSeiBalance(
                    cosmosAddress, 
                    vote.blockNumber - 1,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.fallback.rest,
                    RPC_ENDPOINTS.primary.evmRpc,
                    RPC_ENDPOINTS.fallback.evmRpc
                );
                
                // Record vote information
                await walletBalances.recordVote(
                    vote.transactionHash,
                    vote.from,
                    cosmosAddress,
                    vote.blockNumber,
                    vote.timestamp,
                    balanceAtVote,
                    balanceBeforeVote,
                    MIN_SEI_REQUIRED,
                    PATHS.WALLETS_FILE,
                    PATHS.VOTES_FILE
                );
                
                console.log(`Processed vote: ${vote.transactionHash.substring(0, 10)}... from ${vote.from.substring(0, 8)}...`);
                console.log(`  Block: ${vote.blockNumber}, Balance: ${balanceAtVote} SEI, Previous: ${balanceBeforeVote} SEI`);
                
                return { success: true, txHash: vote.transactionHash };
            } catch (error) {
                console.error(`Error processing vote ${vote.transactionHash}:`, error.message);
                return { success: false, txHash: vote.transactionHash, error: error.message };
            }
        });
        
        await Promise.all(votePromises);
        
        // Add a small delay between sub-batches to avoid overwhelming APIs
        await sleep(BATCH.BALANCE_CHECK_THROTTLE_MS);
    }
}

/**
 * Process votes from the pending queue
 */
async function processPendingVotes() {
    if (processingPromise) {
        // Already processing
        return;
    }
    
    if (pendingVotes.length === 0) {
        // No pending votes
        return;
    }
    
    // Take votes from the queue
    const votesToProcess = [...pendingVotes];
    pendingVotes = [];
    
    // Process votes
    processingPromise = processBatchOfVotes(votesToProcess).finally(() => {
        processingPromise = null;
        
        // If more votes arrived during processing, process them
        if (pendingVotes.length > 0) {
            processPendingVotes();
        }
    });
}

/**
 * Handle a new vote
 * @param {Object} vote Vote object
 */
function handleNewVote(vote) {
    // Add to pending queue
    pendingVotes.push(vote);
    
    // Start processing if not already in progress
    if (!processingPromise) {
        processPendingVotes();
    }
    
    // Save checkpoint periodically
    const now = Date.now();
    if (now - lastCheckpointTime > BATCH.SAVE_CHECKPOINT_INTERVAL_MS) {
        saveLastProcessedBlock(vote.blockNumber);
    }
}

/**
 * Main function to track voting activity
 */
async function trackVotingActivity() {
    console.log('Starting SEI voting activity tracker...');
    console.log(`Current time: ${new Date().toISOString()}`);
    console.log(`Voting period: ${VOTING_START_DATE.toISOString()} to ${VOTING_END_DATE.toISOString()}`);

    // Check for lock
    if (isLocked()) {
        console.error('Another instance is already running. Exiting...');
        return false;
    }
    
    // Create lock
    createLock();

    try {
        // Setup memory management
        startMemoryMonitoring(60000, {
            warningThreshold: MEMORY.WARNING_THRESHOLD,
            criticalThreshold: MEMORY.CRITICAL_THRESHOLD,
            targetUsage: MEMORY.TARGET_USAGE,
            reportInterval: MEMORY.REPORT_INTERVAL
        });
        
        // Get starting block
        let fromBlock = loadLastProcessedBlock();
        if (fromBlock === 0) {
            // Find the exact block at the start of voting period
            fromBlock = await findStartBlock(
                VOTING_START_DATE,
                RPC_ENDPOINTS.primary.evmRpc,
                RPC_ENDPOINTS.fallback.evmRpc
            );
            console.log(`Found exact starting block: ${fromBlock}`);
            
            // Save this block as the starting point
            saveLastProcessedBlock(fromBlock);
        }

        // Get current block
        const provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.primary.evmRpc);
        let currentBlock;
        try {
            currentBlock = await provider.getBlockNumber();
        } catch (error) {
            console.error('Error getting current block from primary RPC:', error.message);
            const fallbackProvider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.fallback.evmRpc);
            currentBlock = await fallbackProvider.getBlockNumber();
        }
        console.log(`Current block: ${currentBlock}`);

        // Check if we have historical data to process
        if (fromBlock < currentBlock) {
            console.log(`Processing historical blocks from ${fromBlock} to ${currentBlock}...`);
            isProcessingHistorical = true;
            
            // Fetch historical voting events in optimized batches
            try {
                const events = await scanBlockRangeForVotes(
                    fromBlock, 
                    currentBlock, 
                    [PROXY_ADDRESS, IMPLEMENTATION_ADDRESS],
                    RPC_ENDPOINTS.primary.evmRpc,
                    RPC_ENDPOINTS.fallback.evmRpc,
                    null,
                    true
                );
                
                console.log(`Found ${events.length} historical voting transactions`);
                
                // Process in smaller batches
                const PROCESS_BATCH_SIZE = 100;
                for (let i = 0; i < events.length; i += PROCESS_BATCH_SIZE) {
                    const batch = events.slice(i, i + PROCESS_BATCH_SIZE);
                    await processBatchOfVotes(batch);
                    
                    // Update progress
                    const processedCount = i + batch.length;
                    console.log(`Processed ${processedCount}/${events.length} votes (${Math.round(processedCount/events.length*100)}%)`);
                    
                    // Save checkpoint periodically
                    if (batch.length > 0) {
                        const latestBlock = Math.max(...batch.map(event => event.blockNumber));
                        saveLastProcessedBlock(latestBlock);
                    }
                    
                    // Check memory usage and clear caches if needed
                    manageMemory();
                }
                
                // Update last processed block
                saveLastProcessedBlock(currentBlock);
                console.log('Historical data processing complete.');
            } catch (error) {
                console.error(`Error processing historical blocks ${fromBlock} to ${currentBlock}:`, error.message);
                isProcessingHistorical = false;
                return false;
            }
            
            isProcessingHistorical = false;
        }

        // Start live monitoring
        console.log('Starting live monitoring...');
        voteListener = monitorForVotes(
            currentBlock,
            [PROXY_ADDRESS, IMPLEMENTATION_ADDRESS],
            RPC_ENDPOINTS,
            handleNewVote,
            (blockNumber) => {
                // Block processed callback to periodically save checkpoint
                const now = Date.now();
                if (now - lastCheckpointTime > BATCH.SAVE_CHECKPOINT_INTERVAL_MS) {
                    saveLastProcessedBlock(blockNumber);
                }
            },
            VOTING_END_DATE
        );
        
        return true;
    } catch (error) {
        console.error('Error tracking voting activity:', error);
        removeLock();
        return false;
    }
}

/**
 * Generate final report
 */
async function generateFinalReport() {
    console.log('Voting period has ended. Generating final report...');
    
    // Get current block for final check
    let currentBlock;
    try {
        const provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.primary.evmRpc);
        currentBlock = await provider.getBlockNumber();
    } catch (error) {
        console.error('Error getting current block from primary RPC:', error.message);
        const fallbackProvider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.fallback.evmRpc);
        currentBlock = await fallbackProvider.getBlockNumber();
    }
    
    // Stop listening for new votes
    if (voteListener) {
        voteListener.stop();
        voteListener = null;
    }
    
    // Check final balances
    await walletBalances.checkFinalBalances(
        currentBlock,
        MIN_SEI_REQUIRED,
        PATHS.WALLETS_FILE,
        PATHS.VOTES_FILE,
        RPC_ENDPOINTS.primary.rest,
        RPC_ENDPOINTS.fallback.rest,
        RPC_ENDPOINTS.primary.evmRpc,
        RPC_ENDPOINTS.fallback.evmRpc
    );
    
    // Generate reports
    await generateReport();
    
    console.log('Final report generation complete.');
}

/**
 * Clean shutdown handler
 */
function cleanup() {
    console.log('\nShutting down gracefully...');
    isRunning = false;
    
    try {
      // Stop all services
      stopMemoryMonitoring();
      if (voteListener) voteListener.stop();
      
      // Process remaining votes
      if (pendingVotes.length > 0) {
        console.log(`Processing ${pendingVotes.length} remaining votes...`);
      }
      
      // Remove lock file
      removeLock();
      console.log('Cleanup complete');
    } catch (e) {
      console.error('Error during cleanup:', e);
    }
    
    // Force immediate exit
    process.exit(0);
  }
  
/**
 * Schedule periodic checks
 */
async function schedulePeriodicChecks() {
    try {
        // Trap exit signals
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        
        // Start monitoring
        const monitoringStarted = await trackVotingActivity();
        
        if (!monitoringStarted) {
            console.error('Failed to start monitoring. Exiting...');
            cleanup();
            return;
        }
        
        // Check if voting period is already over
        const now = new Date();
        if (now >= VOTING_END_DATE && isRunning) {
            await generateFinalReport();
            cleanup();
        }
    } catch (error) {
        console.error('Error in monitoring cycle:', error);
        cleanup();
    }
}

// Start the monitoring if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    schedulePeriodicChecks().catch(error => {
        console.error('Fatal error:', error);
        cleanup();
        process.exit(1);
    });
}

export {
    trackVotingActivity,
    schedulePeriodicChecks,
    cleanup
};