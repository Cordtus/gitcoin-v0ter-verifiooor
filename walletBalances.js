// walletBalances.js

import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs';

// Constants
const USEI_TO_SEI = 1000000; // 1 SEI = 1,000,000 uSEI
const WEI_DECIMALS = 18;     // 1 SEI = 10^18 wei (asei)
const DISPLAY_DECIMALS = 6;  // Keep 6 decimal places for display
const WALLET_CONVERTER_API = 'https://wallets.sei.basementnodes.ca';

// In-memory cache for wallet mappings and balances
const addressCache = new Map();
const balanceCache = new Map();

/**
 * Convert EVM address to Cosmos address
 * @param {string} evmAddress EVM address
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<string>} Cosmos address
 */
export async function convertEvmToCosmos(evmAddress, primaryRestUrl, fallbackRestUrl) {
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
 * Get SEI balance for an address at a specific block height using Cosmos API
 * @param {string} cosmosAddress Cosmos address
 * @param {number} blockHeight Block height
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<number>} SEI balance (with 6 decimal places)
 */
export async function getSeiBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl) {
    // Check cache first
    const cacheKey = `${cosmosAddress}-${blockHeight}`;
    if (balanceCache.has(cacheKey)) {
        return balanceCache.get(cacheKey);
    }
    
    try {
        // Try getting balance using Cosmos API
        const seiBalance = await getCosmosBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl);
        
        // Cache and return the result
        balanceCache.set(cacheKey, seiBalance);
        return seiBalance;
    } catch (cosmosError) {
        console.error(`Cosmos balance lookup failed: ${cosmosError.message}`);
        
        try {
            // Fallback to EVM balance lookup
            console.log(`Falling back to EVM balance lookup for ${cosmosAddress}`);
            const evmBalance = await getEvmBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl);
            
            // Cache and return the result
            balanceCache.set(cacheKey, evmBalance);
            return evmBalance;
        } catch (evmError) {
            console.error(`EVM balance lookup also failed: ${evmError.message}`);
            // On error, assume zero balance
            return 0;
        }
    }
}

/**
 * Get SEI balance using Cosmos API
 * @param {string} cosmosAddress Cosmos address
 * @param {number} blockHeight Block height
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<number>} SEI balance (with 6 decimal places)
 */
async function getCosmosBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl) {
    try {
        const endpoint = `/cosmos/bank/v1beta1/balances/${cosmosAddress}/by_denom?denom=usei`;
        const headers = {
            'x-cosmos-block-height': blockHeight,
            'Accept': 'application/json'
        };
        
        let response;
        try {
            response = await axios.get(`${primaryRestUrl}${endpoint}`, { headers });
        } catch (primaryError) {
            console.log(`Primary REST request failed: ${primaryError.message}`);
            console.log(`Trying fallback REST endpoint...`);
            response = await axios.get(`${fallbackRestUrl}${endpoint}`, { headers });
        }
        
        // If the response has balance data
        if (response.data && response.data.balance && response.data.balance.amount) {
            // The amount will be in "usei" format (e.g., "100000000" for 100 SEI)
            const uSeiAmount = parseInt(response.data.balance.amount);
            const seiAmount = Number((uSeiAmount / USEI_TO_SEI).toFixed(DISPLAY_DECIMALS));
            return seiAmount;
        }
        
        // No balance found
        return 0;
    } catch (error) {
        console.error(`Error getting cosmos balance for ${cosmosAddress} at height ${blockHeight}:`, error.message);
        throw error;
    }
}

/**
 * Get SEI balance using EVM API
 * @param {string} address Address (either Cosmos or EVM)
 * @param {number} blockHeight Block height
 * @param {string} primaryEvmRpc Primary EVM RPC endpoint
 * @param {string} fallbackEvmRpc Fallback EVM RPC endpoint
 * @returns {Promise<number>} SEI balance (with 6 decimal places)
 */
