import { BigInt, BigDecimal, ethereum, log, Address } from '@graphprotocol/graph-ts'
import {
  Market,
  HourlySnapshot,
  DailySnapshot,
  Protocol,
  DailyActiveUser,
  DailyRevenueSnapshot,
  Token
} from '../generated/schema'
import { Pool } from '../generated/Pool/Pool'
import {
  ZERO_BI,
  ZERO_BD,
  getHourId,
  getDayId,
  PROTOCOL_ID,
  convertTokenToDecimal,
  rayToDecimal,
  SECONDS_PER_DAY,
  POOL_ADDRESS
} from './helpers'

export function updateHourlySnapshot(
  market: Market,
  event: ethereum.Event,
  volumeType: string,
  volume: BigInt
): HourlySnapshot {
  let hourId = getHourId(event.block.timestamp)
  let snapshotId = market.id + '-' + hourId.toString()
  
  let snapshot = HourlySnapshot.load(snapshotId)
  if (snapshot == null) {
    snapshot = new HourlySnapshot(snapshotId)
    snapshot.market = market.id
    snapshot.hourId = hourId
    snapshot.timestamp = event.block.timestamp
    
    // Initialize volumes
    snapshot.hourlySupplyVolume = ZERO_BI
    snapshot.hourlyWithdrawVolume = ZERO_BI
    snapshot.hourlyBorrowVolume = ZERO_BI
    snapshot.hourlyRepayVolume = ZERO_BI
    
    // Copy current state
    snapshot.supplyAPY = market.supplyAPY
    snapshot.borrowAPY = market.variableBorrowAPY
    snapshot.utilizationRate = market.utilizationRate
    snapshot.totalSupply = market.totalSupply
    snapshot.totalBorrow = market.totalBorrow
  }
  
  // Update volume based on type
  if (volumeType == 'SUPPLY') {
    snapshot.hourlySupplyVolume = snapshot.hourlySupplyVolume.plus(volume)
  } else if (volumeType == 'WITHDRAW') {
    snapshot.hourlyWithdrawVolume = snapshot.hourlyWithdrawVolume.plus(volume)
  } else if (volumeType == 'BORROW') {
    snapshot.hourlyBorrowVolume = snapshot.hourlyBorrowVolume.plus(volume)
  } else if (volumeType == 'REPAY') {
    snapshot.hourlyRepayVolume = snapshot.hourlyRepayVolume.plus(volume)
  }
  
  // Update current state
  snapshot.supplyAPY = market.supplyAPY
  snapshot.borrowAPY = market.variableBorrowAPY
  snapshot.utilizationRate = market.utilizationRate
  snapshot.totalSupply = market.totalSupply
  snapshot.totalBorrow = market.totalBorrow
  
  snapshot.save()
  return snapshot
}

export function updateDailySnapshot(
  market: Market,
  event: ethereum.Event,
  volumeType: string,
  volume: BigInt,
  amountUSD: BigDecimal,
  userId: string
): DailySnapshot {
  let dayId = getDayId(event.block.timestamp)
  let snapshotId = market.id + '-' + dayId.toString()
  
  let snapshot = DailySnapshot.load(snapshotId)
  if (snapshot == null) {
    snapshot = new DailySnapshot(snapshotId)
    snapshot.market = market.id
    snapshot.dayId = dayId
    snapshot.timestamp = event.block.timestamp
    
    // Initialize volumes
    snapshot.dailySupplyVolume = ZERO_BI
    snapshot.dailyWithdrawVolume = ZERO_BI
    snapshot.dailyBorrowVolume = ZERO_BI
    snapshot.dailyRepayVolume = ZERO_BI
    snapshot.dailyActiveUsers = 0
    
    // Initialize revenue
    snapshot.dailySupplySideRevenueUSD = ZERO_BD
    snapshot.dailyProtocolSideRevenueUSD = ZERO_BD
    snapshot.dailyTotalRevenueUSD = ZERO_BD
    
    // Copy current state
    snapshot.supplyAPY = market.supplyAPY
    snapshot.borrowAPY = market.variableBorrowAPY
    snapshot.utilizationRate = market.utilizationRate
    snapshot.totalSupply = market.totalSupply
    snapshot.totalBorrow = market.totalBorrow
  }
  
  // Update volume based on type
  if (volumeType == 'SUPPLY') {
    snapshot.dailySupplyVolume = snapshot.dailySupplyVolume.plus(volume)
  } else if (volumeType == 'WITHDRAW') {
    snapshot.dailyWithdrawVolume = snapshot.dailyWithdrawVolume.plus(volume)
  } else if (volumeType == 'BORROW') {
    snapshot.dailyBorrowVolume = snapshot.dailyBorrowVolume.plus(volume)
  } else if (volumeType == 'REPAY') {
    snapshot.dailyRepayVolume = snapshot.dailyRepayVolume.plus(volume)
  }
  
  // Track active users using entity
  if (userId != null) {
    let activeUserId = dayId.toString() + '-' + userId
    let activeUser = DailyActiveUser.load(activeUserId)
    if (activeUser == null) {
      activeUser = new DailyActiveUser(activeUserId)
      activeUser.day = dayId
      activeUser.user = userId
      activeUser.save()
      
      // Increment active users count for this snapshot
      snapshot.dailyActiveUsers = snapshot.dailyActiveUsers + 1
    }
  }
  
  // Update current state
  snapshot.supplyAPY = market.supplyAPY
  snapshot.borrowAPY = market.variableBorrowAPY
  snapshot.utilizationRate = market.utilizationRate
  snapshot.totalSupply = market.totalSupply
  snapshot.totalBorrow = market.totalBorrow
  
  // FIXED: Calculate projected daily revenue based on current rates and volumes
  // This represents what the daily revenue would be if current conditions persist for 24 hours
  if (market.totalBorrow.gt(ZERO_BI) && market.variableBorrowRate.gt(ZERO_BI)) {
    let borrowRateDecimal = rayToDecimal(market.variableBorrowRate)
    let supplyRateDecimal = rayToDecimal(market.liquidityRate)
    let spread = borrowRateDecimal.minus(supplyRateDecimal)
    
    if (spread.gt(ZERO_BD)) {
      let token = Token.load(market.inputToken)
      if (token != null) {
        let totalBorrowDecimal = convertTokenToDecimal(market.totalBorrow, BigInt.fromI32(token.decimals))
        let totalBorrowUSD = totalBorrowDecimal.times(token.lastPriceUSD)
        
        // Calculate daily revenue (spread * total borrowed / 365)
        let dailyRevenue = spread.times(totalBorrowUSD).div(BigDecimal.fromString('365'))
        
        // Split based on reserve factor
        let reserveFactorDecimal = market.reserveFactor.toBigDecimal().div(BigDecimal.fromString('10000'))
        let protocolRevenue = dailyRevenue.times(reserveFactorDecimal)
        let supplySideRevenue = dailyRevenue.minus(protocolRevenue)
        
        snapshot.dailySupplySideRevenueUSD = supplySideRevenue
        snapshot.dailyProtocolSideRevenueUSD = protocolRevenue
        snapshot.dailyTotalRevenueUSD = dailyRevenue
      }
    }
  }
  
  snapshot.save()
  return snapshot
}

