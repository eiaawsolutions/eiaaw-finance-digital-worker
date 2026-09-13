import { redirect } from 'next/navigation';
import {
  getSession,
  isFailure,
  requestLink,
  setPendingFactor,
  signInWithPassword,
} from '@/lib/auth';
import { textField } from '@/lib/form';

export const metadata = { title: 'Sign in — Finance Expert console' };

interface Props {
  readonly searchParams: Promise<{ error?: string; sent?: string }>;
}

/**
 * One form, two actions.
 *
 * Signing in and asking for a link both need the address and nothing else
 * differs, so they share a field rather than making someone type it twice. Two
 * separate forms could not share it without client-side script, and this page
 * deliberately has none: it is the last page that still works when everything
 * else is broken.
 */
export default async function SignInPage({ searchParams }: Props) {
  // Someone already signed in has no business on this page.
  if (await getSession()) redirect('/');

  const params = await searchParams;

  async function submitPassword(formData: FormData): Promise<void> {
    'use server';
    const result = await signInWithPassword(
      textField(formData, 'email'),
      textField(formData, 'password'),
    );

    if (isFailure(result)) redirect(`/sign-in?error=${encodeURIComponent(result.detail)}`);

    await setPendingFactor(result);
    redirect('/verify');
  }

  async function sendLink(formData: FormData): Promise<void> {
    'use server';
    await requestLink(textField(formData, 'email'));
    // Always the same answer, whatever happened. The API refuses to say whether
    // an address is known here, and this page must not undo that by behaving
    // differently for one that is.
    redirect('/sign-in?sent=1');
  }

  return (
    <>
      <h1 className="auth-title">
        Sign in to the <em>governance console</em>
      </h1>
      <p className="auth-lede">
        Approvals recorded here name you personally and are written into an audit chain that cannot
        be edited afterwards. Two factors are required.
      </p>

      {params.sent ? (
        <p className="notice notice--ok" role="status">
          If that address has console access, a link is on its way. It expires in 60 minutes and
          works once.
        </p>
      ) : null}

      {params.error ? (
        <p className="notice notice--refusal" role="alert">
          {params.error}
        </p>
      ) : null}

      <form className="auth-form">
        <label className="field">
          <span className="field-label">Email address</span>
          <input
            className="ctl"
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            placeholder="you@eiaawsolutions.com"
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input className="ctl" type="password" name="password" autoComplete="current-password" />
        </label>

        <button type="submit" formAction={submitPassword} className="btn btn--primary btn--wide">
          Continue
        </button>

        <div className="auth-alt">
          <p className="auth-alt-title">First time here, or forgotten your password?</p>
          <p className="footnote">
            Leave the password blank and we will email that address a single-use link to set one and
            enrol your authenticator.
          </p>
          <button
            type="submit"
            formAction={sendLink}
            formNoValidate
            className="btn btn--ghost btn--wide"
          >
            Email me a link
          </button>
        </div>
      </form>
    </>
  );
}
