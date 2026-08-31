'use client';

import { useState } from 'react';

/**
 * The four reviewer moves — and no fifth control.
 *
 * file 04 s.6.3: `approve_with_comment` is deliberately not representable. A
 * comment that changes the output is an edit; one that does not is not a
 * decision. So there is no "approve with note" button here, and adding one
 * would require changing the contract, the database constraint and the API.
 *
 * The reject and edit paths REQUIRE their supporting input before the button
 * enables: a rejection with no reason code teaches the drift monitors nothing,
 * and an edit with no diff cannot become the record of truth.
 */
const REASON_CODES = [
  'incorrect_classification',
  'incorrect_calculation',
  'incorrect_period',
  'incorrect_entity',
  'missing_supporting_evidence',
  'stale_or_wrong_authority',
  'policy_or_threshold_misapplied',
  'out_of_scope_for_this_item',
  'presentation_or_format',
  'superseded_by_events',
  'other_with_free_text',
] as const;

type Move = 'approve' | 'edit_and_approve' | 'reject_with_reason' | 'reassign';

export function ReviewerActions({
  handoffId,
  bundleVersion,
  permittedMoves,
  dualControl,
}: {
  handoffId: string;
  bundleVersion: number;
  permittedMoves: string[];
  dualControl: boolean;
}) {
  const [move, setMove] = useState<Move | null>(null);
  const [reasonCode, setReasonCode] = useState<string>('');
  const [freeText, setFreeText] = useState('');
  const [nonce, setNonce] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const can = (m: Move): boolean => permittedMoves.includes(m);

  const ready =
    move !== null &&
    nonce.length > 0 &&
    (move !== 'reject_with_reason' || reasonCode.length > 0) &&
    (move !== 'reassign' || freeText.length > 0);

  async function submit(): Promise<void> {
    if (!ready || move === null) return;
    setSubmitting(true);
    setResult(null);

    try {
      const response = await fetch(`/api/handoffs/${handoffId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          move,
          nonce,
          bundle_version: bundleVersion,
          ...(reasonCode ? { reason_code: reasonCode } : {}),
          ...(freeText ? { free_text: freeText } : {}),
        }),
      });

      const payload = (await response.json()) as Record<string, unknown>;

      setResult({
        ok: response.ok,
        message: response.ok
          ? payload['awaiting_second_approver'] === true
            ? 'Recorded. This item requires a second, different approver before it takes effect.'
            : 'Recorded. Your decision is in the audit log.'
          : typeof payload['detail'] === 'string'
            ? payload['detail']
            : 'The action was refused.',
      });
    } catch {
      setResult({ ok: false, message: 'Could not reach the API. Nothing was recorded.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title" style={{ margin: 0 }}>
          Your decision
        </h2>
        {dualControl ? <span className="chip chip--material">needs two people</span> : null}
      </div>

      <div className="btn-row" role="group" aria-label="Reviewer moves">
        <button
          type="button"
          className={`btn ${move === 'approve' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setMove('approve')}
          disabled={!can('approve')}
          aria-pressed={move === 'approve'}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn ${move === 'edit_and_approve' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setMove('edit_and_approve')}
          disabled={!can('edit_and_approve')}
          aria-pressed={move === 'edit_and_approve'}
        >
          Edit and approve
        </button>
        <button
          type="button"
          className={`btn ${move === 'reject_with_reason' ? 'btn--danger' : 'btn--ghost'}`}
          onClick={() => setMove('reject_with_reason')}
          disabled={!can('reject_with_reason')}
          aria-pressed={move === 'reject_with_reason'}
        >
          Reject with reason
        </button>
        <button
          type="button"
          className={`btn ${move === 'reassign' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setMove('reassign')}
          disabled={!can('reassign')}
          aria-pressed={move === 'reassign'}
        >
          Reassign
        </button>
      </div>

      {move === 'approve' ? (
        <p className="prose" style={{ marginTop: 'var(--sp-4)' }}>
          The output takes effect exactly as prepared. Your identity and the artefact hash are
          recorded against it.
        </p>
      ) : null}

      {move === 'edit_and_approve' ? (
        <p className="prose" style={{ marginTop: 'var(--sp-4)' }}>
          The edited output becomes the record of truth, and the difference is kept as a labelled
          signal. Recurring edits of the same shape are treated as a defect in the skill, not as
          normal review.
        </p>
      ) : null}

      {move === 'reject_with_reason' ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <label className="metric-label" htmlFor="reason">
            Reason
          </label>
          <select
            id="reason"
            className="ctl"
            style={{ display: 'block', marginTop: 'var(--sp-2)', width: '100%', maxWidth: 420 }}
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value)}
          >
            <option value="">Choose a reason…</option>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <p className="prose" style={{ marginTop: 'var(--sp-3)', marginBottom: 0 }}>
            The reason code is required because it feeds the accuracy floor and the drift monitors.
            A rejection with no reason tells the system nothing about what to fix.
          </p>
        </div>
      ) : null}

      {move === 'reassign' ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <label className="metric-label" htmlFor="reassign-to">
            Reassign to, and why
          </label>
          <input
            id="reassign-to"
            className="ctl"
            style={{ display: 'block', marginTop: 'var(--sp-2)', width: '100%', maxWidth: 420 }}
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Named person and reason"
          />
          <p className="prose" style={{ marginTop: 'var(--sp-3)', marginBottom: 0 }}>
            The SLA clock keeps running. Reassignment moves the decision, not the deadline.
          </p>
        </div>
      ) : null}

      {move !== null ? (
        <>
          {move !== 'reject_with_reason' && move !== 'reassign' ? (
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <label className="metric-label" htmlFor="note">
                Note (optional)
              </label>
              <input
                id="note"
                className="ctl"
                style={{ display: 'block', marginTop: 'var(--sp-2)', width: '100%', maxWidth: 560 }}
                value={freeText}
                onChange={(event) => setFreeText(event.target.value)}
              />
            </div>
          ) : null}

          <div style={{ marginTop: 'var(--sp-4)' }}>
            <label className="metric-label" htmlFor="nonce">
              Approval token
            </label>
            <input
              id="nonce"
              className="ctl mono"
              style={{ display: 'block', marginTop: 'var(--sp-2)', width: '100%', maxWidth: 560 }}
              value={nonce}
              onChange={(event) => setNonce(event.target.value)}
              placeholder="From the hand-off message"
              autoComplete="off"
            />
            <p className="prose" style={{ marginTop: 'var(--sp-3)' }}>
              The token came with the hand-off and works once. It is bound to this bundle version,
              so if the proposal is revised while you are reading, your token stops working and you
              are shown the new version rather than approving the old one.
            </p>
          </div>

          <div className="btn-row" style={{ marginTop: 'var(--sp-4)' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submit()}
              disabled={!ready || submitting}
            >
              {submitting ? 'Recording…' : `Record: ${move.replace(/_/g, ' ')}`}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setMove(null);
                setResult(null);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {result ? (
        <div
          className={`notice ${result.ok ? 'notice--ok' : 'notice--refusal'}`}
          style={{ marginTop: 'var(--sp-4)' }}
          role="status"
        >
          <div className="notice-body">{result.message}</div>
        </div>
      ) : null}
    </div>
  );
}
