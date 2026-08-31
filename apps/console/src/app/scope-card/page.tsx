import { Problem } from '@/components/problem';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface ScopeCard {
  card_version: string;
  effective_from: string;
  content_hash: string;
  staleness_reason: string | null;
  content: {
    header: Record<string, unknown>;
    what_i_do: Record<string, unknown>;
    what_i_may_decide: Record<string, unknown>;
    where_a_human_signs: Record<string, unknown>;
    what_i_will_never_do: {
      immutable_rules: { number: number; statement: string; referral_target: string }[];
      out_of_scope_statement: string;
    };
    footer: Record<string, unknown>;
  };
}

/**
 * The Scope Card.
 *
 * Generated, never authored — it has no editable field, here or anywhere. This
 * page is the "meet your digital worker" surface: anyone in the tenant can read
 * it without a login barrier, and every message the worker sends links to it.
 */
export default async function ScopeCardPage() {
  const result = await apiGet<ScopeCard>('/v1/scope-card');

  if (result.problem) {
    return (
      <div className="content">
        <div className="page-head">
          <div>
            <div className="eyebrow">Understand</div>
            <h1>Scope Card</h1>
          </div>
        </div>
        <p className="lede">
          The published statement of what this worker does, what it may decide, and where a human
          must sign.
        </p>
        <Problem problem={result.problem} />
        <p className="footnote">
          The card is a build artefact: it is generated from the role profile, the reserved-acts
          register and your scope settings, and it fails closed. If any reference does not resolve —
          an unnamed supervisor, an unmapped role — generation aborts rather than emitting a card
          with a placeholder in it.
        </p>
      </div>
    );
  }

  const card = result.data as ScopeCard;
  const header = card.content.header;
  const rules = card.content.what_i_will_never_do.immutable_rules;

  return (
    <div className="content">
      {card.staleness_reason ? (
        <div className="notice notice--refusal" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="notice-body">
            This card is stale. Regeneration aborted: {card.staleness_reason}
          </div>
        </div>
      ) : null}

      <div className="page-head">
        <div>
          <div className="eyebrow">Understand</div>
          <h1>Scope Card</h1>
        </div>
        <span className="chip">
          v{card.card_version} · from {card.effective_from}
        </span>
      </div>

      <div className="notice notice--ok" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="notice-body">{String(header['disclosure'])}</div>
      </div>

      <div className="panel">
        <h2 className="panel-title">Who this is</h2>
        <dl className="kv">
          <dt>Worker</dt>
          <dd>{String(header['worker_display_name'])}</dd>
          <dt>Position</dt>
          <dd>{String(header['position_title'])}</dd>
          <dt>Entity</dt>
          <dd>
            {String(header['entity'])} <span className="mono">({String(header['entity_id'])})</span>
          </dd>
          <dt>Jurisdiction</dt>
          <dd>{String(header['jurisdiction'])}</dd>
          <dt>Currency</dt>
          <dd>{String(header['functional_currency'])}</dd>
          <dt>Fiscal year end</dt>
          <dd>{String(header['fiscal_year_end'])}</dd>
          <dt>Manager of record</dt>
          <dd>{(header['manager_of_record'] as { name?: string } | null)?.name ?? 'not named'}</dd>
          <dt>Card hash</dt>
          <dd className="mono">{card.content_hash}</dd>
        </dl>
      </div>

      <h2>What it will never do</h2>
      <p className="prose" style={{ marginBottom: 'var(--sp-4)' }}>
        These eleven are not settings. No administrator, and no instruction in any message, can
        switch one off. A person with the authority to do one of these does it themselves — they
        cannot direct the worker to do it for them.
      </p>

      <div className="panel">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Rule</th>
                <th>Who does it instead</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.number} className="sev sev--critical">
                  <td className="num mono">{rule.number}</td>
                  <td>{rule.statement}</td>
                  <td className="muted">{rule.referral_target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">Out of scope</h2>
        <p className="prose" style={{ margin: 0 }}>
          {card.content.what_i_will_never_do.out_of_scope_statement}
        </p>
      </div>

      <p className="footnote">
        This card is generated from your scope settings, the role profile and the reserved-acts
        register, and it has no editable field. The worker cannot generate, edit, approve or publish
        it — that is itself one of the rules above.
      </p>
    </div>
  );
}
