import { describe, expect, it } from 'vitest';
import { SecretRef } from '@eiaaw/core';
import type { FastifyRequest } from 'fastify';
import { serviceTokenAuthenticator } from './authenticate.js';

const TOKEN = new SecretRef('API_SERVICE_TOKEN', 'svc-token-value');
const authenticate = serviceTokenAuthenticator(TOKEN);

const request = (headers: Record<string, string>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

const authorised = (extra: Record<string, string> = {}) =>
  request({
    authorization: 'Bearer svc-token-value',
    'x-tenant-id': 'tnt_acme',
    'x-principal-id': 'usr_reviewer',
    ...extra,
  });

describe('serviceTokenAuthenticator', () => {
  it('admits a caller presenting the service token and a principal', async () => {
    expect(await authenticate(authorised())).toEqual({
      tenant_id: 'tnt_acme',
      principal_id: 'usr_reviewer',
      clearance: 'internal',
      admin: false,
    });
  });

  it('refuses when no authorization header is present', async () => {
    expect(
      await authenticate(request({ 'x-tenant-id': 'tnt_acme', 'x-principal-id': 'usr_r' })),
    ).toBeNull();
  });

  it('refuses a wrong token', async () => {
    expect(await authenticate(authorised({ authorization: 'Bearer wrong-token' }))).toBeNull();
  });

  /**
   * A token of a different length must be rejected by the same path as a token
   * of the same length, or the rejection itself leaks the length.
   */
  it('refuses a token of a different length', async () => {
    expect(await authenticate(authorised({ authorization: 'Bearer short' }))).toBeNull();
  });

  it('refuses a scheme that is not Bearer', async () => {
    expect(await authenticate(authorised({ authorization: 'Basic svc-token-value' }))).toBeNull();
  });

  /**
   * The token says "this request came from the console". It does not say who
   * the console is acting for, so a request that does not name a principal has
   * nobody to attribute its actions to and is refused.
   */
  it('refuses a valid token with no principal named', async () => {
    expect(await authenticate(request({ authorization: 'Bearer svc-token-value' }))).toBeNull();
  });

  it('refuses a valid token with a tenant but no principal', async () => {
    expect(
      await authenticate(
        request({ authorization: 'Bearer svc-token-value', 'x-tenant-id': 'tnt_acme' }),
      ),
    ).toBeNull();
  });

  it('grants admin only when the header says so', async () => {
    expect((await authenticate(authorised({ 'x-admin': 'true' })))?.admin).toBe(true);
    expect((await authenticate(authorised({ 'x-admin': 'false' })))?.admin).toBe(false);
    expect((await authenticate(authorised({ 'x-admin': 'yes' })))?.admin).toBe(false);
  });

  it('carries a declared clearance through', async () => {
    expect((await authenticate(authorised({ 'x-clearance': 'restricted' })))?.clearance).toBe(
      'restricted',
    );
  });

  /**
   * An unrecognised clearance is refused rather than silently downgraded to
   * `internal`: a typo would otherwise read as a successful request at a lower
   * clearance than the caller believed they had.
   */
  it('refuses an unrecognised clearance rather than downgrading it', async () => {
    expect(await authenticate(authorised({ 'x-clearance': 'secret' }))).toBeNull();
  });

  it('does not accept the token from anywhere but the authorization header', async () => {
    expect(
      await authenticate(
        request({
          'x-service-token': 'svc-token-value',
          'x-tenant-id': 'tnt_acme',
          'x-principal-id': 'usr_r',
        }),
      ),
    ).toBeNull();
  });
});
