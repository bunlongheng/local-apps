import { useState, useEffect } from 'react'
import { ExternalLink, RefreshCw, Circle } from 'lucide-react'

export default function StatusPage() {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status')
      const data = await res.json()
      setApps(data.apps || [])
    } catch (e) {
      console.error('Failed to fetch status:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  const filtered = filter === 'all' ? apps : apps.filter(a => a.status === filter)
  const upCount = apps.filter(a => a.status === 'up').length
  const downCount = apps.filter(a => a.status === 'down').length

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>App Status</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            {apps.length} apps &middot; {upCount} up &middot; {downCount} down
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <FilterButton label="All" value="all" current={filter} onClick={setFilter} />
          <FilterButton label="Up" value="up" current={filter} onClick={setFilter} />
          <FilterButton label="Down" value="down" current={filter} onClick={setFilter} />
          <button
            onClick={() => { setLoading(true); fetchStatus() }}
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '6px 10px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
            }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading && apps.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          Loading...
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 12,
        }}>
          {filtered.map(app => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .spin { animation: spin 1s linear infinite }
      `}</style>
    </div>
  )
}

function AppCard({ app }) {
  const isUp = app.status === 'up'
  const statusColor = isUp ? 'var(--green)' : 'var(--red)'

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {app.icon && (
            <img
              src={`http://localhost:9876/favicons/${app.icon}`}
              alt=""
              style={{ width: 20, height: 20, borderRadius: 4 }}
              onError={e => e.target.style.display = 'none'}
            />
          )}
          <span style={{ fontSize: 14, fontWeight: 600 }}>{app.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Circle size={8} fill={statusColor} color={statusColor} />
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 500, textTransform: 'uppercase' }}>
            {app.status}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
        {app.localUrl && (
          <UrlRow label="Local" url={app.localUrl} />
        )}
        {app.caddyUrl && (
          <UrlRow label="Caddy" url={app.caddyUrl} />
        )}
        {app.prodUrl && (
          <UrlRow label="Prod" url={app.prodUrl} />
        )}
      </div>

      {app.lastChecked && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 'auto' }}>
          Checked {timeAgo(app.lastChecked)}
        </div>
      )}
    </div>
  )
}

function UrlRow({ label, url }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 40 }}>{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener"
        style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 3 }}
      >
        {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        <ExternalLink size={10} />
      </a>
    </div>
  )
}

function FilterButton({ label, value, current, onClick }) {
  const active = current === value
  return (
    <button
      onClick={() => onClick(value)}
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 12px',
        color: active ? '#fff' : 'var(--text-secondary)',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {label}
    </button>
  )
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}
