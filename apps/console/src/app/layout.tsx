import type { Metadata } from 'next';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Finance Expert — console',
  description:
    'The governance console for the EIAAW Finance Expert digital worker: hand-offs, ' +
    'scope, enrolment and the audit trail.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-MY">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
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
          </nav>
          <main className="pane">{children}</main>
        </div>
      </body>
    </html>
  );
}
