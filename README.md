# SEI Voting Monitor

A comprehensive solution for tracking and validating wallet voting activity on the SEI blockchain.

## Overview

This system monitors voting activities on a specific SEI blockchain contract and ensures that votes only count if the wallets maintain a minimum of 100 SEI throughout the voting process - specifically:

1. At the time of voting
2. One block before voting
3. At the end of the voting period

## Project Structure

```
sei-voting-monitor/
├── index.js             # Main application entry point
├── contractReader.js    # Handles blockchain interactions and event reading
├── walletBalances.js    # Tracks and verifies wallet balances
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

### Fallback Mechanism

The system includes a built-in fallback mechanism that automatically switches to archive nodes when:
- Primary node doesn't have historical data
- Primary node fails to respond or returns an error
- Rate limits are encountered

This ensures continuous monitoring even if your primary node has issues.

## How It Works

### Vote Detection

1. The system scans for transactions to the voting contract with non-zero value
2. For each transaction, it verifies:
   - The transaction was successful
   - The wallet has sufficient SEI at the time of voting and one block before

### Balance Verification

For each wallet that votes, the system:
1. Converts the EVM address to a Cosmos address
2. Checks the SEI balance at multiple points:
   - At the block where the vote occurred
   - One block before the vote
   - At the end of the voting period
3. Determines if the vote is valid based on all three balance checks

### Reporting

At the end of the voting period, the system generates:
1. A console summary with statistics
2. A CSV file with detailed vote information
3. A CSV file with wallet balance information

## Data Files

- `wallets.json`: Stores wallet information including balances at various blocks
- `votes.json`: Stores vote information including validity status
- `last_processed_block.txt`: Tracks the last processed block for resuming operations
- `voting_report.csv`: Comprehensive report of all votes
- `wallet_report.csv`: Summary of wallet activity and balance status

## API Endpoints

The system uses multiple endpoints with fallback options:
- Primary endpoints (basementnodes.ca): Used for most operations
- Archive endpoints (ccvalidators.com): Used as fallback for historical data

## Troubleshooting

- If the monitor stops unexpectedly, it will automatically resume from the last processed block when restarted.
- Logs are displayed in the console for monitoring progress and diagnosing issues.
- If balance lookups fail, try specifying different RPC endpoints in the configuration.

## License

MIT
