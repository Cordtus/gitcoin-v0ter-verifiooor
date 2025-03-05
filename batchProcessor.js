// batchProcessor.js
// Efficient batch processing for votes with reduced disk I/O and optimized memory usage

/**
 * This module provides optimized batch processing for vote data:
 * 1. Batches database writes to minimize disk I/O
 * 2. Processes votes in parallel batches for better performance
 * 3. Uses in-memory caching with periodic flushing to disk
 * 4. Provides detailed statistics and reporting functionality
 */

import { sleep } from './utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Performance optimization settings
const PARALLEL_BALANCE_CHECKS = Math.max(5, Math.min(os.cpus().length, 20)); // Cap between 5-20
const BALANCE_CHECK_THROTTLE_MS = 10; // 10ms delay between balance check batches
const SAVE_INTERVAL_MS = 30 * 1000; // Save every 30 seconds
const MIN_BATCH_SIZE_FOR_SAVE = 10; // Minimum batch size to trigger save

// In-memory storage with periodic flushing
export class BatchProcessor {
  constructor(walletsFile, votesFile, onProcessed = null) {
    this.walletsFile = walletsFile;
    this.votesFile = votesFile;
    this.onProcessed = onProcessed;
    
    // In-memory data
    this.wallets = new Map();
    this.votes = new Map();
    
    // Pending changes
    this.pendingVotes = [];
    this.processing = false;
    this.pendingWalletChanges = new Set();
    this.pendingVoteChanges = new Set();
    
    // Stats
    this.processedCount = 0;
    this.lastSaveTime = Date.now();
    
    // Load existing data
    this.loadData();
    
    // Set up auto-save interval
    this.saveInterval = setInterval(() => this.saveIfNeeded(true), SAVE_INTERVAL_MS);
  }
  
  /**
   * Load wallet and vote data from files
   */
  loadData() {
    try {
      // Load wallets
      if (fs.existsSync(this.walletsFile)) {
        const walletsData = JSON.parse(fs.readFileSync(this.walletsFile, 'utf8'));
        this.wallets = new Map(walletsData);
        console.log(`Loaded ${this.wallets.size} wallets from ${this.walletsFile}`);
      }
      
      // Load votes
      if (fs.existsSync(this.votesFile)) {
        const votesData = JSON.parse(fs.readFileSync(this.votesFile, 'utf8'));
        this.votes = new Map(votesData);
        console.log(`Loaded ${this.votes.size} votes from ${this.votesFile}`);
      }
    } catch (error) {
      console.error('Error loading data:', error.message);
    }
  }
  
  /**
   * Save data to disk if there are changes
   * @param {boolean} force Force save even if minimum conditions not met
   */
  saveIfNeeded(force = false) {
    const now = Date.now();
    const timeSinceLastSave = now - this.lastSaveTime;
    
    // Check if we need to save
    if (force || 
        this.pendingWalletChanges.size >= MIN_BATCH_SIZE_FOR_SAVE || 
        this.pendingVoteChanges.size >= MIN_BATCH_SIZE_FOR_SAVE ||
        timeSinceLastSave >= SAVE_INTERVAL_MS) {
      
      // Only save if we have changes
      if (this.pendingWalletChanges.size > 0 || this.pendingVoteChanges.size > 0) {
        this.saveData();
      }
    }
  }
  
  /**
   * Save all data to disk
   */
  saveData() {
    try {
      console.log(`Saving data: ${this.pendingWalletChanges.size} wallet changes, ${this.pendingVoteChanges.size} vote changes`);
      
      // Save wallets if changed
      if (this.pendingWalletChanges.size > 0) {
        const walletsData = JSON.stringify(Array.from(this.wallets.entries()), null, 2);
        fs.writeFileSync(this.walletsFile, walletsData, 'utf8');
        this.pendingWalletChanges.clear();
      }
      
      // Save votes if changed
      if (this.pendingVoteChanges.size > 0) {
        const votesData = JSON.stringify(Array.from(this.votes.entries()), null, 2);
        fs.writeFileSync(this.votesFile, votesData, 'utf8');
        this.pendingVoteChanges.clear();
      }
      
      this.lastSaveTime = Date.now();
    } catch (error) {
      console.error('Error saving data:', error.message);
    }
  }
  
