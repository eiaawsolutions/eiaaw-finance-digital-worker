import { describe, expect, it } from 'vitest';
import { createInviteToken, hashInviteToken, inviteTokenMatches } from './tokens.js';

describe('invite tokens', () => {
  /**
   * The token goes in an email link; only its hash is stored. A database copy
   * therefore does not let the holder complete anybody's enrolment — the same
   * reason a password is not stored either.
   */
  it('returns a token to send and a hash to store, and they are not the same', () => {
    const issued = createInviteToken();

    expect(issued.token).not.toEqual(issued.tokenHash);
    expect(issued.tokenHash).toEqual(hashInviteToken(issued.token));
  });

  it('produces a URL-safe token, because it travels in a link', () => {
    expect(createInviteToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces at least 256 bits of entropy', () => {
    // base64url packs 6 bits per character.
    expect(createInviteToken().token.length * 6).toBeGreaterThanOrEqual(256);
  });

  it('produces a distinct token every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createInviteToken().token));

    expect(seen.size).toBe(50);
  });

  it('matches a token against its stored hash', () => {
    const issued = createInviteToken();

    expect(inviteTokenMatches(issued.token, issued.tokenHash)).toBe(true);
  });

  it('refuses a token that does not belong to the stored hash', () => {
    const issued = createInviteToken();
    const other = createInviteToken();

    expect(inviteTokenMatches(other.token, issued.tokenHash)).toBe(false);
  });

  it('refuses an empty token rather than matching an empty hash', () => {
    expect(inviteTokenMatches('', hashInviteToken(''))).toBe(false);
  });
});
