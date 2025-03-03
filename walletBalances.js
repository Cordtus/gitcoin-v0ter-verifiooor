const axios = require('axios');
const fs = require('fs');

// Constants
const USEI_TO_SEI = 1000000; // 1 SEI = 1,000,000 uSEI
const WALLET_CONVERTER_API = 'https://wallets.sei.basementnodes.ca';

// In-memory cache for wallet mappings and balances
const addressCache = new Map();
const balanceCache = new Map();

/**
 * Helper function to make a REST API request with fallback
 * @param {string} endpoint API endpoint 
 * @param {Object} headers Request headers
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<Object>} API response
 */
async function makeRestRequestWithFallback(endpoint, headers, primaryRestUrl, fallbackRestUrl) {
    try {
        const response = await axios.get(`${primaryRestUrl}${endpoint}`, { headers });
        return response;
    } catch (error) {
        console.log(`Primary REST request failed: ${error.message}`);
        console.log(`Trying fallback REST endpoint...`);
        
        try {
            const response = await axios.get(`${fallbackRestUrl}${endpoint}`, { headers });
            return response;
        } catch (fallbackError) {
            console.error(`Fallback REST request also failed: ${fallbackError.message}`);
            throw fallbackError;
        }
    }
}

/**
 * Convert EVM address to Cosmos address
 * @param {string} evmAddress EVM address
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<string>} Cosmos address
 */
async function convertEvmToCosmos(evmAddress, primaryRestUrl, fallbackRestUrl) {
    // Check cache first
    const cacheKey = evmAddress.toLowerCase();
    if (addressCache.has(cacheKey)) {
        return addressCache.get(cacheKey);
    }
    
    try {
        const response = await axios.get(`${WALLET_CONVERTER_API}/${evmAddress}`);
        const cosmosAddress = response.data.result;
        
        // Cache the result
        addressCache.set(cacheKey, cosmosAddress);
        
        return cosmosAddress;
    } catch (error) {
        console.error(`Error converting address ${evmAddress}:`, error.message);
        throw error;
    }
}

/**
 * Get SEI balance for an address at a specific block height
 * @param {string} cosmosAddress Cosmos address
 * @param {number} blockHeight Block height
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<number>} SEI balance
 */
async function getSeiBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl) {
    // Check cache first
    const cacheKey = `${cosmosAddress}-${blockHeight}`;
    if (balanceCache.has(cacheKey)) {
        return balanceCache.get(cacheKey);
    }
    
    try {
        const endpoint = `/cosmos/bank/v1beta1/balances/${cosmosAddress}/by_denom?denom=usei`;
        const headers = {
            'x-cosmos-block-height': blockHeight,
            'Accept': 'application/json'
        };
        
        const response = await makeRestRequestWithFallback(
            endpoint, 
            headers, 
            primaryRestUrl, 
            fallbackRestUrl
        );
        
        // If the response has balance data
        if (response.data && response.data.balance && response.data.balance.amount) {
            const uSeiAmount = parseInt(response.data.balance.amount);
            const seiAmount = uSeiAmount / USEI_TO_SEI;
            
            // Cache the result
            balanceCache.set(cacheKey, seiAmount);
            
            return seiAmount;
        }
        
        // No balance found
        return 0;
    } catch (error) {
        console.error(`Error getting balance for ${cosmosAddress} at height ${blockHeight}:`, error.message);
        if (error.response) {
            console.error('Response data:', JSON.stringify(error.response.data));
        }
        
        // On error, assume zero balance
        return 0;
    }
}

/**
 * Load wallet data from a file
 * @param {string} filePath File path
 * @returns {Map} Wallet data
 */
function loadWalletData(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return new Map(JSON.parse(data));
        }
    } catch (error) {
        console.error(`Error loading wallet data: ${error.message}`);
    }
    
    return new Map();
}

/**
 * Save wallet data to a file
 * @param {Map} wallets Wallet data
 * @param {string} filePath File path
 */
function saveWalletData(wallets, filePath) {
    try {
        const data = JSON.stringify(Array.from(wallets.entries()), null, 2);
        fs.writeFileSync(filePath, data, 'utf8');
    } catch (error) {
        console.error(`Error saving wallet data: ${error.message}`);
    }
}

/**
 * Load voting data from a file
 * @param {string} filePath File path
 * @returns {Map} Voting data
 */
function loadVotingData(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return new Map(JSON.parse(data));
        }
    } catch (error) {
        console.error(`Error loading voting data: ${error.message}`);
    }
    
    return new Map();
}