  /**
   * Add a vote to the processing queue
   * @param {Object} vote Vote object
   */
  addVote(vote) {
    // Add to pending queue
    this.pendingVotes.push(vote);
    
    // Trigger processing if not already in progress
    if (!this.processing) {
      this.processPendingVotes();
    }
  }
  
  /**
   * Add multiple votes to the processing queue
   * @param {Array} votes Array of vote objects
   */
  addVotes(votes) {
    if (!votes || votes.length === 0) return;
    
    // Add votes to pending queue
    this.pendingVotes.push(...votes);
    
    // Trigger processing if not already in progress
    if (!this.processing) {
      this.processPendingVotes();
    }
  }
  
  /**
   * Process votes in the pending queue
   */
  async processPendingVotes() {
    if (this.processing || this.pendingVotes.length === 0) {
      return;
    }
    
    this.processing = true;
    
    try {
      // Take a batch from the queue
      const votesToProcess = [...this.pendingVotes];
      this.pendingVotes = [];
      
      console.log(`Processing batch of ${votesToProcess.length} votes...`);
      
      // Process votes in smaller sub-batches for balance checks
      const subBatches = [];
      for (let i = 0; i < votesToProcess.length; i += PARALLEL_BALANCE_CHECKS) {
        subBatches.push(votesToProcess.slice(i, i + PARALLEL_BALANCE_CHECKS));
      }
      
      for (const subBatch of subBatches) {
        // Process votes in parallel
        await Promise.all(subBatch.map(vote => this.processVote(vote)));
        
        // Brief pause between sub-batches
        await sleep(BALANCE_CHECK_THROTTLE_MS);
      }
      
      // Update processed count
      this.processedCount += votesToProcess.length;
      
      // Save data if needed
      this.saveIfNeeded();
      
      // Check if more votes arrived during processing
      if (this.pendingVotes.length > 0) {
        setImmediate(() => this.processPendingVotes());
      }
    } catch (error) {
      console.error('Error processing votes:', error.message);
    } finally {
      this.processing = false;
    }
  }
  
  /**
   * Process a single vote
   * @param {Object} vote Vote object with transaction data
   * @returns {Promise<boolean>} Success status
   */
  async processVote(vote) {
    try {
      const { transactionHash, from, cosmosAddress, blockNumber, timestamp, balanceAtVote, balanceBeforeVote, minSeiRequired } = vote;
      
      // Skip if already processed
      if (this.votes.has(transactionHash)) {
        return false;
      }
      
      // Standardize address
      const evmAddress = from.toLowerCase();
      
      // Format balances to 6 decimal places (if supplied)
      const formattedBalanceAtVote = typeof balanceAtVote === 'number' 
        ? Number(balanceAtVote.toFixed(6)) 
        : null;
        
      const formattedBalanceBeforeVote = typeof balanceBeforeVote === 'number'
        ? Number(balanceBeforeVote.toFixed(6))
        : null;
      
      // Initial validity check if balances provided
      const isValid = formattedBalanceAtVote !== null && formattedBalanceBeforeVote !== null
        ? formattedBalanceAtVote >= minSeiRequired && formattedBalanceBeforeVote >= minSeiRequired
        : null;
      
      // Create vote record
      const voteRecord = {
        txHash: transactionHash,
        evmAddress,
        cosmosAddress,
        blockNumber,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
        balanceAtVote: formattedBalanceAtVote,
        balanceBeforeVote: formattedBalanceBeforeVote,
        isValid,
        finalIsValid: null, // Will be set at the end of voting period
        method: vote.method || 'unknown'
      };
      
      // Store vote
      this.votes.set(transactionHash, voteRecord);
      this.pendingVoteChanges.add(transactionHash);
      
      // Add or update wallet info
      if (!this.wallets.has(evmAddress)) {
        this.wallets.set(evmAddress, {
          evmAddress,
          cosmosAddress,
          balances: {},
          votes: [],
          finalBalance: null,
          finalBalanceValid: null
        });
      }
      
      const wallet = this.wallets.get(evmAddress);
      
      // Update balances if provided
      if (formattedBalanceAtVote !== null) {
        wallet.balances[blockNumber] = formattedBalanceAtVote;
      }
      
      if (formattedBalanceBeforeVote !== null) {
        wallet.balances[blockNumber - 1] = formattedBalanceBeforeVote;
      }
      
      // Add vote reference if not already present
      if (!wallet.votes.includes(transactionHash)) {
        wallet.votes.push(transactionHash);
      }
      
      // Mark wallet as changed
      this.pendingWalletChanges.add(evmAddress);
      
      // Notify of processed vote if callback provided
      if (this.onProcessed) {
        this.onProcessed(voteRecord);
      }
      
      return true;
    } catch (error) {
      console.error(`Error processing vote ${vote.transactionHash}:`, error.message);
      return false;
    }
  }
  
