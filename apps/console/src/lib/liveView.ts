import type { Tx } from '../data/types'

/**
 * Pause semantics for the live transactions table.
 *
 * While paused the table keeps rendering the rows it had at pause time, so a
 * reader is not disturbed by reordering/status flips; arrivals are counted
 * against the newest timestamp in that snapshot and surfaced as a banner.
 */

/** Newest `at` in a snapshot — the watermark arrivals are counted against. */
export function watermark(txs: Tx[]): number {
  return txs.reduce((m, t) => Math.max(m, t.at), 0)
}

/** Rows newer than the watermark, i.e. what arrived since the pause. */
export function countNewer(txs: Tx[], since: number): number {
  return txs.reduce((n, t) => n + (t.at > since ? 1 : 0), 0)
}
