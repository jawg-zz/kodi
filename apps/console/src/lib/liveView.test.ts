import { describe, expect, test } from 'vitest'
import { countNewer, watermark } from './liveView'
import type { Tx } from '../data/types'

const tx = (at: number, id = `t${at}`): Tx => ({
  id,
  code: `C${at}`,
  msisdn: '254700000000',
  name: 'Test Payer',
  amount: 100,
  fee: 1,
  channel: 'STK Push',
  status: 'success',
  reference: `R${at}`,
  source: 'stk',
  at,
})

describe('watermark', () => {
  test('empty snapshot has a zero watermark', () => {
    expect(watermark([])).toBe(0)
  })

  test('is the newest timestamp, regardless of order', () => {
    expect(watermark([tx(50), tx(900), tx(300)])).toBe(900)
  })
})

describe('countNewer', () => {
  test('counts only arrivals strictly after the pause watermark', () => {
    const atPause = [tx(100), tx(200)]
    const later = [tx(300), tx(400), ...atPause]
    expect(countNewer(later, watermark(atPause))).toBe(2)
  })

  test('nothing arrived -> zero, so no banner is shown', () => {
    const atPause = [tx(100), tx(200)]
    expect(countNewer(atPause, watermark(atPause))).toBe(0)
  })

  test('status flips on existing rows are not counted as arrivals', () => {
    const atPause = [tx(100)]
    const flipped = [{ ...tx(100), status: 'failed' as const }]
    expect(countNewer(flipped, watermark(atPause))).toBe(0)
  })
})
