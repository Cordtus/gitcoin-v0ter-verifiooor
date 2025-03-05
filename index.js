// index.js

import * as contractReader from './contractReader.js';
import * as walletBalances from './walletBalances.js';
import { findStartBlock } from './findStartBlock.js';
import * as memoryManager from './memoryManager.js';
import { retry, sleep, formatDateUTC } from './utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();
const MIN_SEI_REQUIRED = 100; // 100 SEI

// Performance tuning
const MEMORY_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHED_BLOCKS = 5000;
const MAX_CACHED_TXS = 10000;
const PARALLEL_BALANCE_CHECKS = 20;
const BALANCE_CHECK_THROTTLE = 10; // ms between balance check batches
const SAVE_CHECKPOINT_INTERVAL = 5 * 60 * 1000; // 5 minutes

// RPC endpoints with fallback options
const RPC_ENDPOINTS = {
    primary: {
        rpc: 'https://rpc.sei.basementnodes.ca',
        rest: 'https://api.sei.basementnodes.ca',
        evmRpc: 'https://evm-rpc.sei.basementnodes.ca',
        evmWs: 'wss://evm-ws.sei.basementnodes.ca'  // Add WebSocket URL here
    },
    archive: {
        rpc: 'https://rpc.sei-main-eu.ccvalidators.com:443',
        rest: 'https://rest.sei-main-eu.ccvalidators.com:443',
        evmRpc: 'https://evm.sei-main-eu.ccvalidators.com:443',
        evmWs: 'wss://evm-ws.sei-main-eu.ccvalidators.com:443'  // Add archive WebSocket URL if available
    }
};

// Voting period
// Define times in MST
const VOTING_START_DATE_MST = new Date('2025/02/26 22:00 MST');
const VOTING_END_DATE_MST = new Date('2025/03/12 10:00 MST');

// Convert to UTC for blockchain querying (MST is UTC-7)
const VOTING_START_DATE = new Date('2025/02/27 05:00Z'); // UTC equivalent of MST start time
const VOTING_END_DATE = new Date('2025/03/12 17:00Z');   // UTC equivalent of MST end time

// Data storage
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const LAST_BLOCK_FILE = path.join(DATA_DIR, 'last_processed_block.txt');
const LOCK_FILE = path.join(DATA_DIR, 'monitor.lock');

// Runtime state
let isRunning = true;
let isProcessingHistorical = false;
let lastCheckpointTime = Date.now();
let voteListener = null;
let pendingVotes = [];
let processingPromise = null;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load the last processed block
 * @returns {number} The last processed block
 */
function loadLastProcessedBlock() {
    try {
        if (fs.existsSync(LAST_BLOCK_FILE)) {
            return parseInt(fs.readFileSync(LAST_BLOCK_FILE, 'utf8'));
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
        fs.writeFileSync(LAST_BLOCK_FILE, blockNumber.toString(), 'utf8');
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
    return fs.existsSync(LOCK_FILE);
}

/**
 * Create lock file
 */
function createLock() {
    try {
        fs.writeFileSync(LOCK_FILE, Date.now().toString(), 'utf8');
    } catch (error) {
        console.error('Error creating lock file:', error);
    }
}

/**
 * Remove lock file
 */
function removeLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        console.error('Error removing lock file:', error);
    }
}

/**
 * Periodic memory management to prevent OOM issues
 */
