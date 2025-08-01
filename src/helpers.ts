import { BigInt, BigDecimal, Address } from '@graphprotocol/graph-ts'
import { ERC20 } from '../generated/Pool/ERC20'
import { Pool } from '../generated/Pool/Pool'
import { User, UserPosition, Market, Token } from '../generated/schema'

// Core contract addresses
export const POOL_ADDRESS = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'
export const POOL_ADDRESSES_PROVIDER = '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D'
export const AAVE_ORACLE = '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156'
export const POOL_DATA_PROVIDER = '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac'

// Protocol ID
export const PROTOCOL_ID = 'aave-v3-base'

// Math constants
export let ZERO_BI = BigInt.fromI32(0)
export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let ONE_BD = BigDecimal.fromString('1')
export let HUNDRED_BD = BigDecimal.fromString('100')

// Ray and Wad units (Aave uses 27 decimals for Ray, 18 for Wad)
export let RAY = BigInt.fromI32(10).pow(27)
export let WAD = BigInt.fromI32(10).pow(18)
export let RAY_BD = BigDecimal.fromString('1000000000000000000000000000') // 10^27
export let WAD_BD = BigDecimal.fromString('1000000000000000000') // 10^18

// Time constants
export let SECONDS_PER_YEAR = BigInt.fromI32(31536000)
export let SECONDS_PER_HOUR = BigInt.fromI32(3600)
export let SECONDS_PER_DAY = BigInt.fromI32(86400)

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1')
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'))
  }
  return bd
}

export function convertTokenToDecimal(tokenAmount: BigInt, decimals: BigInt): BigDecimal {
  if (decimals == ZERO_BI) {
    return tokenAmount.toBigDecimal()
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(decimals))
}

// Convert Ray (27 decimals) to decimal
export function rayToDecimal(ray: BigInt): BigDecimal {
  return ray.toBigDecimal().div(RAY_BD)
}

// Convert Wad (18 decimals) to decimal
export function wadToDecimal(wad: BigInt): BigDecimal {
  return wad.toBigDecimal().div(WAD_BD)
}

// Calculate utilization rate = totalBorrow / totalSupply
export function calculateUtilizationRate(totalBorrow: BigInt, totalSupply: BigInt): BigDecimal {
  if (totalSupply.equals(ZERO_BI)) {
    return ZERO_BD
  }
  
  let utilization = totalBorrow.toBigDecimal().div(totalSupply.toBigDecimal())
  return utilization.times(HUNDRED_BD) // Convert to percentage
}

// Fetch token metadata
export function fetchTokenSymbol(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress)
  let symbolResult = contract.try_symbol()
  if (!symbolResult.reverted) {
    return symbolResult.value
  }
  return 'unknown'
}

export function fetchTokenName(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress)
  let nameResult = contract.try_name()
  if (!nameResult.reverted) {
    return nameResult.value
  }
  return 'unknown'
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  let contract = ERC20.bind(tokenAddress)
  let decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    return BigInt.fromI32(decimalResult.value)
  }
  return BigInt.fromI32(18) // Default to 18 decimals
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  let contract = ERC20.bind(tokenAddress)
  let totalSupplyResult = contract.try_totalSupply()
  if (!totalSupplyResult.reverted) {
    return totalSupplyResult.value
  }
  return ZERO_BI
}

// Get hour ID from timestamp
export function getHourId(timestamp: BigInt): i32 {
  return timestamp.div(SECONDS_PER_HOUR).toI32()
}

// Get day ID from timestamp
export function getDayId(timestamp: BigInt): i32 {
  return timestamp.div(SECONDS_PER_DAY).toI32()
}

// Helper to create token ID
export function getTokenId(address: Address): string {
  return address.toHexString().toLowerCase()
}

// Recalculate user's total supply and borrow USD from all positions
export function recalculateUserTotals(user: User): void {
  let totalSupplyUSD = ZERO_BD
  let totalBorrowUSD = ZERO_BD
  
  // Get all markets dynamically from Pool contract
  let pool = Pool.bind(Address.fromString(POOL_ADDRESS))
  let reservesResult = pool.try_getReservesList()
  
  if (!reservesResult.reverted) {
    let reserves = reservesResult.value
    for (let i = 0; i < reserves.length; i++) {
      let marketId = reserves[i].toHexString().toLowerCase()
      let positionId = user.id + '-' + marketId
      let position = UserPosition.load(positionId)
      
      if (position != null) {
        let market = Market.load(marketId)
        if (market != null) {
          let token = Token.load(market.inputToken)
          if (token != null) {
            // Calculate supply value in USD
            if (position.aTokenBalance.gt(ZERO_BI)) {
              let supplyDecimal = convertTokenToDecimal(position.aTokenBalance, BigInt.fromI32(token.decimals))
              totalSupplyUSD = totalSupplyUSD.plus(supplyDecimal.times(token.lastPriceUSD))
            }
            
            // Calculate borrow value in USD (variable + stable debt)
            let totalDebt = position.variableDebtBalance.plus(position.stableDebtBalance)
            if (totalDebt.gt(ZERO_BI)) {
              let borrowDecimal = convertTokenToDecimal(totalDebt, BigInt.fromI32(token.decimals))
              totalBorrowUSD = totalBorrowUSD.plus(borrowDecimal.times(token.lastPriceUSD))
            }
          }
        }
      }
    }
  }
  
  user.totalSupplyUSD = totalSupplyUSD
  user.totalBorrowUSD = totalBorrowUSD
  user.save()
}

// Get all markets that have been created - now dynamic
export function getAllMarkets(): string[] {
  // Get all markets dynamically from Pool contract
  let pool = Pool.bind(Address.fromString(POOL_ADDRESS))
  let reservesResult = pool.try_getReservesList()
  
  if (!reservesResult.reverted) {
    let marketIds: string[] = []
    let reserves = reservesResult.value
    for (let i = 0; i < reserves.length; i++) {
      marketIds.push(reserves[i].toHexString().toLowerCase())
    }
    return marketIds
  }
  
  // Return empty array if call fails - no fallback
  return []
}