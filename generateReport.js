// generateReport.js - Generate reports for voting data

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Import configuration
import { 
  RPC_ENDPOINTS, 
  PATHS, 
  MIN_SEI_REQUIRED, 
  VOTING_START_DATE,
  VOTING_END_DATE
} from './config.js';

// Import functionality 
import { ethers } from 'ethers';
import * as walletBalances from './walletBalances.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate final report
 */
export async function generateReport() {
    console.log('Generating final voting report...');
    
    try {
        // Get current block for final balance check
        let currentBlock;
        try {
            const provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.primary.evmRpc);
            currentBlock = await provider.getBlockNumber();
        } catch (error) {
            console.error('Error getting current block from primary RPC:', error.message);
            const fallbackProvider = new ethers.JsonRpcProvider(RPC_ENDPOINTS.fallback.evmRpc);
            currentBlock = await fallbackProvider.getBlockNumber();
        }
        console.log(`Current block for report: ${currentBlock}`);
        
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
        await walletBalances.generateReport(
            PATHS.WALLETS_FILE, 
            PATHS.VOTES_FILE, 
            MIN_SEI_REQUIRED,
            PATHS.REPORT.VOTES,
            PATHS.REPORT.WALLETS
        );
        
        console.log('Report generation complete.');
    } catch (error) {
        console.error('Error generating final report:', error);
        throw error;
    }
}

// Run the report generation if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    generateReport().catch(console.error);
}