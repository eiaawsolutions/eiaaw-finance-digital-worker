import QRCode from 'qrcode';
import { redirect } from 'next/navigation';
import { clearPendingFactor, getPendingFactor, submitCode } from '@/lib/auth';
import { textField } from '@/lib/form';

export const metadata = { title: 'Two-factor — Finance Expert console' };

interface Props {
  readonly searchParams: Promise<{ error?: string }>;
}

/** Grouped in fours, which is how people read a key they are typing by hand. */
function groupForReading(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}

export default async function VerifyPage({ searchParams }: Props) {
  const pending = await getPendingFactor();
  // Nothing parked, or it aged out. Either way there is no half-finished
  // sign-in to continue, and the honest move is to start again.
  if (!pending) redirect('/sign-in');

  const params = await searchParams;
  const enrolling = pending.purpose === 'awaiting_totp_enrolment';

  // Rendered on the server and inlined. The seed never reaches a third party,
  // which rules out every hosted QR generator.
  const qr =
    enrolling && pending.otpauth_uri
      ? await QRCode.toString(pending.otpauth_uri, {
          type: 'svg',
          margin: 1,
          width: 200,
          // The encoder needs literal colours, not CSS variables. These are
          // --ink and --surface from the locked token block; if those change,
          // change these with them.
          color: { dark: '#0f1a1d', light: '#ffffff' },
        })
      : null;

  async function verify(formData: FormData): Promise<void> {
    'use server';
    const current = await getPendingFactor();
    if (!current) redirect('/sign-in');

    const failure = await submitCode(
      current.challenge,
      textField(formData, 'code'),
      current.purpose,
    );

    if (failure) redirect(`/verify?error=${encodeURIComponent(failure.detail)}`);

    await clearPendingFactor();
    redirect('/');
  }

  return (
    <>
      <h1 className="auth-title">
        {enrolling ? (
          <>
            Set up your <em>authenticator</em>
          </>
        ) : (
          <>
            Enter your <em>authenticator code</em>
          </>
        )}
      </h1>

      {enrolling ? (
        <>
          <p className="auth-lede">
            Scan this with Google Authenticator, 1Password, Authy or any TOTP app, then enter the
            six digits it shows.
          </p>

          {qr ? (
            <div
              className="auth-qr"
              aria-label="Authenticator enrolment QR code"
              // The SVG is produced here from our own seed, not from anything a
              // visitor supplied.
              dangerouslySetInnerHTML={{ __html: qr }}
            />
          ) : null}

          {pending.totp_secret ? (
            <details className="auth-manual">
              <summary>Can&rsquo;t scan it?</summary>
              <p className="footnote">
                Add an account by hand, choosing time-based, and enter this key:
              </p>
              <p className="mono auth-secret">{groupForReading(pending.totp_secret)}</p>
            </details>
          ) : null}
        </>
      ) : (
        <p className="auth-lede">
          Open your authenticator app and enter the six digits currently shown for this console.
        </p>
      )}

      {params.error ? (
        <p className="notice notice--refusal" role="alert">
          {params.error}
        </p>
      ) : null}

      <form action={verify} className="auth-form">
        <label className="field">
          <span className="field-label">Six-digit code</span>
          <input
            className="ctl auth-code"
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,8}"
            maxLength={8}
            required
            autoFocus
            placeholder="000000"
          />
        </label>

        <button type="submit" className="btn btn--primary btn--wide">
          {enrolling ? 'Confirm and finish setup' : 'Sign in'}
        </button>
      </form>

      <p className="footnote">
        Codes change every 30 seconds. If yours is refused repeatedly, check that your
        device&rsquo;s clock is set automatically.
      </p>
    </>
  );
}
