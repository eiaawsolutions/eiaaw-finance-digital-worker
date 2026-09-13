/**
 * The unauthenticated shell.
 *
 * One centred card on the warm ground, no navigation. A visitor here has not
 * proved anything yet, so there is nothing to navigate and nothing about the
 * system worth showing them.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-ground">
      <div className="auth-card">
        <div className="auth-lockup">
          <span className="lockup-mark" aria-hidden="true">
            FE
          </span>
          <span className="lockup-text">
            <strong>EIAAW Solutions</strong>
            <small>AI &middot; Human Partnerships</small>
          </span>
        </div>
        {children}
      </div>
      <p className="auth-foot mono">FINANCE EXPERT &middot; GOVERNANCE CONSOLE</p>
    </div>
  );
}