  /**
   * Update balances for a vote
   * @param {string} txHash Transaction hash
   * @param {number} balanceAtVote Balance at vote
   * @param {number} balanceBeforeVote Balance before vote
   * @param {number} minSeiRequired Minimum SEI required
   * @returns {boolean} Success status
   */
  updateVoteBalances(txHash, balanceAtVote, balanceBeforeVote, minSeiRequired) {
    if (!this.votes.has(txHash)) {
      return false;
    }
    
    const vote = this.votes.get(txHash);
    
    // Format balances
    const formattedBalanceAtVote = Number(balanceAtVote.toFixed(6));
    const formattedBalanceBeforeVote = Number(balanceBeforeVote.toFixed(6));
    
    // Update vote record
    vote.balanceAtVote = formattedBalanceAtVote;
    vote.balanceBeforeVote = formattedBalanceBeforeVote;
    vote.isValid = formattedBalanceAtVote >= minSeiRequired && formattedBalanceBeforeVote >= minSeiRequired;
    
    // Mark vote as changed
    this.pendingVoteChanges.add(txHash);
    
    // Update wallet balances
    if (this.wallets.has(vote.evmAddress)) {
      const wallet = this.wallets.get(vote.evmAddress);
      wallet.balances[vote.blockNumber] = formattedBalanceAtVote;
      wallet.balances[vote.blockNumber - 1] = formattedBalanceBeforeVote;
      
      // Mark wallet as changed
      this.pendingWalletChanges.add(vote.evmAddress);
    }
    
    return true;
  }
  
