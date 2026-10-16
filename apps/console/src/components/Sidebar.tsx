import {
  BarChart3, BellRing, CreditCard, LayoutDashboard, Link2, Menu, Receipt,
  Repeat2, Settings, ShieldCheck, Wallet,
} from 'lucide-react'

const PRIMARY = [
  { icon: LayoutDashboard, label: 'Overview', active: true },
  { icon: Receipt, label: 'Transactions', badge: '2.4k' },
  { icon: Wallet, label: 'Settlements', badge: '4' },
  { icon: Repeat2, label: 'Reconciliation' },
  { icon: CreditCard, label: 'Products' },
]
const SECONDARY = [
  { icon: Link2, label: 'API & Webhooks', badge: '2' },
  { icon: BarChart3, label: 'Reports' },
  { icon: ShieldCheck, label: 'Fraud & Risk' },
  { icon: BellRing, label: 'Notifications' },
  { icon: Settings, label: 'Settings' },
]

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      {PRIMARY.map((item) => (
        <button key={item.label} className={`nav-item ${item.active ? 'active' : ''}`}>
          <item.icon size={16} />
          {item.label}
          {item.badge && <span className="badge-n">{item.badge}</span>}
        </button>
      ))}

      <div className="nav-label">Developer</div>
      {SECONDARY.map((item) => (
        <button key={item.label} className="nav-item">
          <item.icon size={16} />
          {item.label}
          {item.badge && <span className="badge-n">{item.badge}</span>}
        </button>
      ))}

      <div className="side-foot">
        <div className="api-status">
          <span className="dot" />
          Daraja API operational
        </div>
        <div className="api-status" style={{ opacity: 0.75 }}>
          <span className="dot warn" />
          Sandbox · shortcode 174379
        </div>
      </div>
    </aside>
  )
}
