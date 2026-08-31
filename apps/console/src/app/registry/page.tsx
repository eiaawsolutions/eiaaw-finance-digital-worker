import { Problem } from '@/components/problem';
import { apiGet, type OutputClassRow, type ToolRow } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * "What it may do."
 *
 * Published for anyone in the tenant, deliberately. The reserved-acts register
 * is the answer to "could this thing pay someone by mistake" — and that answer
 * is more reassuring when it is a table anyone can read than when it is a
 * paragraph in a contract.
 */
export default async function RegistryPage() {
  const [classes, tools] = await Promise.all([
    apiGet<{ output_classes: OutputClassRow[] }>('/v1/registry/output-classes'),
    apiGet<{ tools: ToolRow[] }>('/v1/registry/tools'),
  ]);

  const register = classes.data?.output_classes ?? [];
  const reserved = register.filter((c) => c.reserved_act);
  const permitted = register.filter((c) => !c.reserved_act);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <div className="eyebrow">Understand</div>
          <h1>What it may do</h1>
        </div>
      </div>

      <p className="lede">
        Every class of output the worker can be involved in, and how far it may take each one.
        Moving an act out of the reserved column is a platform change, not a setting — no
        configuration in your tenant can do it, and neither can an instruction in a message.
      </p>

      {classes.problem ? <Problem problem={classes.problem} /> : null}

      <h2>Reserved to a human — {reserved.length} classes</h2>
      <p className="prose" style={{ marginBottom: 'var(--sp-4)' }}>
        The worker may prepare, validate and present these. It may never complete them. Each is
        blocked in three independent places: the credential does not hold the scope, the policy
        engine refuses the act, and the register caps the autonomy.
      </p>

      <div className="panel">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Output class</th>
                <th>How far it may go</th>
                <th>Accountable</th>
                <th>Ceiling</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {reserved.map((entry) => (
                <tr key={entry.output_class} className="sev sev--critical">
                  <td>{entry.label}</td>
                  <td className="muted">{entry.worker_maximum_contribution}</td>
                  <td className="mono">{entry.accountable_role_ref}</td>
                  <td>
                    <span className="chip chip--critical">{entry.autonomy_ceiling}</span>
                  </td>
                  <td className="num">{entry.immutable_rule_ref ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2>May be completed within limits — {permitted.length} classes</h2>
      <p className="prose" style={{ marginBottom: 'var(--sp-4)' }}>
        These can reach Execute, but only where you have switched the row on, named an individual
        supervisor, recorded a dated approval and a completed parallel run, and set a non-zero
        sampling rate. Absent any one of those, the row runs at Observe.
      </p>

      <div className="panel">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Output class</th>
                <th>How far it may go</th>
                <th>Accountable</th>
                <th>Ceiling</th>
              </tr>
            </thead>
            <tbody>
              {permitted.map((entry) => (
                <tr
                  key={entry.output_class}
                  className={
                    entry.autonomy_ceiling === 'execute' ? 'sev sev--cleared' : 'sev sev--note'
                  }
                >
                  <td>{entry.label}</td>
                  <td className="muted">{entry.worker_maximum_contribution}</td>
                  <td className="mono">{entry.accountable_role_ref}</td>
                  <td>
                    <span
                      className={`chip ${entry.autonomy_ceiling === 'execute' ? 'chip--cleared' : 'chip--note'}`}
                    >
                      {entry.autonomy_ceiling}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tools.data ? (
        <>
          <h2>Capabilities — {tools.data.tools.length} tools</h2>
          <p className="prose" style={{ marginBottom: 'var(--sp-4)' }}>
            Nothing outside this registry is callable. There is deliberately no tool that releases a
            payment, transmits a filing, approves a payroll run or certifies a reconciliation — the
            capability does not exist, so it cannot be reached by a misconfiguration.
          </p>

          <div className="panel">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Capability</th>
                    <th>Scope</th>
                    <th>Effect</th>
                    <th>Undo</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.data.tools.map((tool) => (
                    <tr
                      key={tool.tool_id}
                      className={
                        tool.irreversible
                          ? 'sev sev--critical'
                          : tool.state_changing
                            ? 'sev sev--material'
                            : 'sev sev--note'
                      }
                    >
                      <td className="mono">{tool.tool_id}</td>
                      <td>{tool.name}</td>
                      <td className="mono">{tool.permission_scope}</td>
                      <td>
                        {tool.irreversible ? (
                          <span className="chip chip--critical">irreversible</span>
                        ) : tool.state_changing ? (
                          <span className="chip chip--material">writes</span>
                        ) : (
                          <span className="chip chip--note">reads</span>
                        )}
                      </td>
                      <td className="mono">{tool.compensation_tool_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <p className="footnote">
        An irreversible tool is never reachable at Execute autonomy, always requires two people, and
        is always sequenced last — so that everything before it can still be undone at the moment it
        runs.
      </p>
    </div>
  );
}