  /**
   * Check final balances for all wallets
   * @param {number} finalBlockHeight Final block height
   * @param {number} minSeiRequired Minimum SEI required
   * @param {Function} getBalanceFunc Function to get balance (address, block) => Promise<number>
   */
  async checkFinalBalances(finalBlockHeight, minSeiRequired, getBalanceFunc) {
    console.log(`Checking final balances at block ${finalBlockHeight} for ${this.wallets.size} wallets...`);
    
    // Process wallets in batches
    const walletAddresses = Array.from(this.wallets.keys());
    const batches = [];
    
    for (let i = 0; i < walletAddresses.length; i += PARALLEL_BALANCE_CHECKS) {
      batches.push(walletAddresses.slice(i, i + PARALLEL_BALANCE_CHECKS));
    }
    
    let processedCount = 0;
    
    for (const batch of batches) {
      await Promise.all(batch.map(async (evmAddress) => {
        const wallet = this.wallets.get(evmAddress);
        
        // Skip wallets with no votes
        if (!wallet.votes || wallet.votes.length === 0) {
          return;
        }
        
        try {
          // Get final balance
          const finalBalance = await getBalanceFunc(wallet.cosmosAddress, finalBlockHeight);
          
          // Format to 6 decimal places
          const formattedBalance = Number(finalBalance.toFixed(6));
          
          // Update wallet
          wallet.finalBalance = formattedBalance;
          wallet.finalBalanceValid = formattedBalance >= minSeiRequired;
          
          // Mark wallet as changed
          this.pendingWalletChanges.add(evmAddress);
          
          // Update validity of all votes for this wallet
          for (const txHash of wallet.votes) {
            const vote = this.votes.get(txHash);
            if (vote) {
              vote.finalIsValid = vote.isValid && wallet.finalBalanceValid;
              this.pendingVoteChanges.add(txHash);
            }
          }
        } catch (error) {
          console.error(`Failed to check balance for wallet ${evmAddress}:`, error.message);
          wallet.finalBalance = 0;
          wallet.finalBalanceValid = false;
          
          // Mark as changed
          this.pendingWalletChanges.add(evmAddress);
          
          // Mark votes as invalid
          for (const txHash of wallet.votes) {
            const vote = this.votes.get(txHash);
            if (vote) {
              vote.finalIsValid = false;
              this.pendingVoteChanges.add(txHash);
            }
          }
        }
      }));
      
      // Update processed count
      processedCount += batch.length;
      console.log(`Processed ${processedCount}/${walletAddresses.length} wallets...`);
      
      // Save periodically
      if (this.pendingWalletChanges.size > 50 || this.pendingVoteChanges.size > 50) {
        this.saveData();
      }
      
      // Brief pause between batches
      await sleep(BALANCE_CHECK_THROTTLE_MS);
    }
    
    // Final save
    this.saveData();
    
    console.log('Final balance check complete.');
  }
  
  /**
   * Get statistics about the data
   * @returns {Object} Statistics
   */
  getStats() {
    // Count valid votes
    let validVotes = 0;
    let finalValidVotes = 0;
    
    for (const vote of this.votes.values()) {
      if (vote.isValid) validVotes++;
      if (vote.finalIsValid) finalValidVotes++;
    }
    
    // Count wallets with valid votes
    let walletsWithValidVotes = 0;
    
    for (const wallet of this.wallets.values()) {
      if (wallet.finalBalanceValid && wallet.votes.some(txHash => {
        const vote = this.votes.get(txHash);
        return vote && vote.finalIsValid;
      })) {
        walletsWithValidVotes++;
      }
    }
    
    return {
      totalVotes: this.votes.size,
      validVotes,
      finalValidVotes,
      validVotePercentage: this.votes.size > 0 ? (validVotes / this.votes.size * 100).toFixed(2) : '0.00',
      finalValidVotePercentage: this.votes.size > 0 ? (finalValidVotes / this.votes.size * 100).toFixed(2) : '0.00',
      totalWallets: this.wallets.size,
      walletsWithValidVotes,
      validWalletPercentage: this.wallets.size > 0 ? (walletsWithValidVotes / this.wallets.size * 100).toFixed(2) : '0.00',
      processingQueue: this.pendingVotes.length,
      pendingChanges: {
        wallets: this.pendingWalletChanges.size,
        votes: this.pendingVoteChanges.size
      }
    };
  }
  
