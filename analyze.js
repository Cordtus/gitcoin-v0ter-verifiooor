// analyze-csv.js
// This script analyzes the CSV data to identify transaction patterns

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Papa from 'papaparse';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();

// CSV file path
const CSV_FILE = path.join(__dirname, 'internal_transactions_0x05b939069163891997c879288f0baac3faaf4500_20250302_20250303.csv');

/**
 * Parse CSV data
 * @param {string} filePath Path to CSV file
 * @returns {Promise<Array>} Parsed CSV data
 */
async function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            
            Papa.parse(fileContent, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (results) => {
                    resolve(results.data);
                },
                error: (error) => {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Parse hex value to decimal
 * @param {string} hexValue Hex value string
 * @returns {number} Decimal value
 */
function parseHexValue(hexValue) {
    if (!hexValue || typeof hexValue !== 'string') return 0;
    
    try {
        // Remove 0x prefix if present
        const cleanHex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
        return parseInt(cleanHex, 16);
    } catch (error) {
        console.error(`Error parsing hex value ${hexValue}:`, error.message);
        return 0;
    }
}

/**
 * Analyze transaction patterns in CSV
 * @param {Array} transactions Array of transaction objects from CSV
 */
function analyzeTransactionPatterns(transactions) {
    console.log(`Analyzing ${transactions.length} transactions...`);
    
    // Transaction type counts
    const typeCount = {};
    const callTypeCount = {};
    
    // Unique addresses and their interaction counts
    const fromAddresses = {};
    const toAddresses = {};
    
    // Value distribution
    const valueDistribution = {
        zero: 0,
        small: 0,  // 0 < value <= 1 SEI
        medium: 0, // 1 < value <= 10 SEI
        large: 0   // value > 10 SEI
    };
    
    // Block distribution
    const blockDistribution = {};
    
    // Transaction success counts
    const successCounts = {
        success: 0,
        failed: 0
    };
    
    // Extract method signatures from input data
    const methodSignatures = {};
    
    // Collect unique hashes
    const uniqueTxHashes = new Set();
    
    // Transaction flow analysis
    let proxyToImplCount = 0;
    let implToProxyCount = 0;
    let otherFlowCount = 0;
    
    // Analyze each transaction
    for (const tx of transactions) {
        // Count transaction types
        typeCount[tx.Type] = (typeCount[tx.Type] || 0) + 1;
        callTypeCount[tx.CallType] = (callTypeCount[tx.CallType] || 0) + 1;
        
        // Track unique transaction hashes
        uniqueTxHashes.add(tx.TxHash);
        
        // Count addresses
        fromAddresses[tx.FromAddress] = (fromAddresses[tx.FromAddress] || 0) + 1;
        toAddresses[tx.ToAddress] = (toAddresses[tx.ToAddress] || 0) + 1;
        
        // Analyze transaction flow
        const fromIsProxy = tx.FromAddress.toLowerCase() === PROXY_ADDRESS;
        const toIsImpl = tx.ToAddress.toLowerCase() === IMPLEMENTATION_ADDRESS;
        const fromIsImpl = tx.FromAddress.toLowerCase() === IMPLEMENTATION_ADDRESS;
        const toIsProxy = tx.ToAddress.toLowerCase() === PROXY_ADDRESS;
        
        if (fromIsProxy && toIsImpl) {
            proxyToImplCount++;
        } else if (fromIsImpl && toIsProxy) {
            implToProxyCount++;
        } else {
            otherFlowCount++;
        }
        
        // Analyze value
        let value = 0;
        try {
            // Try to parse as decimal first
            value = parseFloat(tx.Value);
            if (isNaN(value)) {
                // If that fails, try as hex
                value = parseHexValue(tx.Value) / 1e18; // Convert to SEI
            }
        } catch (error) {
            console.error(`Error parsing value for tx ${tx.TxHash}:`, error.message);
        }
        
        if (value === 0) {
            valueDistribution.zero++;
        } else if (value <= 1) {
            valueDistribution.small++;
        } else if (value <= 10) {
            valueDistribution.medium++;
        } else {
            valueDistribution.large++;
        }
        
        // Block distribution
        blockDistribution[tx.BlockNumber] = (blockDistribution[tx.BlockNumber] || 0) + 1;
        
        // Error code analysis
        if (tx.ErrCode === null || tx.ErrCode === 0 || tx.ErrCode === '0x') {
            successCounts.success++;
        } else {
            successCounts.failed++;
        }
        
        // Method signature analysis (first 4 bytes of input data)
        if (tx.Input && tx.Input.length >= 10) {
            const methodSig = tx.Input.slice(0, 10);
            methodSignatures[methodSig] = (methodSignatures[methodSig] || 0) + 1;
        }
    }
    
    // Generate report
    console.log('\n=== TRANSACTION ANALYSIS REPORT ===\n');
    
    console.log('Transaction Count:', transactions.length);
    console.log('Unique Transaction Hashes:', uniqueTxHashes.size);
    
    console.log('\nTransaction Types:');
    for (const [type, count] of Object.entries(typeCount)) {
        console.log(`  ${type}: ${count} (${(count / transactions.length * 100).toFixed(2)}%)`);
    }
    
    console.log('\nCall Types:');
    for (const [callType, count] of Object.entries(callTypeCount)) {
        console.log(`  ${callType}: ${count} (${(count / transactions.length * 100).toFixed(2)}%)`);
    }
    
    console.log('\nTransaction Flow:');
    console.log(`  Proxy to Implementation: ${proxyToImplCount} (${(proxyToImplCount / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Implementation to Proxy: ${implToProxyCount} (${(implToProxyCount / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Other Flow: ${otherFlowCount} (${(otherFlowCount / transactions.length * 100).toFixed(2)}%)`);
    
    console.log('\nValue Distribution:');
    console.log(`  Zero: ${valueDistribution.zero} (${(valueDistribution.zero / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Small (0-1 SEI): ${valueDistribution.small} (${(valueDistribution.small / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Medium (1-10 SEI): ${valueDistribution.medium} (${(valueDistribution.medium / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Large (>10 SEI): ${valueDistribution.large} (${(valueDistribution.large / transactions.length * 100).toFixed(2)}%)`);
    
    console.log('\nSuccess Rate:');
    console.log(`  Success: ${successCounts.success} (${(successCounts.success / transactions.length * 100).toFixed(2)}%)`);
    console.log(`  Failed: ${successCounts.failed} (${(successCounts.failed / transactions.length * 100).toFixed(2)}%)`);
    
    console.log('\nBlock Distribution:');
    const blockCount = Object.keys(blockDistribution).length;
    console.log(`  Transactions spread across ${blockCount} blocks`);
    console.log(`  Average transactions per block: ${(transactions.length / blockCount).toFixed(2)}`);
    
    console.log('\nTop From Addresses:');
    const topFromAddresses = Object.entries(fromAddresses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    for (const [address, count] of topFromAddresses) {
        const isProxy = address.toLowerCase() === PROXY_ADDRESS ? ' (PROXY)' : '';
        const isImpl = address.toLowerCase() === IMPLEMENTATION_ADDRESS ? ' (IMPLEMENTATION)' : '';
        console.log(`  ${address}${isProxy}${isImpl}: ${count} transactions`);
    }
    
    console.log('\nTop To Addresses:');
    const topToAddresses = Object.entries(toAddresses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    for (const [address, count] of topToAddresses) {
        const isProxy = address.toLowerCase() === PROXY_ADDRESS ? ' (PROXY)' : '';
        const isImpl = address.toLowerCase() === IMPLEMENTATION_ADDRESS ? ' (IMPLEMENTATION)' : '';
        console.log(`  ${address}${isProxy}${isImpl}: ${count} transactions`);
    }
    
    console.log('\nTop Method Signatures:');
    const topMethodSignatures = Object.entries(methodSignatures)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    for (const [signature, count] of topMethodSignatures) {
        console.log(`  ${signature}: ${count} transactions`);
    }
    
    // Transaction sequence analysis
    console.log('\nTransaction Sequence Analysis:');
    const txHashSequences = {};
    
    for (const tx of transactions) {
        txHashSequences[tx.TxHash] = txHashSequences[tx.TxHash] || [];
        txHashSequences[tx.TxHash].push({
            from: tx.FromAddress,
            to: tx.ToAddress,
            value: tx.Value,
            index: tx.Index,
            blockIndex: tx.BlockIndex
        });
    }
    
    // Sort each sequence by index
    for (const hash in txHashSequences) {
        txHashSequences[hash].sort((a, b) => a.index - b.index);
    }
    
    // Identify common patterns
    const patterns = {};
    
    for (const [hash, sequence] of Object.entries(txHashSequences)) {
        // Create a simple pattern string
        const pattern = sequence.map(tx => {
            const fromType = 
                tx.from.toLowerCase() === PROXY_ADDRESS ? 'PROXY' :
                tx.from.toLowerCase() === IMPLEMENTATION_ADDRESS ? 'IMPL' : 'OTHER';
            
            const toType = 
                tx.to.toLowerCase() === PROXY_ADDRESS ? 'PROXY' :
                tx.to.toLowerCase() === IMPLEMENTATION_ADDRESS ? 'IMPL' : 'OTHER';
            
            return `${fromType}->${toType}`;
        }).join('|');
        
        patterns[pattern] = patterns[pattern] || [];
        patterns[pattern].push(hash);
    }
    
    console.log('Common Transaction Patterns:');
    const sortedPatterns = Object.entries(patterns)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5);
    
    for (const [pattern, hashes] of sortedPatterns) {
        console.log(`  Pattern "${pattern}": ${hashes.length} transactions`);
    }
    
    // Sample transaction detail
    if (transactions.length > 0) {
        console.log('\nExample Transaction Detail:');
        const exampleTx = transactions[0];
        console.log(JSON.stringify(exampleTx, null, 2));
    }
    
    console.log('\n=== ANALYSIS COMPLETE ===');
}

/**
 * Main function
 */
async function main() {
    try {
        console.log(`Parsing CSV file: ${CSV_FILE}`);
        const transactions = await parseCSV(CSV_FILE);
        console.log(`Successfully parsed ${transactions.length} transactions`);
        
        analyzeTransactionPatterns(transactions);
    } catch (error) {
        console.error('Error analyzing CSV:', error);
    }
}

// Run the analysis
main().catch(console.error);