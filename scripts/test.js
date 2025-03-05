// targeted-test-script.js
// Direct transaction checking script that targets known vote transactions

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - Addresses confirmed from successful known transaction checks
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();

// RPC endpoints
const RPC_ENDPOINTS = {
    primary: 'https://evm-rpc.sei.basementnodes.ca',
    fallback: 'https://evm.sei-main-eu.ccvalidators.com:443'
};

// PROVEN WORKING TRANSACTION HASHES from your first test run output
const KNOWN_VOTE_TX_HASHES = [
    '0x6835a88c6c4e82f6de1ce7de0125a28f4e8457d39fc5d45e59f6e4542666fab8', // 100 SEI vote at block 134743944
    '0x669911c87c2167301f4fb2329c07e11709e4805abf1becbeadac12469c1eccb4', // 50 SEI vote at block 134740136
    '0x0e6b6cea48251e1167e2d9995f6cb0f1dad24718276a94d6b672649b8575cdb5'  // 5 SEI vote at block 134737125
];

// EXACT BLOCK NUMBERS where votes occur
const TARGET_BLOCKS = [134743944, 134740136, 134737125];

// Voting method signature confirmed from successful checks
const VOTE_METHOD_SIG = '0xc7b8896b';

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get provider with fallback
 */
async function getProvider() {
    try {
        const provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.primary);
        await provider.getBlockNumber(); // Test connection
        console.log('Connected to primary RPC');
        return provider;
    } catch (error) {
        console.log('Falling back to secondary RPC');
        return new ethers.JsonRpcProvider(RPC_ENDPOINTS.fallback);
    }
}

/**
 * Get transaction details
 */
async function getTransaction(txHash, provider) {
    try {
        return await provider.getTransaction(txHash);
    } catch (error) {
        console.error(`Error getting transaction ${txHash}:`, error.message);
        return null;
    }
}

/**
 * Get transaction receipt
 */
async function getTransactionReceipt(txHash, provider) {
    try {
        return await provider.getTransactionReceipt(txHash);
    } catch (error) {
        console.error(`Error getting receipt for ${txHash}:`, error.message);
        return null;
    }
}

/**
 * Check if a transaction is a vote based on our criteria
 */
function isVoteTransaction(tx, receipt) {
    // Bail early if we don't have both tx and receipt
    if (!tx || !receipt) return { isVote: false };
    
    // 1. Direct transfer to proxy
    const isDirectTransfer = 
        tx.to && 
        tx.to.toLowerCase() === PROXY_ADDRESS && 
        tx.value > 0n;
    
    // 2. Method call to proxy with signature
    const isMethodCall = 
        tx.to && 
        tx.to.toLowerCase() === PROXY_ADDRESS && 
        tx.data && 
        tx.data.startsWith(VOTE_METHOD_SIG);
    
    // 3. Has logs from implementation contract
    const hasImplLogs = receipt.logs && receipt.logs.some(log => 
        log.address && log.address.toLowerCase() === IMPLEMENTATION_ADDRESS
    );
    
    // 4. Has logs from proxy contract
    const hasProxyLogs = receipt.logs && receipt.logs.some(log => 
        log.address && log.address.toLowerCase() === PROXY_ADDRESS
    );
    
    // Final determination
    const isVote = (isDirectTransfer || isMethodCall || hasImplLogs || hasProxyLogs);
    
    let detectionMethod = '';
    if (isDirectTransfer) detectionMethod += 'direct-transfer,';
    if (isMethodCall) detectionMethod += 'method-call,';
    if (hasImplLogs) detectionMethod += 'impl-logs,';
    if (hasProxyLogs) detectionMethod += 'proxy-logs,';
    detectionMethod = detectionMethod.slice(0, -1); // Remove trailing comma
    
    return {
        isVote,
        detectionMethod: detectionMethod || 'none',
        value: tx.value,
        valueInSei: ethers.formatEther(tx.value),
        data: tx.data
    };
}

/**
 * Get block and look for votes
 */
async function checkBlockForVotes(blockNumber, provider) {
    console.log(`Checking block ${blockNumber} for votes...`);
    
    try {
        const block = await provider.getBlock(blockNumber, true);
        if (!block || !block.transactions || block.transactions.length === 0) {
            console.log(`No transactions in block ${blockNumber}`);
            return { blockNumber, votes: [] };
        }
        
        console.log(`Block ${blockNumber} has ${block.transactions.length} transactions`);
        
        // Filter potentially relevant transactions
        const relevantTxs = block.transactions.filter(tx => 
            tx.to && (
                tx.to.toLowerCase() === PROXY_ADDRESS || 
                tx.to.toLowerCase() === IMPLEMENTATION_ADDRESS
            )
        );
        
        if (relevantTxs.length === 0) {
            console.log(`No relevant transactions in block ${blockNumber}`);
            return { blockNumber, votes: [] };
        }
        
        console.log(`Found ${relevantTxs.length} potentially relevant txs in block ${blockNumber}`);
        
        // Check each transaction
        const votes = [];
        for (const tx of relevantTxs) {
            const receipt = await getTransactionReceipt(tx.hash, provider);
            if (!receipt || receipt.status !== 1) continue; // Skip failed transactions
            
            const voteCheck = isVoteTransaction(tx, receipt);
            
            if (voteCheck.isVote) {
                console.log(`✅ VOTE FOUND: ${tx.hash} (method: ${voteCheck.detectionMethod})`);
                console.log(`   From: ${tx.from}`);
                console.log(`   Value: ${voteCheck.valueInSei} SEI`);
                
                votes.push({
                    hash: tx.hash,
                    blockNumber: Number(tx.blockNumber),
                    from: tx.from,
                    to: tx.to,
                    value: voteCheck.valueInSei,
                    method: voteCheck.detectionMethod
                });
            }
        }
        
        return { blockNumber, votes };
    } catch (error) {
        console.error(`Error checking block ${blockNumber}:`, error.message);
        return { blockNumber, votes: [], error: error.message };
    }
}

