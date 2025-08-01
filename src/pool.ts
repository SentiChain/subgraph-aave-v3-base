import { Address, BigInt, BigDecimal, log, ethereum } from '@graphprotocol/graph-ts'
import {
  Supply,
  Withdraw,
  Borrow,
  Repay,
  ReserveDataUpdated,
  Pool
} from '../generated/Pool/Pool'
import { PoolDataProvider } from '../generated/Pool/PoolDataProvider'
import { AaveOracle } from '../generated/Pool/AaveOracle'
import {
  Protocol,
  Market,
  Token,
  User,
  UserPosition,
  Transaction,
  DailyActiveUser,
  DailyRevenueSnapshot
} from '../generated/schema'
import {
  PROTOCOL_ID,
  POOL_DATA_PROVIDER,
  POOL_ADDRESS,
  AAVE_ORACLE,
  ZERO_BI,
  ZERO_BD,
  ONE_BI,
  calculateUtilizationRate,
  convertTokenToDecimal,
  fetchTokenSymbol,
  fetchTokenName,
  fetchTokenDecimals,
  fetchTokenTotalSupply,
  rayToDecimal,
  HUNDRED_BD,
  getTokenId,
  recalculateUserTotals,
  getAllMarkets,
  SECONDS_PER_YEAR
} from './helpers'
import { getTokenPriceUSD, calculateUSDValue } from './pricing'
import { updateHourlySnapshot, updateDailySnapshot, updateDailyRevenue, updateProtocolDailyRevenue } from './snapshots'

// Base mainnet launch timestamp (March 1, 2024) - used for bootstrap
const BASE_MAINNET_LAUNCH = BigInt.fromI32(1709251200)

// Initialize protocol entity
function getOrCreateProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID)
  if (protocol == null) {
    protocol = new Protocol(PROTOCOL_ID)
    protocol.totalSupplyUSD = ZERO_BD
    protocol.totalBorrowUSD = ZERO_BD
    protocol.totalRevenueUSD = ZERO_BD
    protocol.cumulativeSupplySideRevenueUSD = ZERO_BD
    protocol.cumulativeProtocolSideRevenueUSD = ZERO_BD
    protocol.save()
  }
  return protocol
}

// Initialize or get market entity for ANY asset
function getOrCreateMarket(asset: Address, currentTimestamp: BigInt): Market {
  let marketId = getTokenId(asset)
  let market = Market.load(marketId)
  
  if (market == null) {
    market = new Market(marketId)
    market.protocol = PROTOCOL_ID
    market.asset = asset
    
    // Fetch token addresses from PoolDataProvider
    let dataProvider = PoolDataProvider.bind(Address.fromString(POOL_DATA_PROVIDER))
    let tokenAddresses = dataProvider.try_getReserveTokensAddresses(asset)
    
    if (!tokenAddresses.reverted) {
      market.aToken = tokenAddresses.value.getATokenAddress()
      market.sToken = tokenAddresses.value.getStableDebtTokenAddress()
      market.vToken = tokenAddresses.value.getVariableDebtTokenAddress()
    } else {
      // Fallback to zero addresses if call fails
      market.aToken = Address.fromString('0x0000000000000000000000000000000000000000')
      market.sToken = Address.fromString('0x0000000000000000000000000000000000000000')
      market.vToken = Address.fromString('0x0000000000000000000000000000000000000000')
      log.warning('Failed to fetch reserve token addresses for asset: {}', [asset.toHexString()])
    }
    
    // Initialize token entities
    let inputToken = getOrCreateToken(asset)
    let outputToken = getOrCreateToken(Address.fromBytes(market.aToken))
    
    market.inputToken = inputToken.id
    market.outputToken = outputToken.id
    
    // Initialize state
    market.totalSupply = ZERO_BI
    market.totalBorrow = ZERO_BI
    market.availableLiquidity = ZERO_BI
    market.liquidityRate = ZERO_BI
    market.variableBorrowRate = ZERO_BI
    market.stableBorrowRate = ZERO_BI
    market.supplyAPY = ZERO_BD
    market.variableBorrowAPY = ZERO_BD
    market.utilizationRate = ZERO_BD
    
    // Fetch initial configuration from PoolDataProvider
    let configResult = dataProvider.try_getReserveConfigurationData(asset)
    
    if (!configResult.reverted) {
      market.ltv = configResult.value.getLtv()
      market.liquidationThreshold = configResult.value.getLiquidationThreshold()
      market.liquidationPenalty = configResult.value.getLiquidationBonus()
      market.reserveFactor = configResult.value.getReserveFactor()
    } else {
      market.ltv = ZERO_BI
      market.liquidationThreshold = ZERO_BI
      market.liquidationPenalty = ZERO_BI
      market.reserveFactor = ZERO_BI
      log.warning('Failed to fetch reserve configuration for asset: {}', [asset.toHexString()])
    }
    
    market.lastUpdateTimestamp = currentTimestamp
    market.lastUpdateBlock = ZERO_BI
    
    // CRITICAL FIX: Initialize with proper timestamp for revenue calculation
    // Use current timestamp for initial calculation to avoid huge historical gaps
    market.lastRevenueCalculationTimestamp = currentTimestamp
    
    // Fetch initial state to capture existing deposits
    updateMarketState(market)
    
    market.save()
  }
  
  return market
}

