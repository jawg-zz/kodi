import { describe, expect, test } from 'vitest'
import { URL_DEFAULTS, parseTxUrlState, serializeTxUrlState } from './urlState'

describe('parseTxUrlState', () => {
  test('empty search yields defaults', () => {
    expect(parseTxUrlState('')).toEqual(URL_DEFAULTS)
    expect(parseTxUrlState('?')).toEqual(URL_DEFAULTS)
  })

  test('valid params parse', () => {
    expect(parseTxUrlState('?q=SFF1&range=7d&channel=Till&status=pending&txn=SFF123')).toEqual({
      q: 'SFF1',
      range: '7d',
      channel: 'Till',
      status: 'pending',
      txn: 'SFF123',
    })
  })

  test('invalid values fall back to defaults', () => {
    expect(parseTxUrlState('?range=year&channel=Nope&status=zzz&txn=bad;drop')).toEqual(URL_DEFAULTS)
  })

  test('q is capped at 120 chars', () => {
    const q = 'x'.repeat(500)
    expect(parseTxUrlState(`?q=${q}`).q).toHaveLength(120)
  })

  test('txn must be code-shaped', () => {
    expect(parseTxUrlState('?txn=ABC-123_x').txn).toBe('ABC-123_x')
    expect(parseTxUrlState(`?txn=${encodeURIComponent('a b/c')}`).txn).toBe('')
  })
})

describe('serializeTxUrlState', () => {
  test('defaults serialize to an empty string', () => {
    expect(serializeTxUrlState(URL_DEFAULTS)).toBe('')
  })

  test('non-defaults serialize and round-trip', () => {
    const s = { q: 'SFF1', range: '30d', channel: 'Paybill', status: 'failed', txn: 'SFF9' }
    const qs = serializeTxUrlState(s)
    expect(parseTxUrlState(`?${qs}`)).toEqual(s)
  })

  test('channel with a space round-trips', () => {
    const s = { ...URL_DEFAULTS, channel: 'STK Push' }
    expect(parseTxUrlState(`?${serializeTxUrlState(s)}`)).toEqual(s)
  })
})
