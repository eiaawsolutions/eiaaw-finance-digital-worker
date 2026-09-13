import { Problem } from '@/components/problem';
import {
  apiGet,
  currentSession,
  type ChainVerification,
  type HandoffRow,
  type Health,
  type SettingsHealth,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The overview.
 *
 * Ordered by what would make an operator act, not by what is easy to render.
 * The two undeferrable components come first, because if either is unhealthy
 * nothing else on this page can be trusted.
 */
export default async function OverviewPage() {
  const session = await currentSession();

  const [health, settings, handoffs, chain] = await Promise.all([
    apiGet<Health>('/v1/health'),
    apiGet<SettingsHealth>('/v1/config/settings/health'),
    apiGet<{ handoffs: HandoffRow[] }>('/v1/handoffs?state=awaiting_action'),
    apiGet<ChainVerification>('/v1/audit/verify'),
  ]);

  const open = handoffs.data?.handoffs ?? [];
  const breached = open.filter((h) => h.breached);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="eyebrow">Finance Expert</div>
          <h1>Overview</h1>
        </div>
        {health.data ? (
          <span className={`chip ${health.data.force_dry_run ? 'chip--note' : 'chip--cleared'}`}>
            {health.data.environment} ·{' '}
            {health.data.force_dry_run ? 'dry-run forced' : 'live writes'}
          </span>
        ) : null}
      </div>

      <p className="lede">
        This worker holds no approval rights. It answers from a cited corpus, prepares work for a
        named human to decide on, and completes only what it has been explicitly graduated to do —
        inside limits you set, under a supervisor you name.
      </p>

      {health.problem ? <Problem problem={health.problem} /> : null}

      {/* The audit chain first: everything else depends on it being intact. */}
      <div className={`panel ${chain.data && !chain.data.ok ? 'sev sev--critical' : ''}`}>
        <div className="panel-head">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Audit chain
          </h2>
          <span className={`chip ${chain.data?.ok ? 'chip--cleared' : 'chip--critical'}`}>
            {chain.data?.ok ? 'verified' : chain.problem ? 'unavailable' : 'BROKEN'}
          </span>
        </div>

        {chain.problem ? (
          <Problem problem={chain.problem} />
        ) : chain.data?.ok ? (
          <p className="prose" style={{ margin: 0 }}>
            {chain.data.verified.toLocaleString()} events verified, sequence {chain.data.from} to{' '}
            {chain.data.to}. Every entry hashes onto the one before it, so a deletion or an edit
            anywhere in the history breaks every link after it.
          </p>
        ) : (
          <p className="prose" style={{ margin: 0 }}>
            The chain does not verify: {chain.data?.brokenAt?.reason}. This is an incident, not a
            warning — the audit log is the record every other control depends on.
          </p>
        )}
      </div>

      {/* Enrolment: until it is complete, nothing runs, and that is deliberate. */}
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Enrolment
          </h2>
          <span
            className={`chip ${settings.data?.ready_for_execution ? 'chip--cleared' : 'chip--material'}`}
          >
            {settings.data?.ready_for_execution ? 'ready' : 'incomplete'}
          </span>
        </div>

        {settings.problem ? (
          <Problem problem={settings.problem} />
        ) : settings.data?.ready_for_execution ? (
          <p className="prose" style={{ margin: 0 }}>
            Every mandatory field is populated and the settings snapshot is current.
          </p>
        ) : (
          <>
            <p className="prose">
              {settings.data?.families.filter((f) => !f.complete).length ?? 0} of{' '}
              {settings.data?.families.length ?? 0} settings families still have mandatory fields
              blank. Until they are set, requests that depend on them are refused with a message
              naming the field and its owner — the worker does not substitute a default, and it does
              not borrow an illustrative figure from an SOP.
            </p>
            <a className="btn btn--ghost" href="/enrolment">
              Open enrolment
            </a>
          </>
        )}
      </div>

      <h2>Decisions waiting on a person</h2>

      <div className="grid grid-3">
        <div className="panel metric">
          <span className="metric-label">Open hand-offs</span>
          <span className="metric-value">{open.length}</span>
          <span className="metric-note">awaiting a named human</span>
        </div>
        <div className={`panel metric ${breached.length > 0 ? 'sev sev--material' : ''}`}>
          <span className="metric-label">Past SLA</span>
          <span className="metric-value">{breached.length}</span>
          <span className="metric-note">
            {breached.length > 0 ? 'escalating on the next sweep' : 'none overdue'}
          </span>
        </div>
        <div className="panel metric">
          <span className="metric-label">Platform</span>
          <span className="metric-value" style={{ fontSize: 20 }}>
            {health.data?.platform_version ?? '—'}
          </span>
          <span className="metric-note">{health.data?.residency_zone ?? 'residency unknown'}</span>
        </div>
      </div>

      {open.length > 0 ? (
        <div className="panel" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Assignee</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 8).map((handoff) => (
                  <tr
                    key={handoff.handoff_id}
                    className={handoff.breached ? 'sev sev--material' : ''}
                  >
                    <td>{handoff.question}</td>
                    <td className="mono">{handoff.assignee_role_ref}</td>
                    <td className="num">{new Date(handoff.sla_due_at).toLocaleString('en-MY')}</td>
                    <td>
                      <a href={`/handoffs/${handoff.handoff_id}`}>Review</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <p className="footnote">
        Signed in as <span className="mono">{session.principal_id}</span> for tenant{' '}
        <span className="mono">{session.tenant_id}</span>. Everything on this page is read from the
        API at request time; nothing is cached, because a stale governance figure is worse than no
        figure.
      </p>
    </div>
  );
}