// Initialize or get token entity
function getOrCreateToken(address: Address): Token {
  let tokenId = getTokenId(address)
  let token = Token.load(tokenId)
  
  if (token == null) {
    token = new Token(tokenId)
    token.symbol = fetchTokenSymbol(address)
    token.name = fetchTokenName(address)
    token.decimals = fetchTokenDecimals(address).toI32()
    token.totalSupply = fetchTokenTotalSupply(address)
    token.lastPriceUSD = getTokenPriceUSD(address)
    token.lastPriceTimestamp = ZERO_BI
    token.save()
  }
  
  return token
}

// Initialize or get user entity
function getOrCreateUser(address: Address): User {
  let userId = getTokenId(address)
  let user = User.load(userId)
  
  if (user == null) {
    user = new User(userId)
    user.totalSupplyUSD = ZERO_BD
    user.totalBorrowUSD = ZERO_BD
    user.transactionCount = 0
    user.save()
  }
  
  return user
}

// Initialize or get user position
function getOrCreateUserPosition(user: User, market: Market): UserPosition {
  let positionId = user.id + '-' + market.id
  let position = UserPosition.load(positionId)
  
  if (position == null) {
    position = new UserPosition(positionId)
    position.user = user.id
    position.market = market.id
    position.aTokenBalance = ZERO_BI
    position.variableDebtBalance = ZERO_BI
    position.stableDebtBalance = ZERO_BI
    position.principal = ZERO_BI
    position.totalDeposited = ZERO_BI
    position.totalWithdrawn = ZERO_BI
    position.realizedPnL = ZERO_BD
    position.unrealizedPnL = ZERO_BD
    position.isCollateral = false
    position.lastUpdateTimestamp = ZERO_BI
    position.save()
  }
  
  return position
}

// Create transaction entity
function createTransaction(
  event: ethereum.Event,
  user: User,
  market: Market,
  type: string,
  amount: BigInt,
  amountUSD: BigDecimal
): Transaction {
  let txId = event.transaction.hash.toHexString() + '-' + event.logIndex.toString()
  let transaction = new Transaction(txId)
  
  transaction.hash = event.transaction.hash
  transaction.timestamp = event.block.timestamp
  transaction.block = event.block.number
  transaction.from = user.id
  transaction.market = market.id
  transaction.type = type
  transaction.amount = amount
  transaction.amountUSD = amountUSD
  
  transaction.save()
  return transaction
}

