import { Problem } from '@/components/problem';
import { ReviewerActions } from '@/components/reviewer-actions';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface EvidenceBundle {
  bundle_id: string;
  bundle_version: number;
  output_class: string;
  proposed_output: { artifact_ref: string; content_hash: string; render_ref?: string };
  trace: { node_id: string; kind: string; summary: string }[];
  citations: {
    chunk_id: string;
    module_id: string;
    version: string;
    effective_from: string;
    locator: string;
  }[];
  records: {
    source_system_id: string;
    record_type: string;
    entity_id: string;
    period: string;
    connector_version: string;
    extracted_at: string;
  }[];
  policy_verdicts: string[];
  confidence_by_step: { node_id: string; confidence: string }[];
  lowest_confidence_step: string | null;
  assurance: Record<string, string>;
  cost_to_date: { amount_minor: number; currency: string; scale: number };
  pack_version: string;
  platform_version: string;
  assembled_at: string;
}

interface Handoff {
  handoff_id: string;
  question: string;
  decision_type: string;
  bundle_id: string;
  bundle_version: number;
  assignee_principal_id: string;
  assignee_role_ref: string;
  dual_control_required: boolean;
  sod_exclusions_applied: string[];
  permitted_moves: string[];
  sla_due_at: string;
  state: string;
}

/**
 * The reviewer's workspace.
 *
 * This is the surface the whole system exists to serve. Three things are
 * non-negotiable in its design:
 *
 *   1. The unapproved state is unmistakable and survives a screenshot
 *      (the draft banner and the diagonal wash).
 *   2. The evidence is complete — a reviewer approving on a summary is
 *      approving on partial information, which file 05 s.14 forbids.
 *   3. Exactly four moves. There is no fifth control anywhere on this page.
 */
