import { useEffect, useMemo, useState } from 'react'

const API_BASE = 'http://localhost:8000/api'

function fmtRupee(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function Tag({ kind, children }) {
  return <span className={`tag ${kind}`}>{children}</span>
}

function fetchWithFallback(liveUrl, fallbackUrl) {
  return fetch(liveUrl)
    .then(r => { if (!r.ok) throw new Error('unreachable'); return r.json() })
    .then(d => ({ data: d, live: true }))
    .catch(() => fetch(fallbackUrl).then(r => r.json()).then(d => ({ data: d, live: false })))
}

/** Compare a field across sources; returns 'match' | 'mismatch' | 'missing' */
function diffStatus(values) {
  const present = values.filter(v => v !== undefined && v !== null)
  if (present.length < 2) return 'missing'
  const [first, ...rest] = present
  const isAmount = typeof first === 'number'
  const same = rest.every(v => isAmount ? Math.abs(v - first) < 2 : v === first)
  return same ? 'match' : 'mismatch'
}

function RecordDetail({ orderId, sources, onClose }) {
  if (!orderId) return null
  const settlement = sources.settlement.find(s => s.order_id === orderId)
  const bankDirect = sources.bank.filter(b => b.order_id === orderId)
  const bankBatched = sources.bank.filter(b =>
    b.order_id !== orderId && settlement && (b.utr.includes(settlement.utr) || (b.note && b.note.includes(orderId)))
  )
  const bankRows = bankDirect.length ? bankDirect : bankBatched
  const ledgerRows = sources.ledger.filter(l => l.order_id === orderId)

  const fields = [
    { key: 'amount', label: 'amount', fmt: fmtRupee },
    { key: 'date', label: 'date', fmt: v => v },
    { key: 'utr', label: 'utr / reference', fmt: v => v },
    { key: 'customer', label: 'customer', fmt: v => v },
  ]

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <div className="drawer-title">{orderId}</div>
            <div className="drawer-sub">record-level comparison across all three sources</div>
          </div>
          <button className="close-btn" onClick={onClose}>close ✕</button>
        </div>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>field</th>
              <th>settlement</th>
              <th>bank {bankBatched.length > 0 && !bankDirect.length ? '(via batch)' : ''}</th>
              <th>ledger {ledgerRows.length > 1 ? `(${ledgerRows.length} entries)` : ''}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(f => {
              const sVal = settlement ? settlement[f.key] : undefined
              const bVal = bankRows[0] ? bankRows[0][f.key] : undefined
              const lVal = ledgerRows[0] ? ledgerRows[0][f.key] : undefined
              const status = diffStatus([sVal, bVal, lVal])
              return (
                <tr key={f.key}>
                  <td className="reason">{f.label}</td>
                  <td className={status !== 'match' ? 'cell-flag' : ''}>{sVal !== undefined ? f.fmt(sVal) : <span className="reason">— absent</span>}</td>
                  <td className={status !== 'match' ? 'cell-flag' : ''}>
                    {bankRows.length ? f.fmt(bVal) : <span className="reason">— absent</span>}
                    {bankRows.length > 1 && <span className="reason"> (+{bankRows.length - 1} more)</span>}
                  </td>
                  <td className={status !== 'match' ? 'cell-flag' : ''}>
                    {ledgerRows.length ? f.fmt(lVal) : <span className="reason">— absent</span>}
                    {ledgerRows.length > 1 && <span className="reason"> (+{ledgerRows.length - 1} more)</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {ledgerRows.length > 1 && (
          <div className="drawer-note">
            {ledgerRows.length} ledger entries exist for this order — this is the duplicate-entry
            scenario the engine refuses to auto-resolve.
          </div>
        )}
        {bankRows.length === 0 && (
          <div className="drawer-note">
            No bank record found for this order at all — gateway shows it settled but the money
            never shows up in the account. Flagged, not guessed at.
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [report, setReport] = useState(null)
  const [sources, setSources] = useState(null)
  const [tab, setTab] = useState('matched')
  const [liveStatus, setLiveStatus] = useState({ report: true, sources: true })
  const [query, setQuery] = useState('')
  const [sortDir, setSortDir] = useState(null) // null | 'asc' | 'desc'
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  function load() {
    setRefreshing(true)
    Promise.all([
      fetchWithFallback(`${API_BASE}/reconcile`, '/report.json'),
      fetchWithFallback(`${API_BASE}/sources`, '/__sources_fallback__'),
    ]).then(([r, s]) => {
      setReport(r.data)
      setLiveStatus(prev => ({ ...prev, report: r.live }))
      if (s.live) {
        setSources(s.data)
        setLiveStatus(prev => ({ ...prev, sources: true }))
      } else {
        Promise.all([
          fetch('/settlement.json').then(x => x.json()),
          fetch('/bank.json').then(x => x.json()),
          fetch('/ledger.json').then(x => x.json()),
        ]).then(([settlement, bank, ledger]) => {
          setSources({ settlement, bank, ledger })
          setLiveStatus(prev => ({ ...prev, sources: false }))
        })
      }
      setRefreshing(false)
    })
  }

  useEffect(() => { load() }, [])

  const isLive = liveStatus.report && liveStatus.sources

  if (!report || !sources) return <div className="app"><div className="empty-state">loading reconciliation report…</div></div>

  const s = report.summary
  const exceptionCats = Object.entries(report.exception_breakdown || {})

  const matchedPct = s.auto_matched / s.total_settlement_orders * 100
  const batchedPct = s.batched_pairs_resolved / s.total_settlement_orders * 100
  const excPct = s.exceptions / s.total_settlement_orders * 100

  function filterSort(rows, amountKey) {
    let out = rows
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      out = out.filter(r => (r.order_id || '').toLowerCase().includes(q) ||
        (r.paired_order_id || '').toLowerCase().includes(q) ||
        (r.detail || '').toLowerCase().includes(q) ||
        (r.strategy || '').toLowerCase().includes(q))
    }
    if (sortDir && amountKey) {
      out = [...out].sort((a, b) => sortDir === 'asc' ? a[amountKey] - b[amountKey] : b[amountKey] - a[amountKey])
    }
    return out
  }

  function toggleSort() {
    setSortDir(d => d === null ? 'desc' : d === 'desc' ? 'asc' : null)
  }

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1 className="masthead-title">Multi-Source Reconciliation</h1>
          <div className="masthead-sub">settlement × bank × ledger — batch reconciler</div>
        </div>
        <div className="masthead-meta">
          <span className={`live-dot ${isLive ? 'on' : 'off'}`} />
          source: {isLive ? 'live engine (localhost:8000)' : 'seed report (start backend for live)'}<br />
          batch size: {s.total_settlement_orders} orders<br />
          {report.scoring && <>scored vs ground truth: {report.scoring.classification_accuracy_pct}%</>}
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="search order id, reason, strategy…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button className="refresh-btn" onClick={load} disabled={refreshing}>
          {refreshing ? 're-running…' : '↻ re-run engine'}
        </button>
      </div>

      <div className="summary-strip">
        <div className="summary-cell">
          <div className="label">match rate</div>
          <div className="value accent">{s.match_rate_pct}<small>%</small></div>
        </div>
        <div className="summary-cell">
          <div className="label">fully reconciled</div>
          <div className="value">{s.fully_reconciled_pct}<small>%</small></div>
        </div>
        <div className="summary-cell">
          <div className="label">exceptions raised</div>
          <div className="value">{s.exceptions}<small>/ {s.total_settlement_orders}</small></div>
        </div>
        <div className="summary-cell">
          <div className="label">batched pairs resolved</div>
          <div className="value">{s.batched_pairs_resolved}</div>
        </div>
      </div>

      <div className="breakdown">
        <span><span className="legend-dot" style={{ background: 'var(--matched)' }} />matched</span>
        <span><span className="legend-dot" style={{ background: 'var(--batched)' }} />batched</span>
        <span><span className="legend-dot" style={{ background: 'var(--exception)' }} />exception</span>
        <div className="breakdown-bar">
          <div className="seg-matched" style={{ width: matchedPct + '%' }} />
          <div className="seg-batched" style={{ width: batchedPct + '%' }} />
          <div className="seg-exception" style={{ width: excPct + '%' }} />
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'matched' ? 'active' : ''}`} onClick={() => setTab('matched')}>
          matched <span className="count">{report.matched.length}</span>
        </button>
        <button className={`tab ${tab === 'batched' ? 'active' : ''}`} onClick={() => setTab('batched')}>
          batched pairs <span className="count">{report.batched_pairs.length}</span>
        </button>
        <button className={`tab ${tab === 'exceptions' ? 'active' : ''}`} onClick={() => setTab('exceptions')}>
          exceptions <span className="count">{report.exceptions.length}</span>
        </button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          audit trail <span className="count">{report.audit_trail.length}</span>
        </button>
      </div>

      {tab === 'matched' && (() => {
        const rows = filterSort(report.matched, 'amount')
        return rows.length === 0 ? <div className="empty-state">no matched rows for "{query}"</div> : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>order id</th>
              <th className="sortable" onClick={toggleSort}>amount {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : ''}</th>
              <th>confidence</th><th>bank strategy</th><th>ledger strategy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(m => (
              <tr key={m.order_id} className="clickable" onClick={() => setSelectedOrder(m.order_id)}>
                <td>{m.order_id}</td>
                <td className="amount">{fmtRupee(m.amount)}</td>
                <td><Tag kind="matched">{(m.confidence * 100).toFixed(0)}%</Tag></td>
                <td className="reason">{m.bank_strategy}</td>
                <td className="reason">{m.ledger_strategy}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )
      })()}

      {tab === 'batched' && (() => {
        const rows = filterSort(report.batched_pairs, 'bank_amount')
        return rows.length === 0 ? <div className="empty-state">no batched rows for "{query}"</div> : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>order id</th><th>paired with</th><th>bank utr</th>
              <th className="sortable" onClick={toggleSort}>bank amount {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : ''}</th>
              <th>settlement amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => (
              <tr key={b.order_id} className="clickable" onClick={() => setSelectedOrder(b.order_id)}>
                <td>{b.order_id}</td>
                <td><Tag kind="batched">{b.paired_order_id || 'unresolved'}</Tag></td>
                <td className="reason">{b.bank_utr}</td>
                <td className="amount">{fmtRupee(b.bank_amount)}</td>
                <td className="amount">{fmtRupee(b.settlement_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )
      })()}

      {tab === 'exceptions' && (() => {
        const rows = filterSort(report.exceptions, 'amount')
        return (
        <>
          <div className="breakdown" style={{ marginBottom: 4, marginTop: 18 }}>
            {exceptionCats.map(([cat, n]) => (
              <span key={cat}><Tag kind="exception">{cat.replaceAll('_', ' ')}</Tag> {n}</span>
            ))}
          </div>
          {rows.length === 0 ? <div className="empty-state">no exceptions for "{query}"</div> : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>order id</th><th>category</th>
                <th className="sortable" onClick={toggleSort}>amount {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : ''}</th>
                <th>detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.order_id} className="clickable" onClick={() => setSelectedOrder(e.order_id)}>
                  <td>{e.order_id}</td>
                  <td><Tag kind={e.category === 'gated_high_value' ? 'gated' : 'exception'}>
                    {e.category.replaceAll('_', ' ')}
                  </Tag></td>
                  <td className="amount">{fmtRupee(e.amount)}</td>
                  <td className="reason">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </>
        )
      })()}

      {tab === 'audit' && (() => {
        const rows = filterSort(report.audit_trail, null)
        return rows.length === 0 ? <div className="empty-state">no audit rows for "{query}"</div> : (
        <table className="ledger-table">
          <thead>
            <tr><th>order id</th><th>action</th><th>strategy</th><th>confidence</th><th>reason</th></tr>
          </thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={i} className="clickable" onClick={() => setSelectedOrder(a.order_id)}>
                <td>{a.order_id}</td>
                <td><Tag kind={
                  a.action === 'matched' ? 'matched' :
                  a.action === 'batched_pair' ? 'batched' :
                  a.action === 'gated_for_review' ? 'gated' : 'exception'
                }>{a.action.replaceAll('_', ' ')}</Tag></td>
                <td className="reason">{a.strategy}</td>
                <td>{(a.confidence * 100).toFixed(0)}%</td>
                <td className="reason">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )
      })()}

      <div className="footnote">
        <b>Bounded & gated:</b> auto-match requires ≥90% confidence AND amount ≤ ₹25,000 — nothing above that
        gate is ever auto-matched, regardless of confidence. <b>Explainable:</b> every row above carries the
        matching strategy and reason that produced it, win or exception. <b>Honest:</b> this engine's one known
        blind spot — a batched-settlement pair occasionally gets claimed by the fuzzy-match pass before the
        batch-detection pass runs — is left in and documented rather than patched around, per the scoring report.
        Click any row to see the underlying source records.
      </div>

      <RecordDetail orderId={selectedOrder} sources={sources} onClose={() => setSelectedOrder(null)} />
    </div>
  )
}
