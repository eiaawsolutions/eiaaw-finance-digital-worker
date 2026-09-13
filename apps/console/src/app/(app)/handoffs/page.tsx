import { Empty, Problem } from '@/components/problem';
import { apiGet, type HandoffRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function HandoffsPage() {
  const result = await apiGet<{ handoffs: HandoffRow[] }>('/v1/handoffs?assignee=me');
  const handoffs = result.data?.handoffs ?? [];

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="eyebrow">Decide</div>
          <h1>Hand-offs</h1>
        </div>
      </div>

      <p className="lede">
        Work the digital worker has prepared and cannot complete itself. Each one names exactly one
        decision, and carries the full evidence behind it — the citations, the records, the policy
        verdicts and the arithmetic. Nothing here has taken effect.
      </p>

      {result.problem ? <Problem problem={result.problem} /> : null}

      <div className="panel">
        {handoffs.length === 0 ? (
          <Empty>
            Nothing is waiting on you.
            <div style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-data-xs)' }}>
              A hand-off appears here when the worker has prepared something a named human must
              decide on.
            </div>
          </Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Type</th>
                  <th>Control</th>
                  <th>Due</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {handoffs.map((handoff) => (
                  <tr
                    key={handoff.handoff_id}
                    className={handoff.breached ? 'sev sev--material' : 'sev sev--note'}
                  >
                    <td>{handoff.question}</td>
                    <td className="mono">{handoff.decision_type.replace(/_/g, ' ')}</td>
                    <td>
                      {handoff.dual_control_required ? (
                        <span className="chip chip--material">dual control</span>
                      ) : (
                        <span className="chip chip--note">single</span>
                      )}
                    </td>
                    <td className="num">
                      {new Date(handoff.sla_due_at).toLocaleString('en-MY', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td>
                      <span
                        className={`chip ${handoff.breached ? 'chip--critical' : 'chip--note'}`}
                      >
                        {handoff.breached ? 'past sla' : handoff.state.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td>
                      <a href={`/handoffs/${handoff.handoff_id}`}>Review</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="footnote">
        A hand-off past its SLA escalates automatically to the next person in the ladder. The clock
        is not reset by the escalation — it measures how long the decision has been outstanding, not
        how long the current holder has had it.
      </p>
    </div>
  );
}
