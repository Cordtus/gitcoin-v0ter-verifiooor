const contractReader = require('./contractReader');
const walletBalances = require('./walletBalances');
const fs = require('fs');
const path = require('path');

// Configuration
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();
const MIN_SEI_REQUIRED = 100; // 100 SEI

// RPC endpoints with fallback options
const RPC_ENDPOINTS = {
    primary: {
        rpc: 'https://rpc.sei.basementnodes.ca',
        rest: 'https://api.sei.basementnodes.ca',
        evmRpc: 'https://evm-rpc.sei.basementnodes.ca'
    },
    archive: {
        rpc: 'https://rpc.sei-main-eu.ccvalidators.com:443',
        rest: 'https://rest.sei-main-eu.ccvalidators.com:443',
        evmRpc: 'https://evm.sei-main-eu.ccvalidators.com:443'
    }
};

// Voting period
const VOTING_START_DATE = new Date('2025/02/26 22:00 MST');
const VOTING_END_DATE = new Date('2025/03/12 10:00 MST');

// Data storage
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const LAST_BLOCK_FILE = path.join(DATA_DIR, 'last_processed_block.txt');

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
    } catch (error) {
        console.error('Error saving last processed block:', error);
    }
}

/**
 * Main function to track voting activity
 */
async function trackVotingActivity() {
    console.log('Starting SEI voting activity tracker...');
    console.log(`Current time: ${new Date().toISOString()}`);
    console.log(`Voting period: ${VOTING_START_DATE.toISOString()} to ${VOTING_END_DATE.toISOString()}`);

    try {
        // Get starting block
        let fromBlock = loadLastProcessedBlock();
        if (fromBlock === 0) {
            fromBlock = await contractReader.estimateBlockHeight(
                VOTING_START_DATE, 
                RPC_ENDPOINTS.primary.evmRpc, 
                RPC_ENDPOINTS.archive.evmRpc
            );
            console.log(`Starting from estimated block: ${fromBlock}`);
        }

        // Get current block
        const currentBlock = await contractReader.getCurrentBlockHeight(
            RPC_ENDPOINTS.primary.evmRpc, 
            RPC_ENDPOINTS.archive.evmRpc
        );
        console.log(`Current block: ${currentBlock}`);

        // Process blocks in batches
        const BATCH_SIZE = 2000; // RPC standard limit
        let processedBlock = fromBlock;

        while (processedBlock < currentBlock) {
            const toBlock = Math.min(processedBlock + BATCH_SIZE - 1, currentBlock);
            
            try {
                // Fetch voting events
                const events = await contractReader.fetchVotingEvents(
                    processedBlock, 
                    toBlock, 
                    [PROXY_ADDRESS, IMPLEMENTATION_ADDRESS],
                    RPC_ENDPOINTS.primary.evmRpc,
                    RPC_ENDPOINTS.archive.evmRpc
                );
                
                console.log(`Found ${events.length} events between blocks ${processedBlock} and ${toBlock}`);
                
                // Process each event to find votes
                for (const event of events) {
                    const txDetails = await contractReader.getTransactionDetails(
                        event.transactionHash,
                        RPC_ENDPOINTS.primary.evmRpc,
                        RPC_ENDPOINTS.archive.evmRpc
                    );
                    
                    // Skip if transaction failed or is not a vote
                    if (!txDetails || !txDetails.success || !txDetails.isVotingTransaction) {
                        continue;
                    }
                    
                    // Get wallet balance at vote time and before
                    try {
                        // Convert EVM address to Cosmos address
                        const cosmosAddress = await walletBalances.convertEvmToCosmos(
                            txDetails.from,
                            RPC_ENDPOINTS.primary.rest,
                            RPC_ENDPOINTS.archive.rest
                        );
                        
                        // Check balance at vote and one block before
                        const balanceAtVote = await walletBalances.getSeiBalance(
                            cosmosAddress, 
                            txDetails.blockNumber,
                            RPC_ENDPOINTS.primary.rest,
                            RPC_ENDPOINTS.archive.rest
                        );
                        
                        const balanceBeforeVote = await walletBalances.getSeiBalance(
                            cosmosAddress, 
                            txDetails.blockNumber - 1,
                            RPC_ENDPOINTS.primary.rest,
                            RPC_ENDPOINTS.archive.rest
                        );
                        
                        // Record vote information
                        await walletBalances.recordVote(
                            txDetails.hash,
                            txDetails.from,
                            cosmosAddress,
                            txDetails.blockNumber,
                            txDetails.timestamp,
                            balanceAtVote,
                            balanceBeforeVote,
                            MIN_SEI_REQUIRED,
                            WALLETS_FILE,
                            VOTES_FILE
                        );
                        
                        console.log(`Processed vote: ${txDetails.hash} from ${txDetails.from}`);
                        console.log(`  Balance at vote: ${balanceAtVote} SEI`);
                        console.log(`  Balance before vote: ${balanceBeforeVote} SEI`);
                    } catch (error) {
                        console.error(`Error processing vote ${txDetails.hash}:`, error.message);
                    }
                }
                
                // Update last processed block
                processedBlock = toBlock + 1;
                saveLastProcessedBlock(processedBlock);
            } catch (error) {
                console.error(`Error processing blocks ${processedBlock} to ${toBlock}:`, error.message);
                // Reduce batch size on failure and retry
                const reducedBatchSize = Math.floor(BATCH_SIZE / 2);
                if (reducedBatchSize >= 100) {
                    console.log(`Reducing batch size to ${reducedBatchSize} and retrying...`);
                    processedBlock += reducedBatchSize;
                } else {
                    // If we can't reduce anymore, skip this problematic range
                    console.log(`Skipping problematic block range, moving to ${toBlock + 1}`);
                    processedBlock = toBlock + 1;
                }
                saveLastProcessedBlock(processedBlock);
            }
        }

        // Check if voting period is over
        const now = new Date();
        if (now >= VOTING_END_DATE) {
            console.log('Voting period has ended. Generating final report...');
            await walletBalances.checkFinalBalances(
                currentBlock,
                MIN_SEI_REQUIRED,
                WALLETS_FILE,
                VOTES_FILE,
                RPC_ENDPOINTS.primary.rest,
                RPC_ENDPOINTS.archive.rest
            );
            
            await walletBalances.generateReport(
                WALLETS_FILE, 
                VOTES_FILE, 
                MIN_SEI_REQUIRED,
                path.join(DATA_DIR, 'voting_report.csv'),
                path.join(DATA_DIR, 'wallet_report.csv')
            );
        }

        return true;
    } catch (error) {
        console.error('Error tracking voting activity:', error);
        return false;
    }
}

/**
 * Schedule periodic checks
 */
async function schedulePeriodicChecks() {
    try {
        await trackVotingActivity();
        
        // Schedule next check
        const now = new Date();
        if (now < VOTING_END_DATE) {
            const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
            console.log(`Scheduling next check in 12 hours (${new Date(now.getTime() + TWELVE_HOURS_MS).toISOString()})`);
            setTimeout(schedulePeriodicChecks, TWELVE_HOURS_MS);
        } else {
            console.log('Voting period has ended. Final check complete.');
        }
    } catch (error) {
        console.error('Error in monitoring cycle:', error);
        // Retry after an hour on failure
        console.log('Will retry in 1 hour');
        setTimeout(schedulePeriodicChecks, 60 * 60 * 1000);
    }
}

// Start the monitoring if this file is executed directly
if (require.main === module) {
    schedulePeriodicChecks();
}

module.exports = {
    trackVotingActivity,
    schedulePeriodicChecks
};
