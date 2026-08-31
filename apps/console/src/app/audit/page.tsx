import { Empty, Problem } from '@/components/problem';
import { apiGet, type AuditEventRow, type ChainVerification } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The audit trail.
 *
 * Read-only, and visibly so. There is no control on this page that edits or
 * deletes anything, because there is no such endpoint in any auth model —
 * purging content redacts it and keeps the record that it existed.
 */
export default async function AuditPage() {
  const [events, chain] = await Promise.all([
    apiGet<{ events: AuditEventRow[]; nextCursor: number | null }>('/v1/audit/events?limit=100'),
    apiGet<ChainVerification>('/v1/audit/verify'),
  ]);

  const rows = events.data?.events ?? [];

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="eyebrow">Operate</div>
          <h1>Audit trail</h1>
        </div>
        <span className={`chip ${chain.data?.ok ? 'chip--cleared' : 'chip--critical'}`}>
          {chain.data?.ok ? `${chain.data.verified.toLocaleString()} verified` : 'chain broken'}
        </span>
      </div>

      <p className="lede">
        Every action the worker took, in order, each entry hashed onto the one before it. Nothing
        here can be edited or removed — not by an administrator, not by the platform. Removing an
        entry would break every hash after it, which is the point.
      </p>

      {events.problem ? <Problem problem={events.problem} /> : null}

      {chain.data && !chain.data.ok ? (
        <div className="notice notice--refusal">
          <div className="notice-body">
            The chain does not verify at sequence{' '}
            {chain.data.from + (chain.data.brokenAt?.index ?? 0)}: {chain.data.brokenAt?.reason}
            {'\n\n'}
            This is an incident. The audit log is the record every other control depends on, so a
            break here invalidates the evidence behind every decision after it.
          </div>
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 'var(--sp-4)' }}>
        {rows.length === 0 ? (
          <Empty>No audit events yet for this tenant.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Layer</th>
                  <th>Component</th>
                  <th>Event</th>
                  <th>Subject</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr
                    key={event.event_id}
                    className={
                      event.outcome === 'failure' || event.outcome === 'blocked'
                        ? 'sev sev--critical'
                        : event.outcome === 'refused'
                          ? 'sev sev--material'
                          : 'sev sev--note'
                    }
                  >
                    <td className="num mono">
                      {new Date(event.occurred_at).toLocaleString('en-MY', {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                      })}
                    </td>
                    <td className="mono">{event.layer}</td>
                    <td className="mono">{event.component}</td>
                    <td>{event.event_type}</td>
                    <td className="mono">
                      {event.subject.kind}
                      <span className="muted"> {event.subject.id.slice(0, 18)}</span>
                    </td>
                    <td>
                      <span
                        className={`chip ${
                          event.outcome === 'success'
                            ? 'chip--cleared'
                            : event.outcome === 'refused'
                              ? 'chip--material'
                              : 'chip--critical'
                        }`}
                      >
                        {event.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="footnote">
        A refusal is recorded here as deliberately as a success. Counting refusals is how you find
        out whether the scope you granted matches the work people are actually asking for.
      </p>
    </div>
  );
}