// Update daily revenue snapshot and accumulate protocol totals
export function updateDailyRevenue(
  market: Market,
  event: ethereum.Event,
  supplySideRevenueUSD: BigDecimal,
  protocolSideRevenueUSD: BigDecimal
): void {
  let dayId = getDayId(event.block.timestamp)
  let snapshotId = market.id + '-' + dayId.toString()
  
  let snapshot = DailySnapshot.load(snapshotId)
  
  if (snapshot == null) {
    snapshot = new DailySnapshot(snapshotId)
    snapshot.market = market.id
    snapshot.dayId = dayId
    snapshot.timestamp = event.block.timestamp
    
    // Initialize all fields
    snapshot.dailySupplyVolume = ZERO_BI
    snapshot.dailyWithdrawVolume = ZERO_BI
    snapshot.dailyBorrowVolume = ZERO_BI
    snapshot.dailyRepayVolume = ZERO_BI
    snapshot.dailyActiveUsers = 0
    snapshot.dailySupplySideRevenueUSD = ZERO_BD
    snapshot.dailyProtocolSideRevenueUSD = ZERO_BD
    snapshot.dailyTotalRevenueUSD = ZERO_BD
    
    // Copy current state
    snapshot.supplyAPY = market.supplyAPY
    snapshot.borrowAPY = market.variableBorrowAPY
    snapshot.utilizationRate = market.utilizationRate
    snapshot.totalSupply = market.totalSupply
    snapshot.totalBorrow = market.totalBorrow
  }
  
  // Store the latest revenue calculation for this market
  // This represents the projected daily revenue based on current rates
  snapshot.dailySupplySideRevenueUSD = supplySideRevenueUSD
  snapshot.dailyProtocolSideRevenueUSD = protocolSideRevenueUSD
  snapshot.dailyTotalRevenueUSD = supplySideRevenueUSD.plus(protocolSideRevenueUSD)
  
  snapshot.save()
}

// Calculate and update protocol-wide daily revenue
export function updateProtocolDailyRevenue(event: ethereum.Event): void {
  let protocol = Protocol.load(PROTOCOL_ID)
  if (protocol == null) return
  
  let dayId = getDayId(event.block.timestamp)
  
  // Sum up projected daily revenue across all markets
  let totalDailySupplySideRevenue = ZERO_BD
  let totalDailyProtocolSideRevenue = ZERO_BD
  
  // Get all markets dynamically from Pool contract
  let pool = Pool.bind(Address.fromString(POOL_ADDRESS))
  let reservesResult = pool.try_getReservesList()
  
  if (!reservesResult.reverted) {
    let reserves = reservesResult.value
    for (let i = 0; i < reserves.length; i++) {
      let marketId = reserves[i].toHexString().toLowerCase()
      let snapshotId = marketId + '-' + dayId.toString()
      let snapshot = DailySnapshot.load(snapshotId)
      
      if (snapshot != null) {
        totalDailySupplySideRevenue = totalDailySupplySideRevenue.plus(snapshot.dailySupplySideRevenueUSD)
        totalDailyProtocolSideRevenue = totalDailyProtocolSideRevenue.plus(snapshot.dailyProtocolSideRevenueUSD)
      }
    }
  }
  
  // Log for debugging
  log.info('Daily revenue summary for day {}: supplySide={}, protocolSide={}, total={}', [
    dayId.toString(),
    totalDailySupplySideRevenue.toString(),
    totalDailyProtocolSideRevenue.toString(),
    totalDailySupplySideRevenue.plus(totalDailyProtocolSideRevenue).toString()
  ])
}