function setupMemoryManagement() {
    // Start the enhanced adaptive memory management
    memoryManager.startMemoryMonitoring(60000, {
        warningThreshold: 1024,  // 1GB
        criticalThreshold: 1536, // 1.5GB
        targetUsage: 768,        // 750MB
        reportInterval: 15 * 60 * 1000 // 15 minutes
    });
    
    // Schedule memory checks at key points in the process
    setInterval(() => {
        // Check memory usage and adapt cache sizes
        const memoryStatus = memoryManager.manageMemory();
        if (memoryStatus.action !== 'none' && memoryStatus.action !== 'report_only') {
            console.log(`Memory management action taken: ${memoryStatus.action}`);
        }
    }, MEMORY_CHECK_INTERVAL);
    
    // Log memory usage periodically
    console.log('Memory monitoring started');
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
    for (let i = 0; i < votes.length; i += PARALLEL_BALANCE_CHECKS) {
        subBatches.push(votes.slice(i, i + PARALLEL_BALANCE_CHECKS));
    }
    
    for (const subBatch of subBatches) {
        // Process each vote in parallel
        const votePromises = subBatch.map(async (vote) => {
            try {
                // Convert EVM address to Cosmos address
                const cosmosAddress = await walletBalances.convertEvmToCosmos(
                    vote.from,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.archive.rest
                );
                
                // Check balance at vote and one block before
                const balanceAtVote = await walletBalances.getSeiBalance(
                    cosmosAddress, 
                    vote.blockNumber,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.archive.rest
                );
                
                const balanceBeforeVote = await walletBalances.getSeiBalance(
                    cosmosAddress, 
                    vote.blockNumber - 1,
                    RPC_ENDPOINTS.primary.rest,
                    RPC_ENDPOINTS.archive.rest
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
                    WALLETS_FILE,
                    VOTES_FILE
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
        await sleep(BALANCE_CHECK_THROTTLE);
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
    if (now - lastCheckpointTime > SAVE_CHECKPOINT_INTERVAL) {
        saveLastProcessedBlock(vote.blockNumber);
    }
}

/**
 * Main function to track voting activity
 */
async function trackVotingActivity() {
    console.log('Starting SEI voting activity tracker...');
    console.log(`Current time: ${new Date().toISOString()}`);
    console.log(`Voting period in MST: ${VOTING_START_DATE_MST.toLocaleString()} to ${VOTING_END_DATE_MST.toLocaleString()}`);
    console.log(`Voting period in UTC: ${VOTING_START_DATE.toISOString()} to ${VOTING_END_DATE.toISOString()}`);

    // Check for lock
    if (isLocked()) {
        console.error('Another instance is already running. Exiting...');
        return false;
    }
    
    // Create lock
    createLock();

    try {
        // Setup memory management
        setupMemoryManagement();
        
        // Get starting block
        let fromBlock = loadLastProcessedBlock();
        if (fromBlock === 0) {
            // Find the exact block at the start of voting period
            fromBlock = await findStartBlock(
                VOTING_START_DATE,
                RPC_ENDPOINTS.primary.evmRpc,
                RPC_ENDPOINTS.archive.evmRpc
            );
            console.log(`Found exact starting block: ${fromBlock}`);
            
            // Save this block as the starting point
            saveLastProcessedBlock(fromBlock);
        }

        // Get current block
        const currentBlock = await contractReader.getCurrentBlockHeight(
            RPC_ENDPOINTS.primary.evmRpc, 
            RPC_ENDPOINTS.archive.evmRpc
        );
        console.log(`Current block: ${currentBlock}`);

        // Check if we have historical data to process
        if (fromBlock < currentBlock) {
            console.log(`Processing historical blocks from ${fromBlock} to ${currentBlock}...`);
            isProcessingHistorical = true;
            
            // Fetch historical voting events in optimized batches
            try {
                const events = await contractReader.fetchVotingEvents(
                    fromBlock, 
                    currentBlock, 
                    [PROXY_ADDRESS, IMPLEMENTATION_ADDRESS],
                    RPC_ENDPOINTS.primary.evmRpc,
                    RPC_ENDPOINTS.archive.evmRpc,
                    true // Initial historical fetch
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
        voteListener = contractReader.listenForVotes(
            currentBlock,
            [PROXY_ADDRESS, IMPLEMENTATION_ADDRESS],
            RPC_ENDPOINTS.primary.evmRpc,
            RPC_ENDPOINTS.archive.evmRpc,
            handleNewVote
        );
        
        // Check if voting period is over
        const now = new Date();
        if (now >= VOTING_END_DATE) {
            await generateFinalReport();
        }

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
    const currentBlock = await contractReader.getCurrentBlockHeight(
        RPC_ENDPOINTS.primary.evmRpc, 
        RPC_ENDPOINTS.archive.evmRpc
    );
    
    // Stop listening for new votes
    if (voteListener) {
        voteListener.stop();
        voteListener = null;
    }
    
    // Check final balances
    await walletBalances.checkFinalBalances(
        currentBlock,
        MIN_SEI_REQUIRED,
        WALLETS_FILE,
        VOTES_FILE,
        RPC_ENDPOINTS.primary.rest,
        RPC_ENDPOINTS.archive.rest,
        RPC_ENDPOINTS.primary.evmRpc,
        RPC_ENDPOINTS.archive.evmRpc
    );
    
    // Generate reports
    await walletBalances.generateReport(
        WALLETS_FILE, 
        VOTES_FILE, 
        MIN_SEI_REQUIRED,
        path.join(DATA_DIR, 'voting_report.csv'),
        path.join(DATA_DIR, 'wallet_report.csv')
    );
    
    console.log('Final report generation complete.');
}

/**
 * Clean shutdown handler
 */
function cleanup() {
    console.log('Shutting down...');
    isRunning = false;
    
    // Stop memory monitoring (new line)
    memoryManager.stopMemoryMonitoring();
    
    // Stop vote listener
    if (voteListener) {
        voteListener.stop();
        voteListener = null;
    }
    
    // Process any remaining votes
    if (pendingVotes.length > 0) {
        console.log(`Processing ${pendingVotes.length} remaining votes before shutdown...`);
        processBatchOfVotes(pendingVotes).finally(() => {
            console.log('Final vote processing complete.');
            removeLock();
            console.log('Cleanup complete.');
        });
    } else {
        removeLock();
        console.log('Cleanup complete.');
    }
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
        await trackVotingActivity();
        
        // Schedule next check if needed
        const now = new Date();
        if (now < VOTING_END_DATE && isRunning) {
            const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
            console.log(`Scheduling next check in 12 hours (${new Date(now.getTime() + TWELVE_HOURS_MS).toISOString()})`);
            setTimeout(schedulePeriodicChecks, TWELVE_HOURS_MS);
        } else {
            console.log('Voting period has ended. Final check complete.');
            cleanup();
        }
    } catch (error) {
        console.error('Error in monitoring cycle:', error);
        // Retry after an hour on failure
        if (isRunning) {
            console.log('Will retry in 1 hour');
            setTimeout(schedulePeriodicChecks, 60 * 60 * 1000);
        }
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