import type {
  Alert,
  Channel,
  DayPoint,
  HourPoint,
  Settlement,
  Tx,
  TxStatus,
  WebhookLog,
} from './types'

/** Mulberry32 — deterministic data so charts/tables are stable between renders. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = [
  'Wanjiru Kamau', 'Otieno Odhiambo', 'Amina Hassan', 'Brian Mutiso', 'Grace Njeri',
  'Peter Kariuki', 'Faith Chebet', 'John Mwangi', 'Mercy Atieno', 'Daniel Omondi',
  'Sarah Wambui', 'Kevin Barasa', 'Lucy Akinyi', 'Samuel Kiptoo', 'Hilda Moraa',
  'Alex Ndung\'u', 'Rose Jelagat', 'Victor Ochieng', 'Naomi Wekesa', 'Collins Rono',
]

const CHANNELS: Channel[] = ['STK Push', 'Paybill', 'Till', 'USSD', 'B2C']
const REFERENCES = ['ORD-', 'INV-', 'SUB-', 'ORD-', 'ORD-']

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo)

export function formatKES(n: number, compact = false): string {
  if (compact) {
    if (Math.abs(n) >= 1_000_000) return `KES ${(n / 1_000_000).toFixed(1)}M`
    if (Math.abs(n) >= 1_000) return `KES ${(n / 1_000).toFixed(1)}K`
  }
  return `KES ${Math.round(n).toLocaleString('en-KE')}`
}

export function maskMsisdn(r: () => number): string {
  const prefix = pick(r, ['254712', '254720', '254733', '254748', '254790', '254701', '254757'])
  const mid = String(Math.floor(between(r, 100, 999)))
  const end = String(Math.floor(between(r, 1000, 9999)))
  return `+${prefix} ${mid} ${end}`
}

function transCode(r: () => number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += chars[Math.floor(r() * chars.length)]
  return `SFF${s.slice(0, 7)}`
}

function amountFor(r: () => number): number {
  // Long-tail ticket sizes typical of Kenyan merchant collections.
  const u = r()
  if (u < 0.45) return Math.round(between(r, 50, 500) / 10) * 10
  if (u < 0.8) return Math.round(between(r, 500, 3000) / 50) * 50
  if (u < 0.96) return Math.round(between(r, 3000, 15000) / 100) * 100
  return Math.round(between(r, 15000, 85000) / 500) * 500
}

function statusFor(r: () => number): TxStatus {
  const u = r()
  if (u < 0.885) return 'success'
  if (u < 0.94) return 'failed'
  if (u < 0.98) return 'pending'
  return 'reversed'
}

const feeFor = (amount: number, channel: Channel): number => {
  if (channel === 'B2C') return Math.min(100, Math.max(25, amount * 0.005))
  if (channel === 'Till') return Math.round(amount * 0.0025)
  if (channel === 'USSD') return Math.round(amount * 0.003)
  return Math.min(210, Math.max(15, Math.round(amount * 0.0035)))
}

export function makeTx(r: () => number, at: number, forceChannel?: Channel): Tx {
  const channel = forceChannel ?? pick(r, CHANNELS)
  const amount = amountFor(r)
  const status = statusFor(r)
  return {
    id: `${at}-${Math.floor(r() * 1e9)}`,
    code: transCode(r),
    msisdn: maskMsisdn(r),
    name: pick(r, NAMES),
    amount: status === 'failed' ? 0 : amount,
    fee: status === 'failed' ? 0 : Math.round(feeFor(amount, channel)),
    channel,
    status,
    reference: `${pick(r, REFERENCES)}${Math.floor(between(r, 10000, 99999))}`,
    at,
  }
}

export function seedTransactions(count: number, seed = 20261016, spanMs = 6 * 3600_000): Tx[] {
  const r = rng(seed)
  const now = Date.now()
  const txs: Tx[] = []
  for (let i = 0; i < count; i++) {
    const skew = Math.pow(r(), 1.6) // cluster recent transactions
    txs.push(makeTx(r, now - skew * spanMs))
  }
  return txs.sort((a, b) => b.at - a.at)
}

const HOURS = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11',
  '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23']

export function hourlySeries(seed = 7): HourPoint[] {
  const r = rng(seed)
  const now = new Date()
  const shape = (h: number) => {
    // Kenyan payment rhythm: morning peak, lunch bump, evening peak.
    const morning = Math.exp(-Math.pow(h - 10, 2) / 8) * 1.0
    const lunch = Math.exp(-Math.pow(h - 13, 2) / 5) * 0.55
    const evening = Math.exp(-Math.pow(h - 19.5, 2) / 9) * 1.15
    const night = h < 5 ? 0.06 : 0.2
    return morning + lunch + evening + night
  }
  const base = 420_000
  return HOURS.map((h) => {
    const hour = Number(h)
    const past = hour > now.getHours()
    const collections = past ? 0 : Math.round(base * shape(hour) * between(r, 0.85, 1.15))
    const txCount = past ? 0 : Math.round(collections / between(r, 700, 1100))
    return { hour: `${h}:00`, collections, txCount }
  })
}

export function dailySeries(days = 14, seed = 42): DayPoint[] {
  const r = rng(seed)
  const out: DayPoint[] = []
  const fmt = new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric' })
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dow = d.getDay()
    const weekend = dow === 0 || dow === 6 ? 0.55 : 1
    const trend = 1 + (days - i) * 0.012
    const spike = r() > 0.88 ? 1.6 : 1
    const collections = Math.round(between(r, 780_000, 1_450_000) * weekend * trend * spike)
    out.push({
      label: fmt.format(d),
      collections,
      txCount: Math.round(collections / between(r, 780, 1050)),
      failures: Math.round(between(r, 18, 96) * weekend),
    })
  }
  return out
}

export function seedSettlements(seed = 99): Settlement[] {
  const r = rng(seed)
  const banks = ['Equity Bank • 8845', 'KCB Bank • 1120', 'Co-op Bank • 4471']
  const statuses = ['settled', 'settled', 'in transit', 'pending'] as const
  const rel = ['Settled today', 'Settled yesterday', 'Arrives 16:30 EAT', 'Cutoff 18:00 EAT', 'Cutoff tomorrow']
  return statuses.map((status, i) => ({
    id: `SET-${2610 - i}`,
    batch: `BATCH-${78_431 - i * 7}`,
    amount: Math.round(between(r, 380_000, 2_400_000) / 100) * 100,
    txCount: Math.round(between(r, 240, 2400)),
    bank: banks[i % banks.length],
    status,
    eta: rel[i],
  }))
}

export function seedWebhooks(seed = 5): WebhookLog[] {
  const r = rng(seed)
  const events = ['mpesa.payment.success', 'mpesa.payment.failed', 'mpesa.reversal.processed',
    'mpesa.settlement.completed', 'mpesa.stk.timeout']
  const now = Date.now()
  return Array.from({ length: 7 }, (_, i) => {
    const fail = r() > 0.78
    return {
      id: `wh_${i}`,
      event: events[Math.floor(r() * events.length)],
      httpStatus: fail ? pick(r, [500, 502, 504, 429]) : 200,
      ms: Math.round(fail ? between(r, 1800, 6000) : between(r, 60, 340)),
      at: now - i * between(r, 25_000, 140_000),
      ok: !fail,
    }
  })
}

export function seedAlerts(): Alert[] {
  const now = Date.now()
  return [
    { id: 'a1', level: 'critical', title: 'Webhook endpoint degrading', detail: '5xx rate 4.2% on /callbacks/mpesa — retry budget nearly exhausted.', at: now - 4 * 60_000 },
    { id: 'a2', level: 'warning', title: 'Unsettled batch older than 12h', detail: 'BATCH-78431 (KES 1.9M) pending bank confirmation.', at: now - 38 * 60_000 },
    { id: 'a3', level: 'info', title: 'Traffic surge detected', detail: 'STK Push volume +38% vs. same hour last week.', at: now - 72 * 60_000 },
  ]
}