/**
 * Save voting data to a file
 * @param {Map} votes Voting data
 * @param {string} filePath File path
 */
function saveVotingData(votes, filePath) {
    try {
        const data = JSON.stringify(Array.from(votes.entries()), null, 2);
        fs.writeFileSync(filePath, data, 'utf8');
    } catch (error) {
        console.error(`Error saving voting data: ${error.message}`);
    }
}

/**
 * Record a vote
 * @param {string} txHash Transaction hash
 * @param {string} evmAddress EVM address
 * @param {string} cosmosAddress Cosmos address
 * @param {number} blockHeight Block height
 * @param {Date} timestamp Timestamp
 * @param {number} balanceAtVote Balance at vote time
 * @param {number} balanceBeforeVote Balance before vote
 * @param {number} minSeiRequired Minimum SEI required
 * @param {string} walletsFile Wallets file path
 * @param {string} votesFile Votes file path
 */
async function recordVote(
    txHash, 
    evmAddress, 
    cosmosAddress, 
    blockHeight, 
    timestamp, 
    balanceAtVote, 
    balanceBeforeVote, 
    minSeiRequired,
    walletsFile,
    votesFile
) {
    // Load existing data
    const wallets = loadWalletData(walletsFile);
    const votes = loadVotingData(votesFile);
    
    // Skip if vote already processed
    if (votes.has(txHash)) {
        return;
    }
    
    // Initial validity check
    const isValid = balanceAtVote >= minSeiRequired && balanceBeforeVote >= minSeiRequired;
    
    // Record the vote
    const vote = {
        txHash,
        evmAddress: evmAddress.toLowerCase(),
        cosmosAddress,
        blockHeight,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
        balanceAtVote,
        balanceBeforeVote,
        isValid,
        finalIsValid: null // Will be set at the end of voting period
    };
    
    votes.set(txHash, vote);
    
    // Add or update wallet info
    if (!wallets.has(evmAddress)) {
        wallets.set(evmAddress, {
            evmAddress: evmAddress.toLowerCase(),
            cosmosAddress,
            balances: {},
            votes: [],
            finalBalance: null,
            finalBalanceValid: null
        });
    }
    
    const wallet = wallets.get(evmAddress);
    
    // Update balances
    wallet.balances[blockHeight] = balanceAtVote;
    wallet.balances[blockHeight - 1] = balanceBeforeVote;
    
    // Add vote reference
    wallet.votes.push(txHash);
    
    // Save updated data
    saveWalletData(wallets, walletsFile);
    saveVotingData(votes, votesFile);
}

/**
 * Check final balances for all wallets
 * @param {number} finalBlockHeight Final block height
 * @param {number} minSeiRequired Minimum SEI required
 * @param {string} walletsFile Wallets file path
 * @param {string} votesFile Votes file path
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 */
async function checkFinalBalances(
    finalBlockHeight, 
    minSeiRequired, 
    walletsFile, 
    votesFile,
    primaryRestUrl,
    fallbackRestUrl
) {
    // Load existing data
    const wallets = loadWalletData(walletsFile);
    const votes = loadVotingData(votesFile);
    
    console.log(`Checking final balances at block ${finalBlockHeight}...`);
    
    // Check each wallet's final balance
    for (const [evmAddress, wallet] of wallets.entries()) {
        // Skip wallets with no votes
        if (!wallet.votes || wallet.votes.length === 0) {
            continue;
        }
        
        // Get final balance
        const finalBalance = await getSeiBalance(
            wallet.cosmosAddress, 
            finalBlockHeight,
            primaryRestUrl,
            fallbackRestUrl
        );
        
        wallet.finalBalance = finalBalance;
        wallet.finalBalanceValid = finalBalance >= minSeiRequired;
        
        console.log(`${evmAddress} (${wallet.cosmosAddress}):`);
        console.log(`  Final balance: ${finalBalance} SEI`);
        console.log(`  Final balance valid: ${wallet.finalBalanceValid}`);
        
        // Update validity of all votes for this wallet
        for (const txHash of wallet.votes) {
            const vote = votes.get(txHash);
            if (vote) {
                vote.finalIsValid = vote.isValid && wallet.finalBalanceValid;
            }
        }
    }
    
    // Save updated data
    saveWalletData(wallets, walletsFile);
    saveVotingData(votes, votesFile);
    
    console.log('Final balance check complete.');
}

