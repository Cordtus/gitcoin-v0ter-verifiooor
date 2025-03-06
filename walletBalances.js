// walletBalances.js

import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import { retry, sleep, formatSeiBalance, useiToSei } from './utils.js';
import { 
  USEI_TO_SEI, 
  WEI_DECIMALS, 
  DISPLAY_DECIMALS, 
  WALLET_CONVERTER_API,
  MIN_SEI_REQUIRED,
  PATHS
} from './config.js';
import {
  addressCache,
  reverseAddressCache,
  balanceCache,
  getCacheStats
} from './cache.js';

// API request constants
const REVERSE_LOOKUP_TIMEOUT = 10000; // 10 seconds timeout for reverse lookup

/**
 * Convert EVM address to Cosmos address
 * @param {string} evmAddress EVM address
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<string>} Cosmos address
 */
export async function convertEvmToCosmos(evmAddress, primaryRestUrl, fallbackRestUrl) {
    // Standardize address
    const normalizedAddr = evmAddress.toLowerCase();
    
    // Check cache first
    const cachedAddress = addressCache.get(normalizedAddr);
    if (cachedAddress) {
        return cachedAddress;
    }
    
    return await retry(async () => {
        try {
            const response = await axios.get(`${WALLET_CONVERTER_API}/${normalizedAddr}`, {
                timeout: 5000, // 5 second timeout
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            if (response.data && response.data.result) {
                const cosmosAddress = response.data.result;
                
                // Cache the result in both directions
                addressCache.set(normalizedAddr, cosmosAddress);
                reverseAddressCache.set(cosmosAddress, normalizedAddr);
                
                return cosmosAddress;
            } else {
                throw new Error(`Invalid response format from wallet converter API for ${normalizedAddr}`);
            }
        } catch (error) {
            // More granular error handling
            if (error.code === 'ECONNABORTED') {
                throw new Error(`Connection timed out while converting address ${normalizedAddr}`);
            } else if (error.response) {
                throw new Error(`API error (${error.response.status}) converting address ${normalizedAddr}: ${error.response.data}`);
            } else if (error.request) {
                throw new Error(`No response received while converting address ${normalizedAddr}`);
            } else {
                throw new Error(`Error converting address ${normalizedAddr}: ${error.message}`);
            }
        }
    }, 3, 1000); // Retry 3 times with 1s initial delay
}

/**
 * Convert Cosmos address to EVM address
 * @param {string} cosmosAddress Cosmos address
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @returns {Promise<string>} EVM address
 */
export async function convertCosmosToEvm(cosmosAddress, primaryRestUrl, fallbackRestUrl) {
    // Check cache first
    const cachedAddress = reverseAddressCache.get(cosmosAddress);
    if (cachedAddress) {
        return cachedAddress;
    }
    
    // Method 1: Try API for reverse lookup if available
    try {
        const response = await Promise.race([
            axios.get(`${WALLET_CONVERTER_API}/reverse/${cosmosAddress}`, {
                timeout: REVERSE_LOOKUP_TIMEOUT
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Reverse lookup timed out')), REVERSE_LOOKUP_TIMEOUT)
            )
        ]);
        
        if (response.data && response.data.result) {
            const evmAddress = response.data.result.toLowerCase();
            
            // Cache the result in both directions
            reverseAddressCache.set(cosmosAddress, evmAddress);
            addressCache.set(evmAddress, cosmosAddress);
            
            return evmAddress;
        }
    } catch (error) {
        console.log(`Reverse lookup API failed for ${cosmosAddress}: ${error.message}`);
        // Continue to fallback methods
    }
    
    // Method 2: Check existing mappings
    // Search through our existing address cache for this cosmos address
    for (const [evm, cosmos] of addressCache.entries()) {
        if (cosmos === cosmosAddress) {
            reverseAddressCache.set(cosmosAddress, evm);
            return evm;
        }
    }
    
    // If all methods fail, we need to reject
    throw new Error(`Could not convert Cosmos address ${cosmosAddress} to EVM address`);
}

/**
 * Get SEI balance for an address at a specific block height
 * @param {string} cosmosAddress Cosmos address
 * @param {number} blockHeight Block height
 * @param {string} primaryRestUrl Primary REST API URL
 * @param {string} fallbackRestUrl Fallback REST API URL
 * @param {string} primaryEvmRpc Primary EVM RPC URL 
 * @param {string} fallbackEvmRpc Fallback EVM RPC URL
 * @returns {Promise<number>} SEI balance (with 6 decimal places)
 */
export async function getSeiBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl, primaryEvmRpc, fallbackEvmRpc) {
    // Check cache first
    const cacheKey = `${cosmosAddress}-${blockHeight}`;
    const cachedBalance = balanceCache.get(cacheKey);
    if (cachedBalance !== null) {
        return cachedBalance;
    }
    
    // Create array of methods to try
    const balanceMethods = [
        // Method 1: Cosmos API
        async () => {
            try {
                return await getCosmosBalance(cosmosAddress, blockHeight, primaryRestUrl, fallbackRestUrl);
            } catch (error) {
                console.error(`Cosmos balance lookup failed for ${cosmosAddress} at block ${blockHeight}: ${error.message}`);
                throw error;
            }
        },
        
        // Method 2: Try EVM lookup if we can convert the address
        async () => {
            try {
                // Only try if address starts with 'sei'
                if (cosmosAddress.startsWith('sei')) {
                    const evmAddress = await convertCosmosToEvm(cosmosAddress, primaryRestUrl, fallbackRestUrl);
                    return await getEvmBalance(evmAddress, blockHeight, primaryEvmRpc, fallbackEvmRpc);
                } else {
                    // If it's already an EVM address
                    return await getEvmBalance(cosmosAddress, blockHeight, primaryEvmRpc, fallbackEvmRpc);
                }
            } catch (error) {
                console.error(`EVM balance lookup failed for ${cosmosAddress} at block ${blockHeight}: ${error.message}`);
                throw error;
            }
        }
    ];
    
    // Try each method in sequence
    for (const method of balanceMethods) {
        try {
            const balance = await method();
            
            // Cache and return the result
            balanceCache.set(cacheKey, balance);
            return balance;
        } catch (error) {
            // Continue to next method
            continue;
        }
    }
    
    // If all methods fail, log and return 0
    console.error(`All balance lookup methods failed for ${cosmosAddress} at block ${blockHeight}`);
    return 0;
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
    return await retry(async () => {
        const endpoint = `/cosmos/bank/v1beta1/balances/${cosmosAddress}/by_denom?denom=usei`;
        const headers = {
            'x-cosmos-block-height': blockHeight,
            'Accept': 'application/json'
        };
        
        try {
            // Try primary endpoint with timeout
            const response = await axios.get(`${primaryRestUrl}${endpoint}`, { 
                headers,
                timeout: 8000 // 8 second timeout
            });
            
            // If the response has balance data
            if (response.data && response.data.balance && response.data.balance.amount) {
                // The amount will be in "usei" format (e.g., "100000000" for 100 SEI)
                const uSeiAmount = parseInt(response.data.balance.amount);
                return useiToSei(uSeiAmount);
            }
            
            // No balance found
            return 0;
        } catch (primaryError) {
            // More granular error handling for primary endpoint
            if (primaryError.code === 'ECONNABORTED') {
                console.log(`Primary REST request timed out, trying fallback...`);
            } else if (primaryError.response) {
                console.log(`Primary REST request failed with status ${primaryError.response.status}, trying fallback...`);
            } else if (primaryError.request) {
                console.log(`No response from primary REST server, trying fallback...`);
            } else {
                console.log(`Primary REST request error: ${primaryError.message}, trying fallback...`);
            }
            
            // Try fallback with timeout
            const response = await axios.get(`${fallbackRestUrl}${endpoint}`, { 
                headers,
                timeout: 8000 // 8 second timeout 
            });
            
            if (response.data && response.data.balance && response.data.balance.amount) {
                const uSeiAmount = parseInt(response.data.balance.amount);
                return useiToSei(uSeiAmount);
            }
            
            return 0;
        }
    }, 3, 1000); // Retry 3 times with 1s initial delay
}

/**
 * Get SEI balance using EVM API
 * @param {string} address Address (EVM format)
 * @param {number} blockHeight Block height
 * @param {string} primaryEvmRpc Primary EVM RPC endpoint
 * @param {string} fallbackEvmRpc Fallback EVM RPC endpoint
 * @returns {Promise<number>} SEI balance (with 6 decimal places)
 */
async function getEvmBalance(address, blockHeight, primaryEvmRpc, fallbackEvmRpc) {
    return await retry(async () => {
        try {
            // Standardize address format
            const evmAddress = ethers.getAddress(address);
            
            // Try primary provider with timeout wrapper
            const provider = new ethers.JsonRpcProvider(primaryEvmRpc);
            
            // Set timeout for the RPC call
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('EVM RPC request timed out')), 8000)
            );
            
            // Get balance with timeout
            const balancePromise = (async () => {
                try {
                    const blockTag = ethers.toBeHex(blockHeight);
                    const balanceWei = await provider.getBalance(evmAddress, blockTag);
                    
                    // Convert from wei to SEI with 6 decimal places
                    const seiAmount = Number(ethers.formatUnits(balanceWei, WEI_DECIMALS));
                    return formatSeiBalance(seiAmount);
                } catch (error) {
                    throw error;
                }
            })();
            
            // Race between timeout and the actual request
            return await Promise.race([balancePromise, timeoutPromise]);
        } catch (primaryError) {
            // Specific error handling for primary endpoint
            if (primaryError.message.includes('timed out')) {
                console.log(`Primary EVM RPC request timed out, trying fallback...`);
            } else {
                console.log(`Primary EVM RPC request failed: ${primaryError.message}, trying fallback...`);
            }
            
            // Try fallback provider with timeout wrapper
            const provider = new ethers.JsonRpcProvider(fallbackEvmRpc);
            
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Fallback EVM RPC request timed out')), 8000)
            );
            
            const balancePromise = (async () => {
                const blockTag = ethers.toBeHex(blockHeight);
                const balanceWei = await provider.getBalance(address, blockTag);
                
                // Convert from wei to SEI with 6 decimal places
                const seiAmount = Number(ethers.formatUnits(balanceWei, WEI_DECIMALS));
                return formatSeiBalance(seiAmount);
            })();
            
            return await Promise.race([balancePromise, timeoutPromise]);
        }
    }, 3, 1000); // Retry 3 times with 1s initial delay
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
    minSeiRequired = MIN_SEI_REQUIRED,
    walletsFile = PATHS.WALLETS_FILE,
    votesFile = PATHS.VOTES_FILE
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
    balanceAtVote = formatSeiBalance(balanceAtVote);
    balanceBeforeVote = formatSeiBalance(balanceBeforeVote);
    
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
    
    // Add vote reference if not already present
    if (!wallet.votes.includes(txHash)) {
        wallet.votes.push(txHash);
    }
    
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
    minSeiRequired = MIN_SEI_REQUIRED, 
    walletsFile = PATHS.WALLETS_FILE, 
    votesFile = PATHS.VOTES_FILE,
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
            // Get balance using enhanced method with both Cosmos and EVM options
            const finalBalance = await getSeiBalance(
                wallet.cosmosAddress, 
                finalBlockHeight,
                primaryRestUrl,
                fallbackRestUrl,
                primaryEvmRpc,
                fallbackEvmRpc
            );
            
            // Format to 6 decimal places
            const formattedBalance = formatSeiBalance(finalBalance);
            
            wallet.finalBalance = formattedBalance;
            wallet.finalBalanceValid = formattedBalance >= minSeiRequired;
            
            console.log(`${evmAddress} (${wallet.cosmosAddress}):`);
            console.log(`  Final balance: ${formattedBalance} SEI`);
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
    walletsFile = PATHS.WALLETS_FILE,
    votesFile = PATHS.VOTES_FILE,
    minSeiRequired = MIN_SEI_REQUIRED,
    voteReportFile = PATHS.REPORT.VOTES,
    walletReportFile = PATHS.REPORT.WALLETS
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
    
    // Generate summary statistics
    generateStatisticsFile(wallets, votes, PATHS.REPORT.STATS, minSeiRequired);
    
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
    console.log(`- Statistics: ${PATHS.REPORT.STATS}`);
}

