// walletBalances.js

import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import { retry, sleep } from './utils.js';

// Constants
const USEI_TO_SEI = 1000000; // 1 SEI = 1,000,000 uSEI
const WEI_DECIMALS = 18;     // 1 SEI = 10^18 wei (asei)
const DISPLAY_DECIMALS = 6;  // Keep 6 decimal places for display
const WALLET_CONVERTER_API = 'https://wallets.sei.basementnodes.ca';
const REVERSE_LOOKUP_TIMEOUT = 10000; // 10 seconds timeout for reverse lookup

// In-memory cache for wallet mappings and balances
const addressCache = new Map();
const balanceCache = new Map();
const reverseAddressCache = new Map(); // New cache for cosmos->evm lookups

// Cache statistics for adaptive management
let addressCacheHits = 0;
let addressCacheMisses = 0;
let balanceCacheHits = 0;
let balanceCacheMisses = 0;

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
    if (addressCache.has(normalizedAddr)) {
        addressCacheHits++;
        return addressCache.get(normalizedAddr);
    }
    
    addressCacheMisses++;
    
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
    if (reverseAddressCache.has(cosmosAddress)) {
        addressCacheHits++;
        return reverseAddressCache.get(cosmosAddress);
    }
    
    addressCacheMisses++;
    
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
    
    // Method 3: Try to find through EVM Chain query (this is more complex and depends on contract availability)
    // This is a placeholder for an actual implementation
    
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
    if (balanceCache.has(cacheKey)) {
        balanceCacheHits++;
        return balanceCache.get(cacheKey);
    }
    
    balanceCacheMisses++;
    
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
                const seiAmount = Number((uSeiAmount / USEI_TO_SEI).toFixed(DISPLAY_DECIMALS));
                return seiAmount;
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
                const seiAmount = Number((uSeiAmount / USEI_TO_SEI).toFixed(DISPLAY_DECIMALS));
                return seiAmount;
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
                    return Number(seiAmount.toFixed(DISPLAY_DECIMALS));
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
                return Number(seiAmount.toFixed(DISPLAY_DECIMALS));
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
            const formattedBalance = Number(finalBalance.toFixed(DISPLAY_DECIMALS));
            
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

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
    return {
        addressCache: {
            size: addressCache.size,
            hits: addressCacheHits,
            misses: addressCacheMisses,
            hitRate: addressCacheHits / (addressCacheHits + addressCacheMisses || 1)
        },
        reverseAddressCache: {
            size: reverseAddressCache.size
        },
        balanceCache: {
            size: balanceCache.size,
            hits: balanceCacheHits,
            misses: balanceCacheMisses,
            hitRate: balanceCacheHits / (balanceCacheHits + balanceCacheMisses || 1)
        }
    };
}

/**
 * Clear caches to free memory
 * @param {boolean} clearAddressCache Whether to clear address cache
 * @param {boolean} clearBalanceCache Whether to clear balance cache
 */
export function clearCaches(clearAddressCache = false, clearBalanceCache = true) {
    if (clearBalanceCache) {
        console.log(`Clearing balance cache (${balanceCache.size} entries)`);
        balanceCache.clear();
    }
    
    if (clearAddressCache) {
        console.log(`Clearing address cache (${addressCache.size} entries) and reverse cache (${reverseAddressCache.size} entries)`);
        addressCache.clear();
        reverseAddressCache.clear();
    }
}

/**
 * Adaptive cache management based on memory pressure
 * @param {number} maxMemUsageMB Max memory usage in MB before aggressive clearing
 * @param {number} targetMemUsageMB Target memory usage in MB after clearing
 */
export function adaptiveCacheManagement(maxMemUsageMB = 1024, targetMemUsageMB = 768) {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    console.log(`Current memory usage: ${heapUsedMB} MB`);
    
    if (heapUsedMB > maxMemUsageMB) {
        console.log(`Memory usage (${heapUsedMB} MB) exceeds threshold (${maxMemUsageMB} MB). Clearing caches...`);
        
        // Clear balance cache first (usually largest)
        clearCaches(false, true);
        
        // If still too high, clear address caches too
        const newMemUsage = process.memoryUsage();
        const newHeapUsedMB = Math.round(newMemUsage.heapUsed / 1024 / 1024);
        
        if (newHeapUsedMB > targetMemUsageMB) {
            clearCaches(true, false);
        }
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log('Garbage collection triggered');
        }
    }
}