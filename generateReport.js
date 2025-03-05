import * as walletBalances from './walletBalances.js';
import * as contractReader from './contractReader.js';
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
 * Generate final report
 */
async function generateFinalReport() {
    console.log('Generating final voting report...');
    
    try {
        // Get current block for final balance check
        const currentBlock = await contractReader.getCurrentBlockHeight(
            RPC_ENDPOINTS.primary.evmRpc, 
            RPC_ENDPOINTS.archive.evmRpc
        );
        console.log(`Current block for report: ${currentBlock}`);
        
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
        
        // Generate JSON statistics file
        generateStatsFile();
        
        console.log('Report generation complete.');
    } catch (error) {
        console.error('Error generating final report:', error);
    }
}

/**
 * Generate statistics JSON file
 */
function generateStatsFile() {
    try {
        // Load data
        const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
        const votesData = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8'));
        
        // Convert to Maps for easier processing
        const wallets = new Map(walletsData);
        const votes = new Map(votesData);
        
        // Calculate statistics
        const totalVotes = votes.size;
        const validVotes = Array.from(votes.values()).filter(vote => vote.finalIsValid).length;
        const totalWallets = wallets.size;
        const walletsWithValidVotes = Array.from(wallets.values()).filter(wallet => 
            wallet.finalBalanceValid && 
            wallet.votes.some(txHash => {
                const vote = votes.get(txHash);
                return vote && vote.finalIsValid;
            })
        ).length;
        
        // Calculate vote amounts
        let totalSeiVoted = 0;
        let validSeiVoted = 0;
        
        for (const [txHash, vote] of votes.entries()) {
            // Extract vote amount from transaction
            const voteAmount = vote.voteAmount || 0; // Use stored value or estimate from transaction
            
            totalSeiVoted += voteAmount;
            if (vote.finalIsValid) {
                validSeiVoted += voteAmount;
            }
        }
        
        // Create statistics object
        const statistics = {
            generatedAt: new Date().toISOString(),
            overview: {
                totalVotes,
                validVotes,
                validVotePercentage: (validVotes / totalVotes * 100).toFixed(2),
                totalWallets,
                walletsWithValidVotes,
                validWalletPercentage: (walletsWithValidVotes / totalWallets * 100).toFixed(2),
                totalSeiVoted,
                validSeiVoted,
                validSeiPercentage: (validSeiVoted / totalSeiVoted * 100).toFixed(2)
            },
            walletCategories: {
                byVoteCount: categorizeWalletsByVoteCount(wallets, votes),
                byBalanceRange: categorizeWalletsByBalance(wallets)
            }
        };
        
        // Write statistics to file
        fs.writeFileSync(
            path.join(DATA_DIR, 'voting_statistics.json'), 
            JSON.stringify(statistics, null, 2),
            'utf8'
        );
        
        console.log('Statistics file generated successfully.');
    } catch (error) {
        console.error('Error generating statistics file:', error);
    }
}

/**
 * Categorize wallets by vote count
 * @param {Map} wallets Wallet map
 * @param {Map} votes Vote map
 * @returns {Object} Categories by vote count
 */
function categorizeWalletsByVoteCount(wallets, votes) {
    const categories = {
        singleVote: 0,
        twoToFiveVotes: 0,
        sixToTenVotes: 0,
        moreThanTenVotes: 0
    };
    
    for (const wallet of wallets.values()) {
        const voteCount = wallet.votes.length;
        
        if (voteCount === 1) {
            categories.singleVote++;
        } else if (voteCount >= 2 && voteCount <= 5) {
            categories.twoToFiveVotes++;
        } else if (voteCount >= 6 && voteCount <= 10) {
            categories.sixToTenVotes++;
        } else {
            categories.moreThanTenVotes++;
        }
    }
    
    return categories;
}

/**
 * Categorize wallets by balance range
 * @param {Map} wallets Wallet map
 * @returns {Object} Categories by balance range
 */
function categorizeWalletsByBalance(wallets) {
    const categories = {
        lessThan100Sei: 0,
        between100And500Sei: 0,
        between500And1000Sei: 0,
        moreThan1000Sei: 0
    };
    
    for (const wallet of wallets.values()) {
        const balance = wallet.finalBalance || 0;
        
        if (balance < 100) {
            categories.lessThan100Sei++;
        } else if (balance >= 100 && balance < 500) {
            categories.between100And500Sei++;
        } else if (balance >= 500 && balance < 1000) {
            categories.between500And1000Sei++;
        } else {
            categories.moreThan1000Sei++;
        }
    }
    
    return categories;
}

// Run the report generation if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    generateFinalReport().catch(console.error);
}

export { generateFinalReport };