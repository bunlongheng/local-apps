import { useState, useEffect } from 'react'
import { Clock, ChevronDown, ChevronRight, RefreshCw, CheckCircle, XCircle, AlertCircle } from 'lucide-react'

export default function CronsPage() {
  const [crons, setCrons] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})

  async function fetchCrons() {
    try {
      const res = await fetch('/api/crons')
      const data = await res.json()
      setCrons(data.crons || [])
    } catch (e) {
      console.error('Failed to fetch crons:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchCrons()
  }, [])

  function toggle(id) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Cron Jobs</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            {crons.length} scheduled jobs
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchCrons() }}
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

      {loading && crons.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          Loading...
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {crons.map(cron => (
            <CronRow key={cron.id} cron={cron} expanded={expanded[cron.id]} onToggle={() => toggle(cron.id)} />
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

function CronRow({ cron, expanded, onToggle }) {
  const hasLog = cron.lastLines && cron.lastLines.length > 0

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {expanded ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />}

        <Clock size={14} color="var(--accent)" />

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{cron.id}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{cron.desc}</div>
        </div>

        {cron.autoFix && (
          <span style={{
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 10,
            background: 'rgba(99,102,241,0.15)',
            color: 'var(--accent)',
            fontWeight: 600,
          }}>
            auto-fix
          </span>
        )}

        <div style={{ textAlign: 'right', minWidth: 100 }}>
          {cron.lastRun ? (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {formatDate(cron.lastRun)}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Never run</div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: 16,
        }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            {cron.log && (
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Log: </span>
                {cron.log}
              </div>
            )}
          </div>

          {hasLog ? (
            <pre style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 12,
              fontSize: 11,
              lineHeight: 1.6,
              color: 'var(--text-secondary)',
              overflow: 'auto',
              maxHeight: 300,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {cron.lastLines.join('\n')}
            </pre>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No log output available
            </div>
          )}

          {cron.summaryData && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                Summary
              </div>
              <pre style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 12,
                fontSize: 11,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
                overflow: 'auto',
                maxHeight: 200,
                whiteSpace: 'pre-wrap',
              }}>
                {typeof cron.summaryData === 'string' ? cron.summaryData : JSON.stringify(cron.summaryData, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatDate(iso) {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
