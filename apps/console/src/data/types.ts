export type Channel = 'STK Push' | 'Paybill' | 'Till' | 'USSD' | 'B2C'
export type TxStatus = 'success' | 'pending' | 'failed' | 'reversed'
export type SettleStatus = 'settled' | 'in transit' | 'pending'

export interface Tx {
  id: string
  code: string
  msisdn: string
  name: string
  amount: number
  fee: number
  channel: Channel
  status: TxStatus
  reference: string
  at: number
}

export interface Settlement {
  id: string
  batch: string
  amount: number
  txCount: number
  bank: string
  status: SettleStatus
  eta: string
}

export interface DayPoint {
  label: string
  collections: number
  txCount: number
  failures: number
}

export interface HourPoint {
  hour: string
  collections: number
  txCount: number
}

export interface WebhookLog {
  id: string
  event: string
  httpStatus: number
  ms: number
  at: number
  ok: boolean
}

export interface Alert {
  id: string
  level: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  at: number
}