// Update market state from PoolDataProvider
function updateMarketState(market: Market): void {
  let dataProvider = PoolDataProvider.bind(Address.fromString(POOL_DATA_PROVIDER))
  let reserveData = dataProvider.try_getReserveData(Address.fromString(market.asset.toHexString()))
  
  if (!reserveData.reverted) {
    // Update supply and borrow totals
    market.totalSupply = reserveData.value.getTotalAToken()
    market.totalBorrow = reserveData.value.getTotalVariableDebt().plus(reserveData.value.getTotalStableDebt())
    market.availableLiquidity = market.totalSupply.minus(market.totalBorrow)
    
    // Update rates
    market.liquidityRate = reserveData.value.getLiquidityRate()
    market.variableBorrowRate = reserveData.value.getVariableBorrowRate()
    market.stableBorrowRate = reserveData.value.getStableBorrowRate()
    
    // Calculate utilization rate
    market.utilizationRate = calculateUtilizationRate(market.totalBorrow, market.totalSupply)
  }
}

// Update user position from chain
function updateUserPositionFromChain(position: UserPosition, user: Address, market: Market): void {
  let dataProvider = PoolDataProvider.bind(Address.fromString(POOL_DATA_PROVIDER))
  let userData = dataProvider.try_getUserReserveData(
    Address.fromString(market.asset.toHexString()),
    user
  )
  
  if (!userData.reverted) {
    position.aTokenBalance = userData.value.getCurrentATokenBalance()
    position.variableDebtBalance = userData.value.getCurrentVariableDebt()
    position.stableDebtBalance = userData.value.getCurrentStableDebt()
    position.isCollateral = userData.value.getUsageAsCollateralEnabled()
  }
}

// Recalculate protocol totals from all markets
function recalculateProtocolTotals(): void {
  let protocol = getOrCreateProtocol()
  let totalSupplyUSD = ZERO_BD
  let totalBorrowUSD = ZERO_BD
  
  // Get all markets dynamically from Pool contract
  let pool = Pool.bind(Address.fromString(POOL_ADDRESS))
  let reservesResult = pool.try_getReservesList()
  
  if (!reservesResult.reverted) {
    let reserves = reservesResult.value
    for (let i = 0; i < reserves.length; i++) {
      let marketId = reserves[i].toHexString().toLowerCase()
      let market = Market.load(marketId)
      
      if (market != null) {
        let token = Token.load(market.inputToken)
        if (token != null) {
          // Update token price
          token.lastPriceUSD = getTokenPriceUSD(Address.fromString(token.id))
          token.save()
          
          let supplyDecimal = convertTokenToDecimal(market.totalSupply, BigInt.fromI32(token.decimals))
          let borrowDecimal = convertTokenToDecimal(market.totalBorrow, BigInt.fromI32(token.decimals))
          
          totalSupplyUSD = totalSupplyUSD.plus(supplyDecimal.times(token.lastPriceUSD))
          totalBorrowUSD = totalBorrowUSD.plus(borrowDecimal.times(token.lastPriceUSD))
        }
      }
    }
  }
  
  protocol.totalSupplyUSD = totalSupplyUSD
  protocol.totalBorrowUSD = totalBorrowUSD
  protocol.save()
}

