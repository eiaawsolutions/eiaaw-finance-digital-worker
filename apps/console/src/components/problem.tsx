import type { ApiResult } from '@/lib/api';

/**
 * Render a refusal.
 *
 * The API's refusals are written to be read by a person: DWD-06 s.13.3 requires
 * them to name what is missing, why it is needed, who owns it, and what the
 * requester can do meanwhile. So this component shows the `detail` VERBATIM
 * rather than mapping it to a friendlier message — the friendlier message
 * would be the one that loses the actionable part.
 */
export function Problem({ problem }: { problem: NonNullable<ApiResult<unknown>['problem']> }) {
  const isRefusal =
    problem.error_code === 'authority_insufficient' ||
    problem.error_code === 'scope_denied' ||
    problem.error_code === 'sensitivity_ceiling' ||
    problem.detail.startsWith('I cannot ');

  return (
    <div className={`notice ${isRefusal ? 'notice--refusal' : ''}`} role="status">
      <div
        style={{
          display: 'flex',
          gap: 'var(--sp-2)',
          alignItems: 'center',
          marginBottom: 'var(--sp-2)',
        }}
      >
        <span className={`chip ${isRefusal ? 'chip--critical' : 'chip--note'}`}>
          {problem.error_code.replace(/_/g, ' ')}
        </span>
        <strong style={{ fontSize: 'var(--fs-data)' }}>{problem.title}</strong>
      </div>
      <div className="notice-body">{problem.detail}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