/**
 * Generate a comprehensive report
 * @param {string} walletsFile Wallets file path
 * @param {string} votesFile Votes file path
 * @param {number} minSeiRequired Minimum SEI required
 * @param {string} votingReportFile Voting report file path
 * @param {string} walletReportFile Wallet report file path
 */
async function generateReport(walletsFile, votesFile, minSeiRequired, votingReportFile, walletReportFile) {
    // Load data
    const wallets = loadWalletData(walletsFile);
    const votes = loadVotingData(votesFile);
    
    // Calculate statistics
    let totalVotes = votes.size;
    let initialValidVotes = 0;
    let finalValidVotes = 0;
    let uniqueWallets = wallets.size;
    let walletsWithValidVotes = 0;
    
    for (const vote of votes.values()) {
        if (vote.isValid) initialValidVotes++;
        if (vote.finalIsValid) finalValidVotes++;
    }
    
    for (const wallet of wallets.values()) {
        if (wallet.votes.some(txHash => {
            const vote = votes.get(txHash);
            return vote && vote.finalIsValid;
        })) {
            walletsWithValidVotes++;
        }
    }
    
    // Generate console report
    console.log('\n===== VOTING REPORT =====');
    console.log(`Total votes: ${totalVotes}`);
    console.log(`Initially valid votes: ${initialValidVotes}`);
    console.log(`Final valid votes: ${finalValidVotes}`);
    console.log(`Unique wallets: ${uniqueWallets}`);
    console.log(`Wallets with valid votes: ${walletsWithValidVotes}`);
    
    // Generate invalid votes report
    console.log('\n===== INVALID VOTES =====');
    for (const vote of votes.values()) {
        if (!vote.finalIsValid) {
            console.log(`${vote.txHash} from ${vote.evmAddress} (${vote.cosmosAddress}):`);
            console.log(`  Balance at vote: ${vote.balanceAtVote} SEI`);
            console.log(`  Balance before vote: ${vote.balanceBeforeVote} SEI`);
            
            // Get the wallet to check final balance
            const wallet = wallets.get(vote.evmAddress);
            console.log(`  Final balance: ${wallet.finalBalance} SEI`);
            
            // Reason for invalidity
            if (vote.balanceAtVote < minSeiRequired || vote.balanceBeforeVote < minSeiRequired) {
                console.log(`  Reason: Insufficient balance at time of voting`);
            } else if (!wallet.finalBalanceValid) {
                console.log(`  Reason: Insufficient balance at end of voting period`);
            }
            console.log('-----------------------------------');
        }
    }
    
    // Generate CSV report for votes
    const voteCsvHeader = 'TxHash,VoterEvm,VoterCosmos,BlockHeight,Timestamp,BalanceAtVote,BalanceBeforeVote,InitialValid,FinalValid\n';
    let voteCsvContent = voteCsvHeader;
    
    for (const vote of votes.values()) {
        voteCsvContent += `${vote.txHash},${vote.evmAddress},${vote.cosmosAddress},${vote.blockHeight},${vote.timestamp},${vote.balanceAtVote},${vote.balanceBeforeVote},${vote.isValid},${vote.finalIsValid}\n`;
    }
    
    try {
        fs.writeFileSync(votingReportFile, voteCsvContent, 'utf8');
        console.log(`\nVoting report saved to ${votingReportFile}`);
    } catch (error) {
        console.error(`Error saving voting report: ${error.message}`);
    }
    
    // Generate CSV report for wallets
    const walletCsvHeader = 'EvmAddress,CosmosAddress,VoteCount,ValidVoteCount,FinalBalance,MeetsRequirement\n';
    let walletCsvContent = walletCsvHeader;
    
    for (const wallet of wallets.values()) {
        const voteCount = wallet.votes.length;
        const validVoteCount = wallet.votes.filter(txHash => {
            const vote = votes.get(txHash);
            return vote && vote.finalIsValid;
        }).length;
        
        walletCsvContent += `${wallet.evmAddress},${wallet.cosmosAddress},${voteCount},${validVoteCount},${wallet.finalBalance},${wallet.finalBalanceValid}\n`;
    }
    
    try {
        fs.writeFileSync(walletReportFile, walletCsvContent, 'utf8');
        console.log(`Wallet report saved to ${walletReportFile}`);
    } catch (error) {
        console.error(`Error saving wallet report: ${error.message}`);
    }
    
    console.log('========================\n');
}

module.exports = {
    convertEvmToCosmos,
    getSeiBalance,
    recordVote,
    checkFinalBalances,
    generateReport,
    loadWalletData,
    saveWalletData,
    loadVotingData,
    saveVotingData
};
