import { redirect } from 'next/navigation';
import { acceptInvite, isFailure, setPendingFactor } from '@/lib/auth';
import { textField } from '@/lib/form';

export const metadata = { title: 'Set your password — Finance Expert console' };

interface Props {
  readonly searchParams: Promise<{ token?: string; error?: string }>;
}

export default async function SetPasswordPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = params.token ?? '';

  if (!token) {
    return (
      <>
        <h1 className="auth-title">That link is incomplete</h1>
        <p className="auth-lede">
          The address is missing its token. Open the link from your email in full, or ask for a new
          one.
        </p>
        <a className="btn btn--ghost btn--wide" href="/sign-in">
          Back to sign in
        </a>
      </>
    );
  }

  async function choosePassword(formData: FormData): Promise<void> {
    'use server';
    const password = textField(formData, 'password');
    const confirm = textField(formData, 'confirm');
    const carried = textField(formData, 'token');

    // Checked here rather than at the API: the API has no second field to
    // compare, and a mistyped confirmation is a typo, not a refusal.
    if (password !== confirm) {
      redirect(
        `/set-password?token=${encodeURIComponent(carried)}&error=${encodeURIComponent(
          'Those two passwords are not the same.',
        )}`,
      );
    }

    const result = await acceptInvite(carried, password);
    if (isFailure(result)) {
      redirect(
        `/set-password?token=${encodeURIComponent(carried)}&error=${encodeURIComponent(result.detail)}`,
      );
    }

    await setPendingFactor(result);
    redirect('/verify');
  }

  return (
    <>
      <h1 className="auth-title">
        Choose a <em>password</em>
      </h1>
      <p className="auth-lede">
        Twelve characters or more. Length is the only rule — a passphrase of ordinary words is both
        harder to guess and easier to remember than a short one full of substitutions.
      </p>

      {params.error ? (
        <p className="notice notice--refusal" role="alert">
          {params.error}
        </p>
      ) : null}

      <form action={choosePassword} className="auth-form">
        <input type="hidden" name="token" value={token} />

        <label className="field">
          <span className="field-label">New password</span>
          <input
            className="ctl"
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={12}
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">Confirm password</span>
          <input
            className="ctl"
            type="password"
            name="confirm"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>

        <button type="submit" className="btn btn--primary btn--wide">
          Set password and continue
        </button>
      </form>

      <p className="footnote">
        Next you will enrol an authenticator app. Until that is done the account cannot be signed in
        to with this password alone.
      </p>
    </>
  );
}
