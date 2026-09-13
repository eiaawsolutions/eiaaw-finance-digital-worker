import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Finance Expert — console',
  description:
    'The governance console for the EIAAW Finance Expert digital worker: hand-offs, ' +
    'scope, enrolment and the audit trail.',
};

/**
 * Document only. The navigation shell lives in `(app)/layout.tsx`, behind the
 * session guard, because a sign-in page that renders the rail shows an
 * unauthenticated visitor the shape of the system and offers them links they
 * cannot follow.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-MY">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
