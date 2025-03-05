# SEI Voting Monitor

Tracking and validating wallet voting activity for SEI Gitcoin funding rounds 6 and 7.

## Overview

This system monitors voting activities on a specific SEI blockchain contract and ensures that votes only count if the wallets maintain a minimum of 100 SEI throughout the voting process - specifically:

1. At the time of voting
2. One block before voting
3. At the end of the voting period

## Data Collection Methodology

### Vote Transaction Discovery

The system uses two complementary methods to find voting transactions:

1. **Primary Method: Internal Transaction Tracing**
   - Uses `trace_filter` JSON-RPC API to find internal transactions from the proxy contract to the implementation contract
   - Directly identifies token transfers that represent votes
   - More efficient and accurate than event scanning for this specific contract design
   - Example query:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "trace_filter",
       "params": [{
         "fromBlock": "0x807d110",
         "toBlock": "0x8081f30",
         "fromAddress": ["0x1e18cdce56b3754c4dca34cb3a7439c24e8363de"],
         "toAddress": ["0x05b939069163891997c879288f0baac3faaf4500"],
         "after": 0,
         "count": 10000
       }]
     }
     ```

2. **Fallback Method: Block Scanning**
   - Used when `trace_filter` is not available on the RPC endpoint
   - Scans each block in the range and filters transactions sent to the proxy with non-zero value
   - Verifies transaction success using receipt status
   - Less efficient but more universally supported by all EVM nodes

### Balance Verification

The system employs dual verification approaches for maximum accuracy:

1. **Cosmos API Balance Check**
   - Converts EVM addresses to Cosmos addresses for native balance checks
   - Queries historical balances at specific block heights
   - Example endpoint: `/cosmos/bank/v1beta1/balances/{cosmosAddress}/by_denom?denom=usei`
   - Includes block height header for historical queries

2. **EVM API Balance Check**
   - Fallback method using EVM RPC endpoints
   - Gets native token balances directly from EVM accounts
   - Standardizes decimal precision to match Cosmos representation (6 decimal places)

3. **Validation Process**
   - Checks balances at three critical points: vote time, one block before vote, and end of voting period
   - Maintains precisely 6 decimal places for all balance comparisons
   - Employs caching to reduce redundant API calls
   - Records comprehensive data for auditing and verification

### Data Resilience

The system implements several measures to ensure data integrity:

1. **Fallback Endpoints**
   - Automatically switches between primary and archive nodes
   - Uses archive nodes for historical data beyond primary node's retention period

2. **Resumable Processing**
   - Tracks last processed block for seamless continuation after interruptions
   - Stores all data persistently in JSON files for review and data recovery

3. **Error Handling**
   - Gracefully handles API failures, rate limits, and network issues
   - Implements exponential backoff for temporary failures
   - Marks transactions as invalid when verification is impossible

## Project Structure

```
sei-voting-monitor/
├── index.js             # Main application entry point
├── contractReader.js    # Handles blockchain interactions and event reading
├── walletBalances.js    # Tracks and verifies wallet balances
├── findStartBlock.js    # Utility to find exact starting block
├── contract-abi.js      # Contains contract ABI definitions
├── package.json         # Project dependencies
├── README.md            # Project documentation
└── data/                # Data storage directory (created automatically)
    ├── wallets.json     # Wallet data
    ├── votes.json       # Vote data
    ├── voting_report.csv # Vote report
    ├── wallet_report.csv # Wallet report
    └── last_processed_block.txt # Checkpoint for processing
```

## Requirements

- Node.js v14+
- npm or yarn

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/sei-voting-monitor.git
   cd sei-voting-monitor
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

The main configuration is in `index.js`. Important parameters include:

- `PROXY_ADDRESS`: Address of the voting proxy contract
- `IMPLEMENTATION_ADDRESS`: Address of the underlying implementation contract
- `MIN_SEI_REQUIRED`: Minimum SEI tokens required (default: 100)
- `VOTING_START_DATE` and `VOTING_END_DATE`: Voting period timeframe
- `RPC_ENDPOINTS`: API endpoints with fallback options

## Usage

### Start the Monitor

```bash
npm start
```

This will:
1. Start tracking votes from the beginning of the voting period
2. Check wallet balances at the time of voting and one block before
3. Periodically check for new votes (every 12 hours)
4. Generate a final report when the voting period ends

## License

MIT