/**
 * Direct check of known vote transactions
 */
async function checkKnownVoteTx(txHash, provider) {
    console.log(`\nChecking known vote transaction: ${txHash}`);
    
    try {
        const tx = await getTransaction(txHash, provider);
        if (!tx) {
            console.log(`Transaction ${txHash} not found`);
            return { txHash, found: false, error: 'Transaction not found' };
        }
        
        const receipt = await getTransactionReceipt(txHash, provider);
        if (!receipt) {
            console.log(`Receipt for ${txHash} not found`);
            return { txHash, found: false, error: 'Receipt not found' };
        }
        
        const voteAnalysis = isVoteTransaction(tx, receipt);
        
        console.log(`Transaction details:`);
        console.log(`  Block: ${tx.blockNumber}`);
        console.log(`  From: ${tx.from}`);
        console.log(`  To: ${tx.to}`);
        console.log(`  Value: ${ethers.formatEther(tx.value)} SEI`);
        console.log(`  Method signature: ${tx.data.slice(0, 10)}`);
        console.log(`Vote analysis:`);
        console.log(`  Is vote: ${voteAnalysis.isVote}`);
        console.log(`  Detection method: ${voteAnalysis.detectionMethod}`);
        
        return {
            txHash,
            found: true,
            isVote: voteAnalysis.isVote,
            method: voteAnalysis.detectionMethod,
            value: voteAnalysis.valueInSei,
            block: Number(tx.blockNumber),
            from: tx.from,
            to: tx.to
        };
    } catch (error) {
        console.error(`Error checking transaction ${txHash}:`, error.message);
        return { txHash, found: false, error: error.message };
    }
}

/**
 * Fetch transactions at specific blocks
 */
async function getAndAnalyzeBlockTransactions(blockNumber, provider) {
    console.log(`\nFetching all transactions for block ${blockNumber}...`);
    
    try {
        const block = await provider.getBlock(blockNumber, true);
        if (!block) {
            console.log(`Block ${blockNumber} not found`);
            return { blockNumber, success: false, error: 'Block not found' };
        }
        
        console.log(`Block ${blockNumber} has ${block.transactions.length} transactions`);
        
        // Get all transactions targeting our contracts
        const relevantTxs = block.transactions.filter(tx => 
            tx.to && (
                tx.to.toLowerCase() === PROXY_ADDRESS || 
                tx.to.toLowerCase() === IMPLEMENTATION_ADDRESS
            )
        );
        
        if (relevantTxs.length === 0) {
            console.log(`No transactions to proxy or implementation in block ${blockNumber}`);
            
            // Show a few transaction targets to help debugging
            if (block.transactions.length > 0) {
                console.log(`Sample transaction targets in this block:`);
                const sampleCount = Math.min(5, block.transactions.length);
                for (let i = 0; i < sampleCount; i++) {
                    console.log(`  ${i+1}. To: ${block.transactions[i].to}`);
                }
            }
            
            return { 
                blockNumber, 
                success: true, 
                relevantCount: 0,
                transactions: [] 
            };
        }
        
        console.log(`Found ${relevantTxs.length} relevant transactions in block ${blockNumber}`);
        
        // Detailed analysis of each relevant transaction
        const transactions = [];
        for (const tx of relevantTxs) {
            const receipt = await getTransactionReceipt(tx.hash, provider);
            if (!receipt) continue;
            
            const analysis = isVoteTransaction(tx, receipt);
            
            transactions.push({
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                value: ethers.formatEther(tx.value),
                data: tx.data.slice(0, 10) + '...',
                status: receipt.status,
                isVote: analysis.isVote,
                method: analysis.detectionMethod
            });
            
            console.log(`  Transaction: ${tx.hash}`);
            console.log(`  - From: ${tx.from}`);
            console.log(`  - To: ${tx.to}`);
            console.log(`  - Value: ${ethers.formatEther(tx.value)} SEI`);
            console.log(`  - Is vote: ${analysis.isVote}`);
            console.log(`  - Detection: ${analysis.detectionMethod}`);
            console.log('');
        }
        
        return {
            blockNumber,
            success: true,
            relevantCount: relevantTxs.length,
            transactions
        };
    } catch (error) {
        console.error(`Error analyzing block ${blockNumber}:`, error.message);
        return { blockNumber, success: false, error: error.message };
    }
}

