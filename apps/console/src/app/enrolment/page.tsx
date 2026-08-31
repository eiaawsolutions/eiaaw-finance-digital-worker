import { Problem } from '@/components/problem';
import { apiGet, type SettingsHealth } from '@/lib/api';

export const dynamic = 'force-dynamic';

const STAGE_NAMES: Record<string, { stage: number; name: string; owner: string }> = {
  'AS-ORG': { stage: 1, name: 'Organisation identity', owner: 'Client admin' },
  'AS-SYS': { stage: 2, name: 'Systems and access', owner: 'IT / systems owner' },
  'AS-COA': { stage: 3, name: 'Financial structure', owner: 'Financial controller' },
  'AS-DOA': { stage: 4, name: 'Authority', owner: 'CFO' },
  'AS-REG': { stage: 5, name: 'Compliance registrations', owner: 'Tax and payroll leads' },
  'AS-RUL': { stage: 6, name: 'Business rules and thresholds', owner: 'Financial controller' },
  'AS-SCP': { stage: 7, name: 'Process scope and autonomy', owner: 'Accountable owner' },
  'AS-PPL': { stage: 8, name: 'People, notification, escalation', owner: 'Accountable owner' },
};

/**
 * Enrolment readiness.
 *
 * The most important sentence on this page is the one saying the worker will
 * not run until this is complete. That is not a limitation to apologise for —
 * an SOP executed against blank settings is an incident, not a shortcut.
 */
export default async function EnrolmentPage() {
  const result = await apiGet<SettingsHealth>('/v1/config/settings/health');
  const health = result.data;

  const families = (health?.families ?? [])
    .slice()
    .sort((a, b) => (STAGE_NAMES[a.family]?.stage ?? 99) - (STAGE_NAMES[b.family]?.stage ?? 99));

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="eyebrow">Operate</div>
          <h1>Enrolment</h1>
        </div>
        <span
          className={`chip ${health?.ready_for_execution ? 'chip--cleared' : 'chip--material'}`}
        >
          {health?.ready_for_execution ? 'ready' : 'incomplete'}
        </span>
      </div>

      <p className="lede">
        The knowledge base tells the worker what is true, who does what, and how a procedure runs.
        This is where you tell it about <em>your</em> organisation — and grant it permission to act.
        Until every mandatory field is set, the worker refuses the work that depends on them rather
        than guessing.
      </p>

      {result.problem ? <Problem problem={result.problem} /> : null}

      {health && !health.ready_for_execution ? (
        <div className="notice notice--refusal">
          <div className="notice-body">
            {health.snapshot_version === null
              ? 'No settings snapshot has been published. State-changing work cannot be admitted ' +
                'against unpinned configuration, because a mid-run change could otherwise alter a ' +
                'decision halfway through it.'
              : health.stale
                ? `The published snapshot is ${Math.round((health.snapshot_age_seconds ?? 0) / 3600)} hours old, ` +
                  'beyond the staleness bound. Read-only work continues with the staleness stated; ' +
                  'state-changing work is refused.'
                : 'Mandatory fields are still blank in the families marked below.'}
          </div>
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="num">Stage</th>
                <th>Settings family</th>
                <th>Owner</th>
                <th className="num">Fields</th>
                <th className="num">Set</th>
                <th className="num">Blank mandatory</th>
                <th className="num">TBC</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {families.map((family) => {
                const meta = STAGE_NAMES[family.family];
                return (
                  <tr
                    key={family.family}
                    className={family.complete ? 'sev sev--cleared' : 'sev sev--material'}
                  >
                    <td className="num mono">{meta?.stage ?? '—'}</td>
                    <td>
                      <span className="mono">{family.family}</span>{' '}
                      <span className="muted">{meta?.name}</span>
                    </td>
                    <td className="muted">{meta?.owner ?? '—'}</td>
                    <td className="num">{family.field_count}</td>
                    <td className="num">{family.populated_count}</td>
                    <td className="num">{family.blank_mandatory_count}</td>
                    <td className="num">{family.tbc_count}</td>
                    <td>
                      <span
                        className={`chip ${family.complete ? 'chip--cleared' : 'chip--material'}`}
                      >
                        {family.complete ? 'complete' : 'incomplete'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <h2>What blocks go-live</h2>
      <div className="panel">
        <ol className="prose" style={{ paddingLeft: 'var(--sp-5)' }}>
          <li>Every mandatory field set, with nothing left as TBC.</li>
          <li>Every approver reference resolving to a named, currently-active person.</li>
          <li>
            Every supervisor reference resolving to a named individual — not a role or a mailbox.
          </li>
          <li>System limits matching the delegation of authority you recorded.</li>
          <li>Segregation-of-duties conflicts blocked, or the compensating control documented.</li>
          <li>The worker&rsquo;s permissions excluding approve and admin in every system.</li>
          <li>Statutory rates and deadlines re-verified against the authority, and dated.</li>
          <li>A parallel run completed and reconciled with no unexplained difference.</li>
          <li>Autonomy levels approved in writing, per SOP row.</li>
          <li>A Scope Card generated and published by a human.</li>
        </ol>
      </div>

      <p className="footnote">
        The platform ships no client value and no statutory rate. Every threshold, tolerance,
        materiality figure, approval limit and contribution rate is yours to enter and yours to keep
        current — which is also why the worker can tell you exactly which one is missing when it
        refuses.
      </p>
    </div>
  );
}
