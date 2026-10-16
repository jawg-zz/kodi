import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, Activity, Percent, Receipt, Timer, TrendingUp } from 'lucide-react'

export interface Kpi {
  label: string
  value: string
  delta: number
  foot: string
  icon: LucideIcon
  accent: string
  spark: number[]
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 78
  const h = 26
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
    .join(' ')
  return (
    <svg className="spark" width={w} height={h} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function KpiCards({ kpis }: { kpis: Kpi[] }) {
  return (
    <section className="kpis">
      {kpis.map((k) => {
        const up = k.delta >= 0
        const Icon = k.icon
        return (
          <article className="card kpi" key={k.label} style={{ ['--accent' as string]: k.accent }}>
            <div className="kpi-top">
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-ico"><Icon size={15} /></span>
            </div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-foot">
              <span className={`delta ${up ? 'up' : 'down'}`}>
                {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                {Math.abs(k.delta).toFixed(1)}%
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.foot}</span>
            </div>
            <Sparkline data={k.spark} color={k.accent} />
          </article>
        )
      })}
    </section>
  )
}

export const KPI_ICONS = { Activity, Percent, Receipt, Timer, TrendingUp }