// FIXED: Calculate and accumulate revenue since last calculation
function calculateAndAccumulateRevenue(market: Market, timestamp: BigInt): void {
  let protocol = getOrCreateProtocol()
  
  // Skip if no time has passed
  if (timestamp.le(market.lastRevenueCalculationTimestamp)) {
    return
  }
  
  // Calculate time elapsed since last calculation (in seconds)
  let timeElapsed = timestamp.minus(market.lastRevenueCalculationTimestamp)
  
  // Only calculate if there are borrows and rates are set
  if (market.totalBorrow.gt(ZERO_BI) && market.variableBorrowRate.gt(ZERO_BI)) {
    // Convert rates from Ray (27 decimals) to decimal
    // Aave V3 rates are already annualized
    let borrowRateDecimal = rayToDecimal(market.variableBorrowRate)
    let supplyRateDecimal = rayToDecimal(market.liquidityRate)
    let spread = borrowRateDecimal.minus(supplyRateDecimal)
    
    // Only calculate if spread is positive
    if (spread.gt(ZERO_BD)) {
      let token = Token.load(market.inputToken)
      if (token != null) {
        let totalBorrowDecimal = convertTokenToDecimal(market.totalBorrow, BigInt.fromI32(token.decimals))
        let totalBorrowUSD = totalBorrowDecimal.times(token.lastPriceUSD)
        
        // Calculate revenue for the elapsed time period
        // Revenue = spread * total borrowed * (time elapsed / seconds per year)
        let timeElapsedDecimal = timeElapsed.toBigDecimal()
        let secondsPerYearDecimal = SECONDS_PER_YEAR.toBigDecimal()
        let periodRevenue = spread.times(totalBorrowUSD).times(timeElapsedDecimal).div(secondsPerYearDecimal)
        
        // Split revenue based on reserve factor (in basis points, so divide by 10000)
        let reserveFactorDecimal = market.reserveFactor.toBigDecimal().div(BigDecimal.fromString('10000'))
        let protocolRevenue = periodRevenue.times(reserveFactorDecimal)
        let supplySideRevenue = periodRevenue.minus(protocolRevenue)
        
        // Accumulate to protocol totals
        protocol.cumulativeSupplySideRevenueUSD = protocol.cumulativeSupplySideRevenueUSD.plus(supplySideRevenue)
        protocol.cumulativeProtocolSideRevenueUSD = protocol.cumulativeProtocolSideRevenueUSD.plus(protocolRevenue)
        protocol.totalRevenueUSD = protocol.cumulativeSupplySideRevenueUSD.plus(protocol.cumulativeProtocolSideRevenueUSD)
        protocol.save()
        
        // Log for debugging
        log.info('Revenue calculated for market {}: spread={}, totalBorrowUSD={}, timeElapsed={}, periodRevenue={}, protocolRevenue={}, supplySideRevenue={}', [
          market.id,
          spread.toString(),
          totalBorrowUSD.toString(),
          timeElapsed.toString(),
          periodRevenue.toString(),
          protocolRevenue.toString(),
          supplySideRevenue.toString()
        ])
      }
    }
  }
  
  // Update last calculation timestamp
  market.lastRevenueCalculationTimestamp = timestamp
  market.save()
}

// Block handler to ensure continuous revenue calculation with dynamic pool discovery
export function handleBlock(block: ethereum.Block): void {
  let protocol = getOrCreateProtocol()
  
  // Get all reserves dynamically from Pool contract using getReservesList()
  let pool = Pool.bind(Address.fromString(POOL_ADDRESS))
  let reservesResult = pool.try_getReservesList()
  
  if (reservesResult.reverted) {
    log.warning('Failed to get reserves list at block {}', [block.number.toString()])
    return // No fallback - exit if call fails
  }
  
  // Process each discovered market
  let reserves = reservesResult.value
  for (let i = 0; i < reserves.length; i++) {
    let tokenAddress = reserves[i]
    let marketId = tokenAddress.toHexString().toLowerCase()
    
    let market = Market.load(marketId)
    if (market == null) {
      market = getOrCreateMarket(tokenAddress, block.timestamp)
    }
    
    if (market != null) {
      processMarketInBlock(market, block)
    }
  }
  
  // Recalculate protocol totals
  recalculateProtocolTotals()
}

// Helper function to process a market in block handler
function processMarketInBlock(market: Market, block: ethereum.Block): void {
  // Update market state from chain
  updateMarketState(market)
  
  // Update token price
  let token = Token.load(market.inputToken)
  if (token != null) {
    token.lastPriceUSD = getTokenPriceUSD(Address.fromString(token.id))
    token.lastPriceTimestamp = block.timestamp
    token.save()
  }
  
  // Calculate and accumulate revenue
  calculateAndAccumulateRevenue(market, block.timestamp)
  
  // Update APYs
  market.supplyAPY = rayToDecimal(market.liquidityRate).times(HUNDRED_BD)
  market.variableBorrowAPY = rayToDecimal(market.variableBorrowRate).times(HUNDRED_BD)
  
  market.lastUpdateTimestamp = block.timestamp
  market.lastUpdateBlock = block.number
  market.save()
}

