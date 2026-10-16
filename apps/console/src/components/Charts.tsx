import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { DayPoint, HourPoint } from '../data/types'
import { formatKES } from '../data/generate'

function Tip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="tooltip-card">
      <div className="tc-t">{label}</div>
      {payload.map((p: any) => (
        <div className="tc-r" key={p.dataKey}>
          <span className="sw" style={{ background: p.color || p.fill }} />
          {p.name}
          <b>{unit === 'count' ? Number(p.value).toLocaleString() : formatKES(Number(p.value))}</b>
        </div>
      ))}
    </div>
  )
}

export function CollectionsChart({ data, height = 268 }: { data: DayPoint[] | HourPoint[]; height?: number }) {
  const isHourly = 'hour' in data[0]
  const xKey = isHourly ? 'hour' : 'label'
  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* recharts 3 types `data` as one concrete row type; the union only differs in optional display keys */}
      <ComposedChart data={data as HourPoint[]} margin={{ top: 8, right: 6, left: -6, bottom: 0 }}>
        <defs>
          <linearGradient id="gCollections" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#43b02a" stopOpacity={0.55} />
            <stop offset="100%" stopColor="#43b02a" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 4" vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
        <YAxis
          yAxisId="left"
          tickLine={false}
          axisLine={false}
          width={54}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)}
        />
        <YAxis yAxisId="right" orientation="right" hide />
        <Tooltip content={<Tip />} cursor={{ stroke: '#43b02a', strokeOpacity: 0.35 }} />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="collections"
          name="Collections"
          stroke="#43b02a"
          strokeWidth={2.4}
          fill="url(#gCollections)"
          dot={false}
          activeDot={{ r: 4.5, stroke: '#0a0f16', strokeWidth: 2 }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="txCount"
          name="Transactions"
          stroke="#35c2d6"
          strokeWidth={1.6}
          strokeDasharray="4 4"
          dot={false}
        />
        {'failures' in data[0] && (
          <Bar yAxisId="left" dataKey="failures" name="Failures" fill="#f2555a" fillOpacity={0.55} barSize={7} radius={[3, 3, 0, 0]} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export interface Slice { name: string; value: number; color: string }

export function ChannelDonut({ slices, totalLabel }: { slices: Slice[]; totalLabel: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: 12, alignItems: 'center' }}>
      <div style={{ width: 150, height: 168 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" innerRadius={44} outerRadius={66} paddingAngle={3} stroke="none">
              {slices.map((s) => <Cell key={s.name} fill={s.color} />)}
            </Pie>
            <Tooltip content={<Tip unit="count" />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>
          {totalLabel}
        </div>
        <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: '-0.03em', margin: '3px 0 10px' }}>
          {total.toLocaleString()}
        </div>
        <div className="legend">
          {slices.map((s) => (
            <div className="legend-row" key={s.name}>
              <span className="sw" style={{ background: s.color }} />
              {s.name}
              <span className="lg-val">{s.value.toLocaleString()}</span>
              <span className="lg-pct">{total ? ((s.value / total) * 100).toFixed(1) : 0}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