  /**
   * Generate report files (CSV format)
   * @param {string} voteReportFile Vote report file path
   * @param {string} walletReportFile Wallet report file path
   * @param {number} minSeiRequired Minimum SEI required
   */
  generateReports(voteReportFile, walletReportFile, minSeiRequired) {
    // Save any pending changes first
    this.saveData();
    
    // Generate vote report CSV
    let voteReport = 'txHash,evmAddress,cosmosAddress,blockNumber,timestamp,balanceAtVote,balanceBeforeVote,method,isValid,finalIsValid\n';
    
    for (const [txHash, vote] of this.votes.entries()) {
      voteReport += `${txHash},${vote.evmAddress},${vote.cosmosAddress},${vote.blockNumber},${vote.timestamp},${vote.balanceAtVote},${vote.balanceBeforeVote},${vote.method},${vote.isValid},${vote.finalIsValid}\n`;
    }
    
    fs.writeFileSync(voteReportFile, voteReport, 'utf8');
    
    // Generate wallet report CSV
    let walletReport = 'evmAddress,cosmosAddress,voteCount,validVoteCount,finalBalance,finalBalanceValid\n';
    
    for (const [evmAddress, wallet] of this.wallets.entries()) {
      const voteCount = wallet.votes.length;
      let validVoteCount = 0;
      
      for (const txHash of wallet.votes) {
        const vote = this.votes.get(txHash);
        if (vote && vote.finalIsValid) {
          validVoteCount++;
        }
      }
      
      walletReport += `${evmAddress},${wallet.cosmosAddress},${voteCount},${validVoteCount},${wallet.finalBalance || 0},${wallet.finalBalanceValid || false}\n`;
    }
    
    fs.writeFileSync(walletReportFile, walletReport, 'utf8');
    
    console.log(`Reports generated at:\n- Votes: ${voteReportFile}\n- Wallets: ${walletReportFile}`);
    
    return {
      voteReport: voteReportFile,
      walletReport: walletReportFile
    };
  }
  
  /**
   * Generate a detailed JSON statistics file
   * @param {string} statsFile Path to save statistics
   * @param {Object} additionalInfo Additional information to include
   */
  generateStatsFile(statsFile, additionalInfo = {}) {
    try {
      // Calculate statistics
      const totalVotes = this.votes.size;
      const validVotes = Array.from(this.votes.values()).filter(vote => vote.finalIsValid).length;
      const totalWallets = this.wallets.size;
      const walletsWithValidVotes = Array.from(this.wallets.values()).filter(wallet => 
        wallet.finalBalanceValid && 
        wallet.votes.some(txHash => {
          const vote = this.votes.get(txHash);
          return vote && vote.finalIsValid;
        })
      ).length;
      
      // Calculate vote amounts
      let totalSeiVoted = 0;
      let validSeiVoted = 0;
      
      for (const vote of this.votes.values()) {
        // Extract vote amount from transaction
        const voteAmount = vote.voteAmount || vote.value || 0; 
        
        totalSeiVoted += voteAmount;
        if (vote.finalIsValid) {
          validSeiVoted += voteAmount;
        }
      }
      
      // Categorize wallets by vote count
      const voteCountCategories = {
        singleVote: 0,
        twoToFiveVotes: 0,
        sixToTenVotes: 0,
        moreThanTenVotes: 0
      };
      
      for (const wallet of this.wallets.values()) {
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
      
      for (const wallet of this.wallets.values()) {
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
      const topVoters = Array.from(this.wallets.values())
        .map(wallet => ({
          address: wallet.evmAddress,
          cosmosAddress: wallet.cosmosAddress,
          voteCount: wallet.votes.length,
          validVoteCount: wallet.votes.filter(txHash => {
            const vote = this.votes.get(txHash);
            return vote && vote.finalIsValid;
          }).length,
          totalVoted: wallet.votes.reduce((sum, txHash) => {
            const vote = this.votes.get(txHash);
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
          totalSeiVoted,
          validSeiVoted,
          validSeiPercentage: (validSeiVoted / totalSeiVoted * 100).toFixed(2)
        },
        walletCategories: {
          byVoteCount: voteCountCategories,
          byBalanceRange: balanceCategories
        },
        topVoters,
        ...additionalInfo
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
  
  /**
   * Clean up resources
   */
  cleanup() {
    // Save any pending changes
    this.saveData();
    
    // Clear interval
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    
    console.log('Batch processor cleaned up');
  }
}