export function handleSupply(event: Supply): void {
  let market = getOrCreateMarket(event.params.reserve, event.block.timestamp)
  let user = getOrCreateUser(event.params.onBehalfOf)
  let position = getOrCreateUserPosition(user, market)
  
  // Calculate revenue before state changes
  calculateAndAccumulateRevenue(market, event.block.timestamp)
  
  // Update position - fetch actual balance from chain to include interest
  updateUserPositionFromChain(position, event.params.onBehalfOf, market)
  position.principal = position.principal.plus(event.params.amount)
  position.totalDeposited = position.totalDeposited.plus(event.params.amount)
  position.lastUpdateTimestamp = event.block.timestamp
  position.save()
  
  // Update market state
  updateMarketState(market)
  market.lastUpdateTimestamp = event.block.timestamp
  market.lastUpdateBlock = event.block.number
  market.save()
  
  // Calculate USD value
  let token = Token.load(market.inputToken)
  let amountUSD = ZERO_BD
  if (token != null) {
    amountUSD = calculateUSDValue(event.params.amount, Address.fromString(market.asset.toHexString()), BigInt.fromI32(token.decimals))
  }
  
  // Create transaction
  createTransaction(event, user, market, 'SUPPLY', event.params.amount, amountUSD)
  
  // Update user stats
  user.transactionCount = user.transactionCount + 1
  user.save()
  
  // Recalculate user totals from all positions
  recalculateUserTotals(user)
  
  // Recalculate protocol totals from markets
  recalculateProtocolTotals()
  
  // Update snapshots
  updateHourlySnapshot(market, event, 'SUPPLY', event.params.amount)
  updateDailySnapshot(market, event, 'SUPPLY', event.params.amount, amountUSD, user.id)
}

export function handleWithdraw(event: Withdraw): void {
  let market = getOrCreateMarket(event.params.reserve, event.block.timestamp)
  let user = getOrCreateUser(event.params.user)
  let position = getOrCreateUserPosition(user, market)
  
  // Calculate revenue before state changes
  calculateAndAccumulateRevenue(market, event.block.timestamp)
  
  // Store balance before withdrawal for P&L calculation
  let balanceBefore = position.aTokenBalance
  
  // Update position - fetch actual balance from chain
  updateUserPositionFromChain(position, event.params.user, market)
  position.totalWithdrawn = position.totalWithdrawn.plus(event.params.amount)
  position.lastUpdateTimestamp = event.block.timestamp
  
  // Calculate realized P&L including interest
  let totalEarned = position.totalWithdrawn.minus(position.totalDeposited)
  if (position.totalWithdrawn.ge(position.totalDeposited)) {
    let token = Token.load(market.inputToken)
    if (token != null) {
      position.realizedPnL = convertTokenToDecimal(totalEarned, BigInt.fromI32(token.decimals))
    }
  }
  
  // Update principal (reduce by withdrawal amount)
  if (position.principal.ge(event.params.amount)) {
    position.principal = position.principal.minus(event.params.amount)
  } else {
    position.principal = ZERO_BI
  }
  
  position.save()
  
  // Update market state
  updateMarketState(market)
  market.lastUpdateTimestamp = event.block.timestamp
  market.lastUpdateBlock = event.block.number
  market.save()
  
  // Calculate USD value
  let token = Token.load(market.inputToken)
  let amountUSD = ZERO_BD
  if (token != null) {
    amountUSD = calculateUSDValue(event.params.amount, Address.fromString(market.asset.toHexString()), BigInt.fromI32(token.decimals))
  }
  
  // Create transaction
  createTransaction(event, user, market, 'WITHDRAW', event.params.amount, amountUSD)
  
  // Update user stats
  user.transactionCount = user.transactionCount + 1
  user.save()
  
  // Recalculate user totals from all positions
  recalculateUserTotals(user)
  
  // Recalculate protocol totals from markets
  recalculateProtocolTotals()
  
  // Update snapshots
  updateHourlySnapshot(market, event, 'WITHDRAW', event.params.amount)
  updateDailySnapshot(market, event, 'WITHDRAW', event.params.amount, amountUSD, user.id)
}

