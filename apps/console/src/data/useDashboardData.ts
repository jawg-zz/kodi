import { useEffect, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type {
  Alert, DayPoint, HourPoint, Settlement, Tx, WebhookLog,
} from './types'
import {
  dailySeries, hourlySeries, makeTx, seedAlerts, seedSettlements,
  seedTransactions, seedWebhooks,
} from './generate'

export const CONVEX_ENABLED = Boolean(import.meta.env.VITE_CONVEX_URL)

export interface DashboardData {
  txs: Tx[]
  settlements: Settlement[]
  webhooks: WebhookLog[]
  alerts: Alert[]
  series: HourPoint[] | DayPoint[]
  live: boolean
  loading: boolean
}

const SETTLE_MAP = { sent: 'settled', processing: 'in transit', expected: 'pending' } as const
const ALERT_MAP = { high: 'critical', medium: 'warning', low: 'info' } as const

type StreamRow = {
  _id: string
  code: string
  reference: string
  msisdn: string
  payerName: string
  amount: number
  fee: number
  channel: Tx['channel']
  status: Tx['status']
  source?: Tx['source']
  at: number
}

function toStreamTx(t: StreamRow): Tx {
  return {
    id: t._id,
    code: t.code,
    msisdn: t.msisdn,
    name: t.payerName,
    amount: t.amount,
    fee: t.fee,
    channel: t.channel,
    status: t.status,
    reference: t.reference,
    source: t.source,
    at: t.at,
  }
}

function hourlyFromTxs(txs: Tx[]): HourPoint[] {
  const now = Date.now()
  const buckets: HourPoint[] = []
  for (let i = 23; i >= 0; i--) {
    const end = now - i * 3_600_000
    const start = end - 3_600_000
    const rows = txs.filter((t) => t.at > start && t.at <= end)
    buckets.push({
      hour: new Date(end).toISOString().slice(11, 16),
      collections: rows.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0),
      txCount: rows.length,
    })
  }
  return buckets
}

function dailyFromTxs(txs: Tx[], days: number): DayPoint[] {
  const now = Date.now()
  const dayMs = 86_400_000
  const buckets: DayPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const end = now - i * dayMs
    const start = end - dayMs
    const rows = txs.filter((t) => t.at > start && t.at <= end)
    buckets.push({
      label: new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      collections: rows.filter((t) => t.status === 'success').reduce((s, t) => s + t.amount, 0),
      txCount: rows.length,
      failures: rows.filter((t) => t.status === 'failed').length,
    })
  }
  return buckets
}

function useMockData(rangeDays: number): DashboardData {
  const [txs, setTxs] = useState<Tx[]>(() => seedTransactions(160))
  const settlements = useState<Settlement[]>(seedSettlements)[0]
  const webhooks = useState<WebhookLog[]>(seedWebhooks)[0]
  const alerts = useState<Alert[]>(seedAlerts)[0]

  useEffect(() => {
    const id = setInterval(() => {
      setTxs((prev) => [makeTx(Math.random, Date.now()), ...prev].slice(0, 260))
    }, 4200)
    return () => clearInterval(id)
  }, [])

  return {
    txs,
    settlements,
    webhooks,
    alerts,
    series: rangeDays ? dailySeries(rangeDays) : hourlySeries(),
    live: true,
    loading: false,
  }
}

function useConvexData(rangeDays: number): DashboardData {
  const txRows = useQuery(api.console.transactions, { limit: 500 })
  const settlementDocs = useQuery(api.console.settlements, { limit: 24 })
  const webhookData = useQuery(api.console.webhookHealth, { limit: 8 })
  const alertDocs = useQuery(api.console.alerts, { limit: 40 })

  const loading =
    txRows === undefined ||
    settlementDocs === undefined ||
    webhookData === undefined ||
    alertDocs === undefined

  const txs = (txRows ?? []).map(toStreamTx)

  const settlements: Settlement[] = (settlementDocs ?? []).map((s) => ({
    id: s._id,
    batch: s.batch,
    amount: s.amount,
    txCount: s.txCount,
    bank: s.bank,
    status: SETTLE_MAP[s.status],
    eta: s.eta ?? '—',
  }))

  const webhooks: WebhookLog[] = (webhookData?.logs ?? []).map((l) => ({
    id: l._id,
    event: l.event,
    httpStatus: l.ok ? 200 : 400,
    ms: l.latencyMs ?? 0,
    at: l._creationTime,
    ok: l.ok,
  }))

  const alerts: Alert[] = (alertDocs ?? []).map((a) => ({
    id: a._id,
    level: ALERT_MAP[a.severity],
    title: a.title,
    detail: a.detail ?? '—',
    at: a._creationTime,
  }))

  return {
    txs,
    settlements,
    webhooks,
    alerts,
    series: rangeDays ? dailyFromTxs(txs, rangeDays) : hourlyFromTxs(txs),
    live: true,
    loading,
  }
}

/** Live Convex backend when VITE_CONVEX_URL is set, seeded mocks otherwise. */
export function useDashboardData(rangeDays: number): DashboardData {
  // CONVEX_ENABLED is a build-time constant, so the hook chosen never flips.
  if (CONVEX_ENABLED) return useConvexData(rangeDays)
  return useMockData(rangeDays)
}
