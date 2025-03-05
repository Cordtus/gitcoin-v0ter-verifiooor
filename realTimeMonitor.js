// real-time-monitor.js
// Implements websocket-based and polling-based real-time monitoring for new votes

import { ethers } from 'ethers';
import { retry, sleep } from './utils.js';
import { scanBlockRangeForVotes } from './blockScanner.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connection settings
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;
const WEBSOCKET_PING_INTERVAL_MS = 30000;
const POLLING_INTERVAL_MS = 5000;
const POLLING_BATCH_SIZE = 20;

/**
 * Create a websocket provider with auto-reconnect
 * @param {string} wsUrl WebSocket URL
 * @returns {Promise<ethers.WebSocketProvider>} WebSocket provider
 */
async function createWebSocketProvider(wsUrl) {
  try {
    const provider = new ethers.WebSocketProvider(wsUrl);
    
    // Set up ping to keep connection alive
    const pingInterval = setInterval(() => {
      provider.send('net_version', [])
        .catch(err => console.warn('WebSocket ping failed:', err.message));
    }, WEBSOCKET_PING_INTERVAL_MS);
    
    // Store the interval so we can clear it later
    provider._pingInterval = pingInterval;
    
    // Test the connection
    await provider.getBlockNumber();
    
    console.log('WebSocket connection established');
    return provider;
  } catch (error) {
    console.error('Failed to create WebSocket provider:', error.message);
    throw error;
  }
}

/**
 * Monitor for new votes using WebSockets (preferred) or polling (fallback)
 * @param {number} startBlock Block to start monitoring from
 * @param {Array<string>} addresses Contract addresses [proxy, implementation]
 * @param {Object} endpoints RPC endpoints with primary/fallback and ws URLs
 * @param {Function} onVoteFound Callback for when a vote is found
 * @param {Function} onBlockProcessed Callback for when a block is processed (optional)
 * @param {Date} endDate Date when voting period ends (optional)
 * @returns {Object} Monitor controller with stop method
 */
