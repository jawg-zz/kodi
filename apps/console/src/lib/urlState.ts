import { useCallback, useState } from 'react'

/**
 * Console view state serialized into the URL (?q=&range=&channel=&status=&txn=).
 * Two independent hook instances (App: q/range, TransactionsTable:
 * channel/status/txn) never clobber each other: every update re-parses the
 * CURRENT location.search and merges the patch on top before writing.
 */

export interface TxUrlState {
  q: string
  range: string
  channel: string
  status: string
  txn: string
}

export const URL_DEFAULTS: TxUrlState = { q: '', range: 'today', channel: 'all', status: 'all', txn: '' }

const CHANNELS = new Set(['all', 'STK Push', 'Paybill', 'Till', 'USSD', 'B2C'])
const STATUSES = new Set(['all', 'success', 'pending', 'failed', 'reversed'])
const RANGES = new Set(['today', '7d', '30d', 'qtd'])

export function parseTxUrlState(search: string): TxUrlState {
  const p = new URLSearchParams(search)
  const q = (p.get('q') ?? '').slice(0, 120)
  const range = p.get('range') ?? URL_DEFAULTS.range
  const channel = p.get('channel') ?? URL_DEFAULTS.channel
  const status = p.get('status') ?? URL_DEFAULTS.status
  const txn = (p.get('txn') ?? '').slice(0, 40)
  return {
    q,
    range: RANGES.has(range) ? range : URL_DEFAULTS.range,
    channel: CHANNELS.has(channel) ? channel : URL_DEFAULTS.channel,
    status: STATUSES.has(status) ? status : URL_DEFAULTS.status,
    txn: /^[\w-]*$/.test(txn) ? txn : '',
  }
}

/** Defaults are omitted so clean views keep a clean URL. */
export function serializeTxUrlState(s: TxUrlState): string {
  const p = new URLSearchParams()
  if (s.q !== URL_DEFAULTS.q) p.set('q', s.q)
  if (s.range !== URL_DEFAULTS.range) p.set('range', s.range)
  if (s.channel !== URL_DEFAULTS.channel) p.set('channel', s.channel)
  if (s.status !== URL_DEFAULTS.status) p.set('status', s.status)
  if (s.txn !== URL_DEFAULTS.txn) p.set('txn', s.txn)
  return p.toString()
}

export function useTxUrlState(): [TxUrlState, (patch: Partial<TxUrlState>) => void] {
  const [state, setState] = useState<TxUrlState>(() => parseTxUrlState(window.location.search))

  const update = useCallback((patch: Partial<TxUrlState>) => {
    const merged = { ...parseTxUrlState(window.location.search), ...patch }
    const qs = serializeTxUrlState(merged)
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    )
    setState((prev) => ({ ...prev, ...patch }))
  }, [])

  return [state, update]
}
