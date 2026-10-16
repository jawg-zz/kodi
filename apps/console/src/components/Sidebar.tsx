import { useEffect, useRef, useState } from 'react'
import {
  BarChart3, BellRing, Building2, CreditCard, LayoutDashboard, Link2, LogOut, Menu, Receipt,
  Repeat2, Settings, ShieldCheck, Wallet,
} from 'lucide-react'
import { useOptionalAuth } from '../lib/auth'

const WEB_URL = import.meta.env.VITE_WEB_URL ?? 'https://kodi.spidmax.win'

/** Nav items map to dashboard sections (the console is one page, no router). */
interface NavItem {
  icon: typeof LayoutDashboard
  label: string
  /** section id to scroll to; omit for `soon` items */
  target?: string
  /** live count rendered as a badge; hidden when 0 */
  count?: number
  soon?: boolean
}

const PRIMARY: NavItem[] = [
  { icon: LayoutDashboard, label: 'Overview', target: 'sec-overview' },
  { icon: Receipt, label: 'Transactions', target: 'sec-transactions' },
  { icon: Wallet, label: 'Settlements', target: 'sec-settlements' },
  { icon: Repeat2, label: 'Reconciliation', target: 'sec-recon' },
  { icon: CreditCard, label: 'Channels', target: 'sec-charts' },
]
const SECONDARY: NavItem[] = [
  { icon: Link2, label: 'API & Webhooks', target: 'sec-webhooks' },
  { icon: BarChart3, label: 'Reports', target: 'sec-charts' },
  { icon: ShieldCheck, label: 'Fraud & Risk', soon: true },
  { icon: BellRing, label: 'Alerts', target: 'sec-alerts' },
  { icon: Settings, label: 'Settings', soon: true },
]

export default function Sidebar({
  open, onClose, counts,
}: {
  open: boolean
  onClose: () => void
  counts?: { transactions?: number; settlements?: number; alerts?: number }
}) {
  const auth = useOptionalAuth()
  const [active, setActive] = useState('sec-overview')
  // Clicked section stays highlighted while it is comfortably in view —
  // at page bottom it cannot scroll to the top, and the plain spy would
  // otherwise bounce the highlight back to whatever sits at the top.
  const pinnedRef = useRef<string | null>(null)
  // During scrollIntoView the target starts below the viewport; the spy
  // must not evaluate (and clear the pin) until the animation lands.
  const ignoreSpyUntilRef = useRef(0)

  // Scroll-spy: highlight the section closest to the viewport threshold.
  // Same-row siblings (grid columns) share the same top — tie-break by
  // leftmost so the first column (e.g. Settlements) wins over Webhooks.
  useEffect(() => {
    const targets = [...PRIMARY, ...SECONDARY]
      .map((i) => i.target)
      .filter((t): t is string => Boolean(t))
    let raf = 0
    const evaluate = () => {
      raf = 0
      if (performance.now() < ignoreSpyUntilRef.current) return
      const pinned = pinnedRef.current
      if (pinned) {
        const el = document.getElementById(pinned)
        const r = el?.getBoundingClientRect()
        if (el && r && r.top > -360 && r.top < window.innerHeight * 0.75) return
        pinnedRef.current = null
      }
      let current = 'sec-overview'
      let bestTop = Number.NEGATIVE_INFINITY
      let bestLeft = Number.POSITIVE_INFINITY
      for (const id of targets) {
        const el = document.getElementById(id)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.top > 140) continue
        if (r.top > bestTop + 4 || (Math.abs(r.top - bestTop) <= 4 && r.left < bestLeft)) {
          current = id
          bestTop = r.top
          bestLeft = r.left
        }
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(evaluate)
    }
    evaluate()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const go = (item: NavItem) => {
    if (item.soon || !item.target) return
    pinnedRef.current = item.target === 'sec-overview' ? null : item.target
    ignoreSpyUntilRef.current = performance.now() + 700
    document.getElementById(item.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(item.target)
    onClose()
  }

  const countFor = (label: string) =>
    label === 'Transactions' ? counts?.transactions
    : label === 'Settlements' ? counts?.settlements
    : label === 'Alerts' ? counts?.alerts
    : undefined

  const renderItem = (item: NavItem) => (
    <button
      key={item.label}
      className={`nav-item ${item.target === active && !item.soon ? 'active' : ''} ${item.soon ? 'soon' : ''}`}
      onClick={() => go(item)}
      aria-current={item.target === active && !item.soon ? 'page' : undefined}
      title={item.soon ? 'Coming soon' : undefined}
      disabled={item.soon}
    >
      <item.icon size={16} />
      {item.label}
      {item.soon ? (
        <span className="soon-tag">soon</span>
      ) : (
        (countFor(item.label) ?? 0) > 0 && <span className="badge-n">{countFor(item.label)}</span>
      )}
    </button>
  )

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-logo">K</div>
        <div>
          <div className="brand-name">KenyaPay</div>
          <div className="brand-sub">Merchant Console</div>
        </div>
        <button className="icon-btn menu-toggle" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close menu">
          <Menu size={16} />
        </button>
      </div>

      <div className="nav-label">Workspace</div>
      {PRIMARY.map(renderItem)}

      <div className="nav-label">Developer</div>
      {SECONDARY.map(renderItem)}

      <div className="nav-label">Suite</div>
      <a className="nav-item" href={WEB_URL} target="_blank" rel="noreferrer" title="Landlord app (kodi)">
        <Building2 size={16} />
        Kodi landlord app
        <span className="badge-n" aria-hidden>↗</span>
      </a>

      <div className="side-foot">
        <div className="api-status">
          <span className="dot" />
          Daraja API operational
        </div>
        <div className="api-status" style={{ opacity: 0.75 }}>
          <span className="dot warn" />
          Sandbox · shortcode 174379
        </div>
        <div className="side-user">
          <div className="side-user-id" title={auth?.user?.id}>
            {auth?.user?.email ?? auth?.user?.id ?? 'not signed in'}
          </div>
          <button className="side-signout" onClick={() => void auth?.signOut()}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>
    </aside>
  )
}
