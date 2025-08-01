# Aave V3 Subgraph for Base Chain

This subgraph indexes all Aave V3 lending activity on Base chain, providing comprehensive real-time and historical data for all markets, users, and transactions.

## Overview

- **Network**: Base (Chain ID: 8453)
- **Pool Contract**: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
- **Pool Data Provider**: `0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac`
- **Aave Oracle**: `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156`
- **Start Block**: 12292697

## Features

### Market Analytics
- Real-time market data for all assets (supply/borrow totals, available liquidity)
- Dynamic market discovery - automatically tracks new assets added to Aave V3
- Current supply and variable borrow APYs
- Utilization rates and reserve factors
- Liquidation parameters (LTV, liquidation threshold, penalty)

### Revenue Tracking
- Continuous revenue calculation based on interest rate spreads
- Protocol-side vs supply-side revenue breakdown
- Cumulative and real-time revenue metrics
- Revenue split tracking based on reserve factors

### User Analytics
- Individual user positions across all markets
- aToken balances and debt tracking
- Principal vs earned interest calculations
- Realized and unrealized P&L tracking
- Total supply/borrow USD values per user

### Transaction Data
- All supply, withdraw, borrow, and repay events
- Transaction amounts in both tokens and USD
- User addresses and timestamps
- Complete transaction history

### USD Pricing
- Real-time USD prices via Aave Oracle
- Automatic USD calculation for all market values
- Protocol and user-level USD metrics

### Historical Data
- Hourly and daily market snapshots
- Historical APYs and utilization rates
- Volume tracking (supply/withdraw/borrow/repay)
- Active user metrics
- Revenue accumulation over time

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aave-v3-base-subgraph.git
cd aave-v3-base-subgraph

# Install dependencies
npm install

# Generate code from GraphQL schema
graph codegen

# Build the subgraph
graph build

# Deploy to The Graph (requires authentication)
graph deploy base-aave-v3
```

## Query Examples

### Get all markets with current data

```graphql
{
  markets(orderBy: totalSupply, orderDirection: desc) {
    id
    asset
    inputToken {
      symbol
      name
      decimals
      lastPriceUSD
    }
    totalSupply
    totalBorrow
    availableLiquidity
    supplyAPY
    variableBorrowAPY
    utilizationRate
    reserveFactor
    ltv
    liquidationThreshold
  }
}
```

### Get protocol overview

```graphql
{
  protocol(id: "aave-v3-base") {
    totalSupplyUSD
    totalBorrowUSD
    totalRevenueUSD
    cumulativeSupplySideRevenueUSD
    cumulativeProtocolSideRevenueUSD
  }
}
```

### Get user positions

```graphql
{
  users(first: 10, orderBy: totalSupplyUSD, orderDirection: desc) {
    id
    totalSupplyUSD
    totalBorrowUSD
    transactionCount
    positions {
      market {
        inputToken { symbol }
      }
      aTokenBalance
      variableDebtBalance
      principal
      realizedPnL
      isCollateral
    }
  }
}
```

### Get recent transactions

```graphql
{
  transactions(first: 20, orderBy: timestamp, orderDirection: desc) {
    id
    timestamp
    type
    amount
    amountUSD
    from {
      id
    }
    market {
      inputToken {
        symbol
      }
    }
  }
}
```

### Get market historical data

```graphql
{
  dailySnapshots(
    first: 7, 
    orderBy: timestamp, 
    orderDirection: desc,
    where: { market: "MARKET_ADDRESS" }
  ) {
    dayId
    timestamp
    supplyAPY
    borrowAPY
    utilizationRate
    totalSupply
    totalBorrow
    dailySupplyVolume
    dailyBorrowVolume
    dailyActiveUsers
    dailyTotalRevenueUSD
  }
}
```

### Get top borrowers in a specific market

```graphql
{
  userPositions(
    first: 10,
    orderBy: variableDebtBalance,
    orderDirection: desc,
    where: { 
      market: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      variableDebtBalance_gt: "0"
    }
  ) {
    user {
      id
      totalSupplyUSD
      totalBorrowUSD
    }
    variableDebtBalance
    market {
      inputToken { symbol }
    }
    lastUpdateTimestamp
  }
}
```

## Schema Overview

### Core Entities

- **Protocol** - Overall protocol metrics and cumulative data
- **Market** - Individual lending markets for each asset
- **Token** - ERC20 tokens with metadata and pricing
- **User** - User accounts with aggregate metrics
- **UserPosition** - Individual user positions per market
- **Transaction** - All lending/borrowing transactions

### Time Series Data

- **HourlySnapshot** - Hourly market data
- **DailySnapshot** - Daily market data with volume and revenue
- **DailyActiveUser** - Daily active user tracking
- **DailyRevenueSnapshot** - Daily revenue accumulation

## Important Notes

### Dynamic Market Discovery
This subgraph uses dynamic market discovery via `getReservesList()` from the Aave V3 Pool contract. This means:
- New markets added to Aave V3 are automatically tracked
- No code updates required for new asset listings
- All markets are discovered and indexed in real-time

### Revenue Calculation
Revenue is calculated continuously using:
- Interest rate spreads (borrow rate - supply rate)
- Current borrow volumes
- Time-weighted calculations between rate updates
- Proper reserve factor splits between protocol and suppliers

### Data Accuracy
This subgraph provides accurate on-chain lending data including:
- All supply, borrow, withdraw, and repay transactions
- Real-time interest accrual through aToken balance updates
- Precise APY calculations from Aave's Ray-denominated rates
- USD values from Aave's official price oracle

### Block-Based Updates
The subgraph uses block handlers (every 100 blocks) to:
- Update market states and calculate accrued interest
- Refresh token prices from the oracle
- Calculate and accumulate revenue
- Maintain accurate protocol totals

This ensures data freshness while optimizing for indexing performance.