export function handleBorrow(event: Borrow): void {
  let market = getOrCreateMarket(event.params.reserve, event.block.timestamp)
  let user = getOrCreateUser(event.params.onBehalfOf)
  let position = getOrCreateUserPosition(user, market)
  
  // Calculate revenue before state changes
  calculateAndAccumulateRevenue(market, event.block.timestamp)
  
  // Update position - fetch actual balance from chain
  updateUserPositionFromChain(position, event.params.onBehalfOf, market)
  position.lastUpdateTimestamp = event.block.timestamp
  position.save()
  
  // Update market state
  updateMarketState(market)
  market.lastUpdateTimestamp = event.block.timestamp
  market.lastUpdateBlock = event.block.number
  market.save()
  
  // Calculate USD value
  let token = Token.load(market.inputToken)
  let amountUSD = ZERO_BD
  if (token != null) {
    amountUSD = calculateUSDValue(event.params.amount, Address.fromString(market.asset.toHexString()), BigInt.fromI32(token.decimals))
  }
  
  // Create transaction
  createTransaction(event, user, market, 'BORROW', event.params.amount, amountUSD)
  
  // Update user stats
  user.transactionCount = user.transactionCount + 1
  user.save()
  
  // Recalculate user totals from all positions
  recalculateUserTotals(user)
  
  // Recalculate protocol totals from markets
  recalculateProtocolTotals()
  
  // Update snapshots
  updateHourlySnapshot(market, event, 'BORROW', event.params.amount)
  updateDailySnapshot(market, event, 'BORROW', event.params.amount, amountUSD, user.id)
}

export function handleRepay(event: Repay): void {
  let market = getOrCreateMarket(event.params.reserve, event.block.timestamp)
  let user = getOrCreateUser(event.params.user)
  let position = getOrCreateUserPosition(user, market)
  
  // Calculate revenue before state changes
  calculateAndAccumulateRevenue(market, event.block.timestamp)
  
  // Update position - fetch actual balance from chain
  updateUserPositionFromChain(position, event.params.user, market)
  position.lastUpdateTimestamp = event.block.timestamp
  position.save()
  
  // Update market state
  updateMarketState(market)
  market.lastUpdateTimestamp = event.block.timestamp
  market.lastUpdateBlock = event.block.number
  market.save()
  
  // Calculate USD value
  let token = Token.load(market.inputToken)
  let amountUSD = ZERO_BD
  if (token != null) {
    amountUSD = calculateUSDValue(event.params.amount, Address.fromString(market.asset.toHexString()), BigInt.fromI32(token.decimals))
  }
  
  // Create transaction
  createTransaction(event, user, market, 'REPAY', event.params.amount, amountUSD)
  
  // Update user stats
  user.transactionCount = user.transactionCount + 1
  user.save()
  
  // Recalculate user totals from all positions
  recalculateUserTotals(user)
  
  // Recalculate protocol totals from markets
  recalculateProtocolTotals()
  
  // Update snapshots
  updateHourlySnapshot(market, event, 'REPAY', event.params.amount)
  updateDailySnapshot(market, event, 'REPAY', event.params.amount, amountUSD, user.id)
}

export function handleReserveDataUpdated(event: ReserveDataUpdated): void {
  let market = getOrCreateMarket(event.params.reserve, event.block.timestamp)
  
  // CRITICAL FIX: Calculate revenue before updating rates
  calculateAndAccumulateRevenue(market, event.block.timestamp)
  
  // Update rates (Ray to APY conversion)
  market.liquidityRate = event.params.liquidityRate
  market.variableBorrowRate = event.params.variableBorrowRate
  market.stableBorrowRate = event.params.stableBorrowRate
  
  // Calculate APY from annual rates
  // Aave V3 rates are already annualized in Ray units
  market.supplyAPY = rayToDecimal(event.params.liquidityRate).times(HUNDRED_BD)
  market.variableBorrowAPY = rayToDecimal(event.params.variableBorrowRate).times(HUNDRED_BD)
  
  market.lastUpdateTimestamp = event.block.timestamp
  market.lastUpdateBlock = event.block.number
  
  // Update market state to get latest supply/borrow totals
  updateMarketState(market)
  
  market.save()
  
  // Recalculate protocol totals from markets
  recalculateProtocolTotals()
}