/**
 * Main function
 */
async function main() {
    console.log('=== TARGETED SEI VOTING DETECTION TEST ===');
    
    try {
        // 1. Connect to provider
        const provider = await getProvider();
        const currentBlock = await provider.getBlockNumber();
        console.log(`Current block: ${currentBlock}`);
        
        // 2. Directly check our known vote transactions
        console.log('\n=== CHECKING KNOWN VOTE TRANSACTIONS ===');
        const txResults = [];
        
        for (const txHash of KNOWN_VOTE_TX_HASHES) {
            const result = await checkKnownVoteTx(txHash, provider);
            txResults.push(result);
        }
        
        // 3. Check specific blocks where votes are known to occur
        console.log('\n=== CHECKING SPECIFIC BLOCKS FOR VOTES ===');
        const blockResults = [];
        
        for (const blockNumber of TARGET_BLOCKS) {
            const blockResult = await getAndAnalyzeBlockTransactions(blockNumber, provider);
            blockResults.push(blockResult);
            
            // Wait briefly between requests
            await sleep(100);
        }
        
        // 4. Check for votes in recent blocks
        const RECENT_BLOCKS_TO_CHECK = 5;
        console.log(`\n=== CHECKING ${RECENT_BLOCKS_TO_CHECK} RECENT BLOCKS FOR VOTES ===`);
        
        const recentResults = [];
        for (let i = 0; i < RECENT_BLOCKS_TO_CHECK; i++) {
            const blockNumber = currentBlock - i;
            const blockVotes = await checkBlockForVotes(blockNumber, provider);
            recentResults.push(blockVotes);
            
            // Wait briefly between requests
            await sleep(100);
        }
        
        // 5. Compile final report
        console.log('\n=== TEST RESULTS SUMMARY ===');
        
        // Transaction check results
        const successfulTxChecks = txResults.filter(r => r.found && r.isVote).length;
        console.log(`Known transactions verified: ${successfulTxChecks}/${KNOWN_VOTE_TX_HASHES.length}`);
        
        // Block check results
        const blockVotesFound = blockResults.reduce((count, block) => {
            return count + (block.transactions ? block.transactions.filter(tx => tx.isVote).length : 0);
        }, 0);
        console.log(`Votes found in target blocks: ${blockVotesFound}`);
        
        // Recent blocks
        const recentVotesFound = recentResults.reduce((count, block) => count + block.votes.length, 0);
        console.log(`Votes found in recent blocks: ${recentVotesFound}`);
        
        // Check detection methods
        const detectionMethods = {};
        txResults.forEach(tx => {
            if (tx.isVote && tx.method) {
                tx.method.split(',').forEach(method => {
                    detectionMethods[method] = (detectionMethods[method] || 0) + 1;
                });
            }
        });
        
        console.log('\nDetection Methods:');
        Object.entries(detectionMethods).forEach(([method, count]) => {
            console.log(`- ${method}: ${count}`);
        });
        
        // Write configuration for main script
        console.log('\n=== RECOMMENDED CONFIGURATION ===');
        console.log('Based on testing, use these parameters:');
        console.log(`PROXY_ADDRESS = '${PROXY_ADDRESS}'`);
        console.log(`IMPLEMENTATION_ADDRESS = '${IMPLEMENTATION_ADDRESS}'`);
        console.log(`VOTING_METHOD_SIGNATURE = '${VOTE_METHOD_SIG}'`);

        // Identify working blocks to use as test range
        const startTestBlock = Math.min(...TARGET_BLOCKS) - 10;
        const endTestBlock = Math.max(...TARGET_BLOCKS) + 10;
        console.log(`TEST_START_BLOCK = ${startTestBlock}`);
        console.log(`TEST_END_BLOCK = ${endTestBlock}`);
        
        // Save results to file
        const outputFile = path.join(__dirname, 'sei_vote_detection_results.json');
        fs.writeFileSync(
            outputFile,
            JSON.stringify({
                timestamp: new Date().toISOString(),
                txResults,
                blockResults,
                recentResults,
                configuration: {
                    proxyAddress: PROXY_ADDRESS,
                    implementationAddress: IMPLEMENTATION_ADDRESS,
                    voteMethodSignature: VOTE_METHOD_SIG,
                    testStartBlock: startTestBlock,
                    testEndBlock: endTestBlock
                }
            }, null, 2)
        );
        
        console.log(`\nResults saved to: ${outputFile}`);
        
        return {
            success: true,
            knownTxVerified: successfulTxChecks,
            targetBlockVotes: blockVotesFound,
            recentVotes: recentVotesFound
        };
    } catch (error) {
        console.error('Error in test script:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Run the main function
main().catch(console.error);