export function monitorForVotes(
  startBlock,
  addresses,
  endpoints,
  onVoteFound,
  onBlockProcessed = null,
  endDate = null
) {
  let isRunning = true;
  let currentBlock = startBlock;
  let wsProvider = null;
  let httpProvider = null;
  let reconnectAttempts = 0;
  let pollInterval = null;
  
  // Function to clean up resources
  const cleanup = () => {
    isRunning = false;
    
    if (wsProvider) {
      if (wsProvider._pingInterval) {
        clearInterval(wsProvider._pingInterval);
      }
      wsProvider.removeAllListeners();
      wsProvider.destroy();
      wsProvider = null;
    }
    
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    
    if (httpProvider && typeof httpProvider.destroy === 'function') {
      httpProvider.destroy();
      httpProvider = null;
    }
  };
  
  // Check if voting period has ended
  const checkVotingEnded = async (blockNumber) => {
    if (!endDate) return false;
    
    try {
      // Get block timestamp
      const block = await httpProvider.getBlock(blockNumber);
      if (!block) return false;
      
      const blockTime = new Date(Number(block.timestamp) * 1000);
      return blockTime >= endDate;
    } catch (error) {
      console.error('Error checking if voting period ended:', error.message);
      return false;
    }
  };
  
  // WebSocket-based monitoring
  const startWebSocketMonitoring = async () => {
    try {
      wsProvider = await createWebSocketProvider(endpoints.primary.evmWs || endpoints.primary.ws);
      
      // Subscribe to new blocks
      wsProvider.on('block', async (blockNumber) => {
        if (!isRunning) return;
        
        try {
          // Don't process blocks we've already seen
          if (blockNumber <= currentBlock) return;
          
          console.log(`New block detected: ${blockNumber}`);
          
          // Scan the block range from last processed to current
          if (blockNumber > currentBlock + 1) {
            // If we missed blocks, scan the range
            console.log(`Catching up - scanning blocks ${currentBlock + 1} to ${blockNumber}`);
            const votes = await scanBlockRangeForVotes(
              currentBlock + 1,
              blockNumber,
              addresses,
              endpoints.primary.evmRpc,
              endpoints.fallback.evmRpc
            );
            
            // Process discovered votes
            for (const vote of votes) {
              onVoteFound(vote);
            }
          } else {
            // Just scan the single new block
            const block = await wsProvider.getBlock(blockNumber, true);
            
            if (block && block.transactions) {
              // Process the block directly
              // Filter transactions related to voting contracts
              const proxyAddress = addresses[0].toLowerCase();
              const implAddress = addresses[1].toLowerCase();
              
              const relevantTxs = block.transactions.filter(tx => 
                typeof tx === 'object' && tx.to && (
                  tx.to.toLowerCase() === proxyAddress || 
                  tx.to.toLowerCase() === implAddress
                )
              );
              
              if (relevantTxs.length > 0) {
                console.log(`Found ${relevantTxs.length} potential vote transactions in block ${blockNumber}`);
                
                for (const tx of relevantTxs) {
                  // Check receipt
                  const receipt = await wsProvider.getTransactionReceipt(tx.hash);
                  
                  if (!receipt || receipt.status !== 1) continue;
                  
                  // Vote detection logic
                  const isDirectVote = tx.to.toLowerCase() === proxyAddress && tx.value > 0n;
                  
                  const isProxyMethodCall = 
                    tx.to.toLowerCase() === proxyAddress && 
                    tx.data && tx.data.length > 2;
                  
                  const hasImplLogs = receipt.logs && receipt.logs.some(log => 
                    log.address && log.address.toLowerCase() === implAddress
                  );
                  
                  const hasProxyLogs = receipt.logs && receipt.logs.some(log => 
                    log.address && log.address.toLowerCase() === proxyAddress
                  );
                  
                  let detectionMethod = null;
                  if (isDirectVote) {
                    detectionMethod = 'direct-transfer';
                  } else if (isProxyMethodCall && (hasImplLogs || hasProxyLogs)) {
                    detectionMethod = 'proxy-method-call';
                  } else if (hasImplLogs) {
                    detectionMethod = 'implementation-logs';
                  } else if (hasProxyLogs) {
                    detectionMethod = 'proxy-logs';
                  }
                  
                  // Is this a vote?
                  const isVote = !!(isDirectVote || 
                                  (isProxyMethodCall && (hasImplLogs || hasProxyLogs)) || 
                                  hasImplLogs || 
                                  hasProxyLogs);
                  
                  if (isVote) {
                    const voteAmount = isDirectVote ? Number(ethers.formatEther(tx.value)) : 0;
                    
                    const voteInfo = {
                      transactionHash: tx.hash,
                      blockNumber: Number(block.number),
                      from: tx.from,
                      to: tx.to,
                      value: isDirectVote ? Number(ethers.formatEther(tx.value)) : 0,
                      voteAmount: voteAmount,
                      timestamp: new Date(Number(block.timestamp) * 1000),
                      method: detectionMethod,
                      success: true
                    };
                    
                    console.log(`Vote found: ${tx.hash} (method: ${detectionMethod})`);
                    onVoteFound(voteInfo);
                  }
                }
              }
            }
          }
          
          // Update current block
          currentBlock = blockNumber;
          
          // Call block processed callback if provided
          if (onBlockProcessed) {
            onBlockProcessed(blockNumber);
          }
          
          // Check if voting period has ended
          if (endDate && await checkVotingEnded(blockNumber)) {
            console.log('Voting period has ended, stopping monitor');
            cleanup();
          }
          
          // Reset reconnect attempts on successful processing
          reconnectAttempts = 0;
        } catch (err) {
          console.error(`Error processing block ${blockNumber}:`, err.message);
        }
      });
      
      // Handle connection errors
      wsProvider.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        // Will trigger reconnect
      });
      
      // Handle disconnection
      wsProvider._websocket.on('close', () => {
        console.log('WebSocket connection closed');
        
        // Clean up existing connection
        if (wsProvider._pingInterval) {
          clearInterval(wsProvider._pingInterval);
        }
        wsProvider.removeAllListeners();
        
        // Reconnect logic
        if (isRunning) {
          reconnectAttempts++;
          
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            const delay = RECONNECT_DELAY_MS * Math.min(reconnectAttempts, 5);
            console.log(`Attempting to reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            
            setTimeout(() => {
              if (isRunning) {
                console.log('Reconnecting WebSocket...');
                startWebSocketMonitoring().catch(() => {
                  // If WebSockets fail completely, fall back to polling
                  if (isRunning && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.log('WebSocket reconnection failed, falling back to polling');
                    startPollingMonitoring();
                  }
                });
              }
            }, delay);
          } else {
            console.log('Maximum WebSocket reconnection attempts reached, falling back to polling');
            startPollingMonitoring();
          }
        }
      });
      
      return true;
    } catch (error) {
      console.error('Failed to start WebSocket monitoring:', error.message);
      return false;
    }
  };
  
  // HTTP polling-based monitoring (fallback)
  const startPollingMonitoring = async () => {
    try {
      // Create HTTP provider if needed
      if (!httpProvider) {
        httpProvider = new ethers.JsonRpcProvider(endpoints.primary.evmRpc);
        
        // Test connection
        await httpProvider.getBlockNumber();
      }
      
      console.log(`Starting polling monitor from block ${currentBlock}`);
      
      // Start polling loop
      pollInterval = setInterval(async () => {
        if (!isRunning) return;
        
        try {
          // Get latest block
          const latestBlock = await httpProvider.getBlockNumber();
          
          if (latestBlock <= currentBlock) {
            // No new blocks
            return;
          }
          
          // Don't process too many blocks at once
          const toBlock = Math.min(latestBlock, currentBlock + POLLING_BATCH_SIZE);
          
          console.log(`Polling: processing blocks ${currentBlock + 1} to ${toBlock}`);
          
          // Scan for votes
          const newVotes = await scanBlockRangeForVotes(
            currentBlock + 1,
            toBlock,
            addresses,
            endpoints.primary.evmRpc,
            endpoints.fallback.evmRpc
          );
          
          // Process found votes
          if (newVotes.length > 0) {
            console.log(`Found ${newVotes.length} votes through polling`);
            
            for (const vote of newVotes) {
              onVoteFound(vote);
            }
          }
          
          // Update current block
          currentBlock = toBlock;
          
          // Notify of block processing
          if (onBlockProcessed) {
            onBlockProcessed(toBlock);
          }
          
          // Check if voting period has ended
          if (endDate && await checkVotingEnded(toBlock)) {
            console.log('Voting period has ended, stopping monitor');
            cleanup();
          }
          
          // Reset reconnect attempts on success
          reconnectAttempts = 0;
        } catch (error) {
          console.error('Error in polling cycle:', error.message);
          
          // Handle connection errors
          reconnectAttempts++;
          
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            // Try to recreate the provider
            console.log('Recreating HTTP provider due to persistent errors');
            
            if (httpProvider && typeof httpProvider.destroy === 'function') {
              httpProvider.destroy();
            }
            
            try {
              httpProvider = new ethers.JsonRpcProvider(endpoints.primary.evmRpc);
              reconnectAttempts = 0;
            } catch (err) {
              console.error('Failed to recreate HTTP provider:', err.message);
              
              // Try fallback
              try {
                httpProvider = new ethers.JsonRpcProvider(endpoints.fallback.evmRpc);
                reconnectAttempts = 0;
                console.log('Successfully switched to fallback HTTP provider');
              } catch (fallbackErr) {
                console.error('Failed to create fallback HTTP provider:', fallbackErr.message);
              }
            }
          }
        }
      }, POLLING_INTERVAL_MS);
      
      return true;
    } catch (error) {
      console.error('Failed to start polling monitor:', error.message);
      return false;
    }
  };
  
  // Start monitoring - try WebSockets first, fall back to polling
  const start = async () => {
    // Create HTTP provider for various operations
    try {
      httpProvider = new ethers.JsonRpcProvider(endpoints.primary.evmRpc);
    } catch (err) {
      console.error('Failed to create primary HTTP provider:', err.message);
      httpProvider = new ethers.JsonRpcProvider(endpoints.fallback.evmRpc);
    }
    
    // Try WebSocket first if available
    if (endpoints.primary.evmWs || endpoints.primary.ws) {
      console.log('Attempting to use WebSocket monitoring...');
      
      try {
        const success = await startWebSocketMonitoring();
        if (success) {
          console.log('WebSocket monitoring started successfully');
          return;
        }
      } catch (error) {
        console.error('WebSocket monitoring failed to start:', error.message);
      }
    }
    
    // Fall back to polling
    console.log('Falling back to polling monitoring');
    startPollingMonitoring();
  };
  
  // Start the monitor
  start();
  
  // Return controller object
  return {
    stop: () => {
      console.log('Stopping vote monitor');
      cleanup();
    },
    
    getCurrentBlock: () => currentBlock,
    
    isWebSocketActive: () => !!wsProvider,
    
    forceRescan: async (fromBlock, toBlock) => {
      console.log(`Forcing rescan of blocks ${fromBlock} to ${toBlock}`);
      
      return scanBlockRangeForVotes(
        fromBlock,
        toBlock,
        addresses,
        endpoints.primary.evmRpc,
        endpoints.fallback.evmRpc,
        onVoteFound
      );
    }
  };
}

/**
 * Save monitor checkpoint to file
 * @param {number} blockNumber Last processed block
 * @param {string} filePath Path to save the checkpoint
 */
export function saveMonitorCheckpoint(blockNumber, filePath = null) {
  const checkpointFile = filePath || path.join(__dirname, 'monitor_checkpoint.json');
  
  const checkpoint = {
    lastBlock: blockNumber,
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint, null, 2), 'utf8');
}

/**
 * Load monitor checkpoint from file
 * @param {string} filePath Path to the checkpoint file
 * @returns {number|null} Last processed block or null if file doesn't exist
 */
export function loadMonitorCheckpoint(filePath = null) {
  const checkpointFile = filePath || path.join(__dirname, 'monitor_checkpoint.json');
  
  if (!fs.existsSync(checkpointFile)) {
    return null;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    return data.lastBlock;
  } catch (error) {
    console.error('Error loading checkpoint:', error.message);
    return null;
  }
}