export default async function HandoffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiGet<{ handoff: Handoff; evidence_bundle: EvidenceBundle | null }>(
    `/v1/handoffs/${id}`,
  );

  if (result.problem) {
    return (
      <div className="content">
        <h1>Hand-off</h1>
        <Problem problem={result.problem} />
      </div>
    );
  }

  const handoff = result.data?.handoff;
  const bundle = result.data?.evidence_bundle ?? null;
  if (!handoff) {
    return (
      <div className="content">
        <h1>Hand-off</h1>
        <p className="prose">This hand-off does not exist.</p>
      </div>
    );
  }

  const money = bundle
    ? (bundle.cost_to_date.amount_minor / 10 ** bundle.cost_to_date.scale).toFixed(
        bundle.cost_to_date.scale,
      )
    : null;

  return (
    <>
      {/* A compliance surface, not decoration. */}
      <div className="draft-banner">Not approved · nothing on this page has taken effect</div>

      <div className="content draft-surface">
        <div className="page-head">
          <div>
            <div className="eyebrow">{handoff.decision_type.replace(/_/g, ' ')}</div>
            <h1 style={{ maxWidth: '54ch' }}>{handoff.question}</h1>
          </div>
          {handoff.dual_control_required ? (
            <span className="chip chip--material">dual control required</span>
          ) : null}
        </div>

        <p className="lede">
          You are being asked one question. Everything the worker used to reach this proposal is
          below — the sources with their versions and effective dates, the records with their
          provenance, the policy verdicts at each step, and the gates that passed.
        </p>

        {/* --- the proposal ------------------------------------------------ */}
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title" style={{ margin: 0 }}>
              Proposed output
            </h2>
            <span className="chip">
              {bundle?.output_class.replace(/_/g, ' ') ?? 'unknown class'} · v
              {handoff.bundle_version}
            </span>
          </div>

          {bundle ? (
            <dl className="kv">
              <dt>Artefact</dt>
              <dd className="mono">{bundle.proposed_output.artifact_ref}</dd>
              <dt>Content hash</dt>
              <dd className="mono">{bundle.proposed_output.content_hash}</dd>
              <dt>Assembled</dt>
              <dd>{new Date(bundle.assembled_at).toLocaleString('en-MY')}</dd>
            </dl>
          ) : (
            <p className="prose muted" style={{ margin: 0 }}>
              The evidence bundle is not available. Do not approve: a decision without its evidence
              is not a reviewable decision.
            </p>
          )}
        </div>

        {/* --- gates -------------------------------------------------------- */}
        {bundle ? (
          <div className="panel">
            <h2 className="panel-title">Assurance</h2>
            <div className="grid grid-3">
              {(['grounding_gate', 'arithmetic_gate', 'consistency_gate'] as const).map((gate) => (
                <div
                  key={gate}
                  className={`sev ${bundle.assurance[gate] === 'pass' ? 'sev--cleared' : 'sev--critical'}`}
                >
                  <div className="metric-label">{gate.replace(/_/g, ' ')}</div>
                  <div style={{ fontSize: 'var(--fs-data)', fontWeight: 500 }}>
                    {bundle.assurance[gate] ?? 'not run'}
                  </div>
                </div>
              ))}
            </div>
            <p className="prose" style={{ marginTop: 'var(--sp-4)', marginBottom: 0 }}>
              A bundle cannot be assembled with a failing gate, so seeing this panel at all means
              the arithmetic was independently recomputed and every claim resolved to a source that
              covers the period.
            </p>
          </div>
        ) : null}

        {/* --- citations ---------------------------------------------------- */}
        {bundle && bundle.citations.length > 0 ? (
          <div className="panel">
            <h2 className="panel-title">Basis</h2>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Locator</th>
                    <th>Version</th>
                    <th>In force from</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.citations.map((citation) => (
                    <tr key={`${citation.chunk_id}-${citation.version}`}>
                      <td className="mono">{citation.module_id}</td>
                      <td>{citation.locator}</td>
                      <td className="mono num">{citation.version}</td>
                      <td className="num">{citation.effective_from}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* --- records ------------------------------------------------------ */}
        {bundle && bundle.records.length > 0 ? (
          <div className="panel">
            <h2 className="panel-title">Records read</h2>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>System</th>
                    <th>Record</th>
                    <th>Entity</th>
                    <th>Period</th>
                    <th>Read at</th>
                    <th>Connector</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.records.map((record, index) => (
                    <tr key={index}>
                      <td className="mono">{record.source_system_id}</td>
                      <td>{record.record_type}</td>
                      <td className="mono">{record.entity_id}</td>
                      <td className="num">{record.period}</td>
                      <td className="num">
                        {new Date(record.extracted_at).toLocaleString('en-MY')}
                      </td>
                      <td className="mono">{record.connector_version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* --- the trace: node-level, never a model transcript -------------- */}
        {bundle && bundle.trace.length > 0 ? (
          <div className="panel">
            <h2 className="panel-title">What it did</h2>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Kind</th>
                    <th>Summary</th>
                    <th className="num">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.trace.map((step) => {
                    const confidence = bundle.confidence_by_step.find(
                      (c) => c.node_id === step.node_id,
                    );
                    const lowest = bundle.lowest_confidence_step === step.node_id;
                    return (
                      <tr key={step.node_id} className={lowest ? 'sev sev--material' : ''}>
                        <td className="mono">{step.node_id}</td>
                        <td className="mono">{step.kind}</td>
                        <td>{step.summary}</td>
                        <td className="num">{confidence?.confidence ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="prose" style={{ marginTop: 'var(--sp-3)', marginBottom: 0 }}>
              This is the step trace, not a model transcript. Reasoning text is never placed in an
              evidence bundle — what you can audit is what was done, with what, in what order.
            </p>
          </div>
        ) : null}

        {/* --- provenance --------------------------------------------------- */}
        {bundle ? (
          <div className="panel">
            <h2 className="panel-title">Provenance</h2>
            <dl className="kv">
              <dt>Knowledge pack</dt>
              <dd className="mono">{bundle.pack_version}</dd>
              <dt>Platform</dt>
              <dd className="mono">{bundle.platform_version}</dd>
              <dt>Policy verdicts</dt>
              <dd className="mono">{bundle.policy_verdicts.length} recorded</dd>
              <dt>Cost</dt>
              <dd className="num">
                {money} {bundle.cost_to_date.currency}
              </dd>
              <dt>SoD exclusions</dt>
              <dd>{handoff.sod_exclusions_applied.join(', ') || 'none applied'}</dd>
            </dl>
          </div>
        ) : null}

        {/* --- exactly four moves ------------------------------------------- */}
        <ReviewerActions
          handoffId={handoff.handoff_id}
          bundleVersion={handoff.bundle_version}
          permittedMoves={handoff.permitted_moves}
          dualControl={handoff.dual_control_required}
        />

        <p className="footnote">
          Approving here records your identity, the exact artefact hash you approved, and the moment
          you did it, in an append-only log. That record is what makes the output yours rather than
          the worker&rsquo;s — accountability rests with a named human and cannot be delegated to
          it.
        </p>
      </div>
    </>
  );
}
