import { NavLink } from 'react-router-dom'
import { Activity, Clock, LayoutDashboard } from 'lucide-react'

const navItems = [
  { to: '/status', label: 'App Status', icon: Activity },
  { to: '/crons', label: 'Cron Jobs', icon: Clock },
]

export default function Sidebar() {
  return (
    <aside style={{
      width: 'var(--sidebar-width)',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border)',
      position: 'fixed',
      top: 0,
      left: 0,
      bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
    }}>
      <div style={{
        padding: '20px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <LayoutDashboard size={20} color="var(--accent)" />
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Local Apps
        </span>
      </div>

      <nav style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isActive ? 'var(--bg-hover)' : 'transparent',
              transition: 'all 0.15s ease',
            })}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div style={{
        marginTop: 'auto',
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        fontSize: 11,
        color: 'var(--text-muted)',
      }}>
        API: localhost:9876
      </div>
    </aside>
  )
}
