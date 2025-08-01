import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { AaveOracle } from '../generated/Pool/AaveOracle'
import { Token } from '../generated/schema'
import {
  ZERO_BD,
  AAVE_ORACLE,
  exponentToBigDecimal,
  fetchTokenDecimals
} from './helpers'

// Fetch price from Aave Oracle
export function getTokenPriceUSD(tokenAddress: Address): BigDecimal {
  let oracle = AaveOracle.bind(Address.fromString(AAVE_ORACLE))
  
  // Try to get asset price
  let priceResult = oracle.try_getAssetPrice(tokenAddress)
  if (priceResult.reverted) {
    return ZERO_BD
  }
  
  // Get base currency unit (usually 8 decimals for USD)
  let baseCurrencyUnitResult = oracle.try_BASE_CURRENCY_UNIT()
  let baseCurrencyUnit = BigInt.fromI32(10).pow(8) // Default to 8 decimals
  
  if (!baseCurrencyUnitResult.reverted) {
    baseCurrencyUnit = baseCurrencyUnitResult.value
  }
  
  // Convert price to decimal
  let price = priceResult.value.toBigDecimal().div(baseCurrencyUnit.toBigDecimal())
  
  return price
}

// Update token price
export function updateTokenPrice(token: Token): void {
  let price = getTokenPriceUSD(Address.fromString(token.id))
  
  if (price.gt(ZERO_BD)) {
    token.lastPriceUSD = price
    token.lastPriceTimestamp = BigInt.fromI32(0) // Will be set by the event handler
  }
}

// Calculate USD value
export function calculateUSDValue(amount: BigInt, tokenAddress: Address, decimals: BigInt): BigDecimal {
  let price = getTokenPriceUSD(tokenAddress)
  
  if (price.equals(ZERO_BD)) {
    return ZERO_BD
  }
  
  // Convert amount to decimal using token decimals
  let amountDecimal = amount.toBigDecimal().div(exponentToBigDecimal(decimals))
  
  // Calculate USD value
  return amountDecimal.times(price)
}