/**
 * Generate a statistics JSON file
 * @param {Map} wallets Wallet data
 * @param {Map} votes Vote data
 * @param {string} statsFile Path to save statistics
 * @param {number} minSeiRequired Minimum SEI required
 */
function generateStatisticsFile(wallets, votes, statsFile, minSeiRequired) {
    try {
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
        
        // Categorize wallets by vote count
        const voteCountCategories = {
            singleVote: 0,
            twoToFiveVotes: 0,
            sixToTenVotes: 0,
            moreThanTenVotes: 0
        };
        
        for (const wallet of wallets.values()) {
            const voteCount = wallet.votes.length;
            
            if (voteCount === 1) {
                voteCountCategories.singleVote++;
            } else if (voteCount >= 2 && voteCount <= 5) {
                voteCountCategories.twoToFiveVotes++;
            } else if (voteCount >= 6 && voteCount <= 10) {
                voteCountCategories.sixToTenVotes++;
            } else if (voteCount > 10) {
                voteCountCategories.moreThanTenVotes++;
            }
        }
        
        // Categorize wallets by balance
        const balanceCategories = {
            lessThan100Sei: 0,
            between100And500Sei: 0,
            between500And1000Sei: 0,
            moreThan1000Sei: 0
        };
        
        for (const wallet of wallets.values()) {
            const balance = wallet.finalBalance || 0;
            
            if (balance < 100) {
                balanceCategories.lessThan100Sei++;
            } else if (balance >= 100 && balance < 500) {
                balanceCategories.between100And500Sei++;
            } else if (balance >= 500 && balance < 1000) {
                balanceCategories.between500And1000Sei++;
            } else {
                balanceCategories.moreThan1000Sei++;
            }
        }
        
        // Find top voters
        const topVoters = Array.from(wallets.values())
            .map(wallet => ({
                address: wallet.evmAddress,
                cosmosAddress: wallet.cosmosAddress,
                voteCount: wallet.votes.length,
                validVoteCount: wallet.votes.filter(txHash => {
                    const vote = votes.get(txHash);
                    return vote && vote.finalIsValid;
                }).length,
                totalVoted: wallet.votes.reduce((sum, txHash) => {
                    const vote = votes.get(txHash);
                    return sum + (vote ? (vote.voteAmount || vote.value || 0) : 0);
                }, 0),
                finalBalance: wallet.finalBalance || 0
            }))
            .sort((a, b) => b.voteCount - a.voteCount || b.totalVoted - a.totalVoted)
            .slice(0, 10); // Top 10 voters
        
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
                minimumBalanceRequired: minSeiRequired
            },
            walletCategories: {
                byVoteCount: voteCountCategories,
                byBalanceRange: balanceCategories
            },
            topVoters
        };
        
        // Write to file
        fs.writeFileSync(statsFile, JSON.stringify(statistics, null, 2), 'utf8');
        console.log(`Statistics file generated at: ${statsFile}`);
        
        return statistics;
    } catch (error) {
        console.error('Error generating statistics file:', error.message);
        return null;
    }
}

// Export additional functions for memory management
export { getCacheStats };