async function getEvmBalance(address, blockHeight, primaryEvmRpc, fallbackEvmRpc) {
    let evmAddress = address;
    
    // Convert cosmos address to EVM if needed
    if (address.startsWith('sei')) {
        try {
            // We'd need a reverse lookup - this is a placeholder
            // In a real implementation, you'd need a way to convert cosmos address to EVM
            // For now, we'll just fail this path
            throw new Error("Cosmos to EVM conversion not implemented");
        } catch (error) {
            console.error(`Error converting cosmos address ${address} to EVM:`, error.message);
            throw error;
        }
    }
    
    try {
        let provider;
        try {
            provider = new ethers.JsonRpcProvider(primaryEvmRpc);
        } catch (error) {
            console.log(`Primary EVM RPC failed: ${error.message}`);
            provider = new ethers.JsonRpcProvider(fallbackEvmRpc);
        }
        
        // Standardize address format
        evmAddress = ethers.getAddress(evmAddress);
        
        // Get balance at specific block height
        const blockTag = ethers.toBeHex(blockHeight);
        const balanceWei = await provider.getBalance(evmAddress, blockTag);
        
        // Convert from wei to SEI with 6 decimal places
        const seiAmount = Number(ethers.formatUnits(balanceWei, WEI_DECIMALS));
        return Number(seiAmount.toFixed(DISPLAY_DECIMALS));
    } catch (error) {
        console.error(`Error getting EVM balance for ${evmAddress} at height ${blockHeight}:`, error.message);
        throw error;
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
 * @param {number} blockNumber Block height
 * @param {Date} timestamp Timestamp
 * @param {number} balanceAtVote Balance at vote time
 * @param {number} balanceBeforeVote Balance before vote
 * @param {number} minSeiRequired Minimum SEI required
 * @param {string} walletsFile Wallets file path
 * @param {string} votesFile Votes file path
 */
export async function recordVote(
    txHash, 
    evmAddress, 
    cosmosAddress, 
    blockNumber, 
    timestamp, 
    balanceAtVote, 
    balanceBeforeVote, 
    minSeiRequired,
    walletsFile,
    votesFile
) {
    // Standardize EVM address
    evmAddress = evmAddress.toLowerCase();
    
    // Load existing data
    const wallets = loadWalletData(walletsFile);
    const votes = loadVotingData(votesFile);
    
    // Skip if vote already processed
    if (votes.has(txHash)) {
        return;
    }
    
    // Format balances to 6 decimal places
    balanceAtVote = Number(balanceAtVote.toFixed(DISPLAY_DECIMALS));
    balanceBeforeVote = Number(balanceBeforeVote.toFixed(DISPLAY_DECIMALS));
    
    // Initial validity check
    const isValid = balanceAtVote >= minSeiRequired && balanceBeforeVote >= minSeiRequired;
    
    // Record the vote
    const vote = {
        txHash,
        evmAddress,
        cosmosAddress,
        blockNumber,
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
            evmAddress,
            cosmosAddress,
            balances: {},
            votes: [],
            finalBalance: null,
            finalBalanceValid: null
        });
    }
    
    const wallet = wallets.get(evmAddress);
    
    // Update balances
    wallet.balances[blockNumber] = balanceAtVote;
    wallet.balances[blockNumber - 1] = balanceBeforeVote;
    
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
 * @param {string} primaryEvmRpc Primary EVM RPC URL
 * @param {string} fallbackEvmRpc Fallback EVM RPC URL
 */
export async function checkFinalBalances(
    finalBlockHeight, 
    minSeiRequired, 
    walletsFile, 
    votesFile,
    primaryRestUrl,
    fallbackRestUrl,
    primaryEvmRpc,
    fallbackEvmRpc
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
        
        try {
            // Try both cosmos and EVM balance methods
            let finalBalance;
            
            try {
                // First try cosmos balance
                finalBalance = await getSeiBalance(
                    wallet.cosmosAddress, 
                    finalBlockHeight,
                    primaryRestUrl,
                    fallbackRestUrl
                );
            } catch (cosmosError) {
                console.error(`Cosmos balance check failed for ${wallet.cosmosAddress}:`, cosmosError.message);
                
                // Fallback to EVM balance
                finalBalance = await getEvmBalance(
                    evmAddress,
                    finalBlockHeight,
                    primaryEvmRpc,
                    fallbackEvmRpc
                );
            }
            
            // Format to 6 decimal places
            finalBalance = Number(finalBalance.toFixed(DISPLAY_DECIMALS));
            
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
        } catch (error) {
            console.error(`Failed to check balance for wallet ${evmAddress}:`, error.message);
            wallet.finalBalance = 0;
            wallet.finalBalanceValid = false;
            
            // Mark all votes as invalid
            for (const txHash of wallet.votes) {
                const vote = votes.get(txHash);
                if (vote) {
                    vote.finalIsValid = false;
                }
            }
        }
    }
    
    // Save updated data
    saveWalletData(wallets, walletsFile);
    saveVotingData(votes, votesFile);
    
    console.log('Final balance check complete.');
}

/**
 * Generate report files
 * @param {string} walletsFile Wallets file path
 * @param {string} votesFile Votes file path
 * @param {number} minSeiRequired Minimum SEI required
 * @param {string} voteReportFile Vote report file path
 * @param {string} walletReportFile Wallet report file path
 */
export async function generateReport(
    walletsFile,
    votesFile,
    minSeiRequired,
    voteReportFile,
    walletReportFile
) {
    // Load existing data
    const wallets = loadWalletData(walletsFile);
    const votes = loadVotingData(votesFile);
    
    // Generate vote report
    let voteReport = 'txHash,evmAddress,cosmosAddress,blockNumber,timestamp,balanceAtVote,balanceBeforeVote,isValid,finalIsValid\n';
    
    for (const [txHash, vote] of votes.entries()) {
        voteReport += `${txHash},${vote.evmAddress},${vote.cosmosAddress},${vote.blockNumber},${vote.timestamp},${vote.balanceAtVote},${vote.balanceBeforeVote},${vote.isValid},${vote.finalIsValid}\n`;
    }
    
    fs.writeFileSync(voteReportFile, voteReport, 'utf8');
    
    // Generate wallet report
    let walletReport = 'evmAddress,cosmosAddress,voteCount,validVoteCount,finalBalance,finalBalanceValid\n';
    
    for (const [evmAddress, wallet] of wallets.entries()) {
        const voteCount = wallet.votes.length;
        let validVoteCount = 0;
        
        for (const txHash of wallet.votes) {
            const vote = votes.get(txHash);
            if (vote && vote.finalIsValid) {
                validVoteCount++;
            }
        }
        
        walletReport += `${evmAddress},${wallet.cosmosAddress},${voteCount},${validVoteCount},${wallet.finalBalance || 0},${wallet.finalBalanceValid || false}\n`;
    }
    
    fs.writeFileSync(walletReportFile, walletReport, 'utf8');
    
    // Print summary
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
    
    console.log('\nVoting Summary:');
    console.log(`Total votes: ${totalVotes}`);
    console.log(`Valid votes: ${validVotes} (${(validVotes / totalVotes * 100).toFixed(2)}%)`);
    console.log(`Total wallets: ${totalWallets}`);
    console.log(`Wallets with valid votes: ${walletsWithValidVotes} (${(walletsWithValidVotes / totalWallets * 100).toFixed(2)}%)`);
    console.log(`Reports generated at:`);
    console.log(`- Vote report: ${voteReportFile}`);
    console.log(`- Wallet report: ${walletReportFile}`);
}