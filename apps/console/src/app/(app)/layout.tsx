import { redirect } from 'next/navigation';
import { Nav } from '@/components/nav';
import { getSession, signOut } from '@/lib/auth';

/**
 * The guard.
 *
 * Every authenticated page is inside this route group, so there is one place
 * that decides whether a visitor gets in rather than a check per page that can
 * be forgotten on the next one. Server-side: the redirect happens before any
 * markup is produced, so an unauthenticated visitor never receives the page and
 * then has it hidden from them.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  async function endSession(): Promise<void> {
    'use server';
    await signOut();
    redirect('/sign-in');
  }

  return (
    <div className="shell">
      <nav className="rail pane" aria-label="Primary">
        <a className="lockup" href="/">
          <span className="lockup-mark" aria-hidden="true">
            FE
          </span>
          <span className="lockup-text">
            <strong>EIAAW Solutions</strong>
            <small>AI &middot; Human Partnerships</small>
          </span>
        </a>

        <Nav />

        <div className="rail-foot">
          <p className="who">
            <span className="who-name">{session.principal_id}</span>
            <span className="mono who-meta">
              {session.tenant_id}
              {session.admin ? ' · admin' : ''}
            </span>
          </p>
          <form action={endSession}>
            <button type="submit" className="btn btn--ghost">
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <main className="pane">{children}</main>
    </div>
  );
}
