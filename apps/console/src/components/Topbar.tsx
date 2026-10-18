import { Bell, Menu, Moon, Sun } from 'lucide-react'
import { useConvexConnectionState } from 'convex/react'
import { CONVEX_ENABLED } from '../data/useDashboardData'

interface Props {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  range: string
  onRange: (v: string) => void
  search: string
  onSearch: (v: string) => void
  onOpenMenu: () => void
}

/**
 * Live websocket state from the Convex client. Mock builds render no
 * provider, so the live variant only ever mounts when one exists.
 */
function ConnectionIndicator() {
  const cs = useConvexConnectionState()
  const label = cs.isWebSocketConnected ? 'live' : cs.hasEverConnected ? 'reconnecting' : 'connecting'
  return (
    <span className={`conn ${cs.isWebSocketConnected ? 'ok' : 'warn'}`} title={`Convex connection: ${label} (${cs.connectionCount} connects)`}>
      <span className="dot" />{label}
    </span>
  )
}

const ConnectionIndicatorMock = () => null
const Connection = CONVEX_ENABLED ? ConnectionIndicator : ConnectionIndicatorMock

export default function Topbar({ theme, onToggleTheme, range, onRange, search, onSearch, onOpenMenu }: Props) {
  return (
    <header className="topbar">
      <button className="icon-btn menu-toggle" onClick={onOpenMenu} aria-label="Open menu">
        <Menu size={17} />
      </button>
      <div>
        <div className="page-title">Merchant Overview</div>
        <div className="page-sub">Nairobi Fresh Grocers · Till 4471923 · Paybill 247247</div>
      </div>

      <div className="topbar-right">
        <select className="select hide-sm" value={range} onChange={(e) => onRange(e.target.value)} aria-label="Date range">
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="qtd">Quarter to date</option>
        </select>

        <input
          className="input hide-sm"
          style={{ width: 210 }}
          placeholder="Search trans code, MSISDN…"
          aria-label="Search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />

        <Connection />

        <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="icon-btn" aria-label="Notifications">
          <Bell size={16} />
          <span className="pip">3</span>
        </button>
        <div className="avatar" title="Wanjiru Kamau — Admin">WK</div>
      </div>
    </header>
  )
}
