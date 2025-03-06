/**
 * Central configuration for SEI Voting Monitor
 */

// Contract addresses - normalized to lowercase for consistency
export const PROXY_ADDRESS = '0x1E18cdce56B3754c4Dca34CB3a7439C24E8363de'.toLowerCase();
export const IMPLEMENTATION_ADDRESS = '0x05b939069163891997C879288f0BaaC3faaf4500'.toLowerCase();
export const VOTE_METHOD_SIG = '0xc7b8896b'; // Verified vote method signature
export const MIN_SEI_REQUIRED = 100; // 100 SEI minimum balance

// Voting period dates in UTC 
export const VOTING_START_DATE = new Date('2025/02/27 05:00Z');
export const VOTING_END_DATE = new Date('2025/03/12 17:00Z');

// SEI blockchain parameters
export const SEI_BLOCK_TIME_MS = 400; // Average block time in milliseconds
export const USEI_TO_SEI = 1000000; // 1 SEI = 1,000,000 uSEI
export const WEI_DECIMALS = 18;     // 1 SEI = 10^18 wei (asei)
export const DISPLAY_DECIMALS = 6;  // Keep 6 decimal places for display

// RPC endpoints with fallback options
export const RPC_ENDPOINTS = {
    primary: {
        rpc: 'https://rpc.sei.basementnodes.ca',
        rest: 'https://api.sei.basementnodes.ca',
        evmRpc: 'https://evm-rpc.sei.basementnodes.ca',
        evmWs: 'wss://evm-ws.sei.basementnodes.ca',
        cosmos: 'https://rpc.sei.basementnodes.ca'
    },
    fallback: {
        rpc: 'https://rpc.sei-main-eu.ccvalidators.com:443',
        rest: 'https://rest.sei-main-eu.ccvalidators.com:443',
        evmRpc: 'https://evm.sei-main-eu.ccvalidators.com:443',
        evmWs: 'wss://evm-ws.sei-main-eu.ccvalidators.com:443',
        cosmos: 'https://rpc.sei-main-eu.ccvalidators.com:443'
    }
};

// API endpoints
export const WALLET_CONVERTER_API = 'https://wallets.sei.basementnodes.ca';

// Performance tuning
export const MEMORY = {
    WARNING_THRESHOLD: 1024,  // 1GB
    CRITICAL_THRESHOLD: 1536, // 1.5GB
    TARGET_USAGE: 768,        // 750MB
    CHECK_INTERVAL: 15 * 60 * 1000, // 15 minutes
    REPORT_INTERVAL: 15 * 60 * 1000 // 15 minutes
};

export const CACHE = {
    MAX_BLOCKS: 5000,
    MAX_TXS: 10000,
    MAX_RECEIPTS: 5000,
    MAX_ADDRESSES: 2000,
    MAX_BALANCES: 10000
};

export const BATCH = {
    PARALLEL_BALANCE_CHECKS: 20,
    BALANCE_CHECK_THROTTLE_MS: 10,
    INITIAL_FETCH_SIZE: 12500,
    LIVE_FETCH_SIZE: 100,
    POLLING_INTERVAL_MS: 5000,
    SAVE_CHECKPOINT_INTERVAL_MS: 5 * 60 * 1000 // 5 minutes
};

// Connection settings
export const CONNECTION = {
    MAX_RECONNECT_ATTEMPTS: 10,
    RECONNECT_DELAY_MS: 5000,
    WEBSOCKET_PING_INTERVAL_MS: 30000
};

// File paths
export const PATHS = {
    DATA_DIR: './data',
    WALLETS_FILE: './data/wallets.json',
    VOTES_FILE: './data/votes.json', 
    LAST_BLOCK_FILE: './data/last_processed_block.txt',
    LOCK_FILE: './data/monitor.lock',
    MONITOR_CHECKPOINT: './data/monitor_checkpoint.json',
    REPORT: {
        VOTES: './data/voting_report.csv',
        WALLETS: './data/wallet_report.csv',
        STATS: './data/voting_statistics.json'
    }
};