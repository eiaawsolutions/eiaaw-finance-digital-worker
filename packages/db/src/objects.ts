/**
 * Object store — DWD-06 s.10.4.
 *
 *   "Content-addressed by SHA-256; write-once; server-side encryption with
 *    tenant-scoped keys from KMS; lifecycle transitions by class; NO OBJECT IS
 *    DELETED while an audit event references it and its retention has not
 *    expired."
 *
 * Two drivers behind one port: a local filesystem driver for development, and
 * an S3-compatible driver targeting Cloudflare R2 in EIAAW deployments.
 * Swapping them changes nothing above this file.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { WorkerError } from '@eiaaw/core';
import { type Database, type TenantScope, withTenant } from './client.js';

export type ObjectClass =
  | 'raw_inbound'
  | 'attachment'
  | 'extracted_text'
  | 'rendered_output'
  | 'working_paper'
  | 'diff'
  | 'audit_payload'
  | 'skill_input'
  | 'skill_output';

export interface PutObjectInput {
  readonly tenantId: string;
  readonly objectClass: ObjectClass;
  readonly body: Buffer | string;
  readonly mediaType: string;
  /** file 07 s.3.2 — untagged is Restricted, so tagging at write time matters. */
  readonly dataClasses?: readonly string[];
  readonly retentionUntil?: string | null;
  /** Explicit key; otherwise derived from the content hash. */
  readonly key?: string;
}

export interface StoredObject {
  readonly storage_ref: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly media_type: string;
}

export interface ObjectStoreDriver {
  put(key: string, body: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

/** Local filesystem driver. Development and test only. */
export class LocalObjectStoreDriver implements ObjectStoreDriver {
  constructor(private readonly root: string) {}

  #path(key: string): string {
    // Confine to the root: a key containing `..` must not escape it.
    const target = resolve(join(this.root, key));
    const root = resolve(this.root);
    if (!target.startsWith(root)) {
      throw new WorkerError('contract_invalid', {
        detail: `Object key "${key}" escapes the store root.`,
        failureClass: 'internal',
        retryable: false,
      });
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.#path(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.#path(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** Only the part of the AWS SDK client this driver uses. */
export interface S3ClientShape {
  send(command: never): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  }>;
}

export interface S3DriverConfig {
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The parts of an AWS SDK error this driver classifies on. */
interface S3Failure {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

/**
 * Every way a credential can be refused rather than merely fail.
 *
 * These are grouped with `AccessDenied` deliberately: an R2 token that is valid
 * but scoped to a different bucket, a rotated key, and a malformed signature all
 * present as an authentication-shaped error against a bucket that does exist,
 * and all three are fixed by looking at the token rather than by retrying.
 */
const CREDENTIAL_REFUSED = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'CredentialsProviderError',
]);

/** The SDK surface, resolved once and held. */
interface S3Sdk {
  readonly client: S3ClientShape;
  readonly PutObjectCommand: new (input: Record<string, unknown>) => never;
  readonly GetObjectCommand: new (input: Record<string, unknown>) => never;
  readonly HeadObjectCommand: new (input: Record<string, unknown>) => never;
}

/**
 * S3-compatible driver, targeting Cloudflare R2.
 *
 * R2 is S3-API-compatible but not S3: it ignores the region, so the SDK's
 * mandatory `region` is pinned to `auto` rather than guessed from the endpoint.
 *
 * The SDK is imported lazily so a local-driver boot never loads it, matching
 * how the Infisical provider treats its client.
 */
export class S3ObjectStoreDriver implements ObjectStoreDriver {
  #sdk: S3Sdk | undefined;
  #injected: S3ClientShape | undefined;

  constructor(
    private readonly config: S3DriverConfig,
    client?: S3ClientShape,
  ) {
    this.#injected = client;
  }

  async #ensure(): Promise<S3Sdk> {
    if (this.#sdk) return this.#sdk;
    const mod = (await import('@aws-sdk/client-s3')) as unknown as {
      S3Client: new (opts: Record<string, unknown>) => S3ClientShape;
      PutObjectCommand: S3Sdk['PutObjectCommand'];
      GetObjectCommand: S3Sdk['GetObjectCommand'];
      HeadObjectCommand: S3Sdk['HeadObjectCommand'];
    };
    this.#sdk = {
      client:
        this.#injected ??
        new mod.S3Client({
          region: 'auto',
          endpoint: this.config.endpoint,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
        }),
      PutObjectCommand: mod.PutObjectCommand,
      GetObjectCommand: mod.GetObjectCommand,
      HeadObjectCommand: mod.HeadObjectCommand,
    };
    return this.#sdk;
  }

  /**
   * Classify a write failure.
   *
   * `get` may assume the bucket is reachable, because a row in `stored_objects`
   * is proof that something already wrote there. A write has no such witness:
   * the first artefact a deployment stores is also the first evidence that the
   * bucket name and the credential agree with each other. The two configuration
   * failures — a bucket that was never created, and a token scoped to a
   * different bucket — are therefore named apart here. Both stay silent through
   * boot, settings validation and every health check, and both surface as an
   * indistinguishable SDK stack trace at the worst possible moment.
   */
  #writeFailure(key: string, cause: unknown): WorkerError {
    const failure: S3Failure = typeof cause === 'object' && cause !== null ? cause : {};
    const status = failure.$metadata?.httpStatusCode;
    const context = { object_key: key, bucket: this.config.bucket };

    if (failure.name === 'NoSuchBucket' || status === 404) {
      return new WorkerError('dependency_unavailable', {
        detail:
          `Bucket "${this.config.bucket}" does not exist at ${this.config.endpoint}. ` +
          'OBJECT_STORE_BUCKET names a bucket that was never created — refusing rather ' +
          'than writing an evidence artefact somewhere it was not accounted for.',
        failureClass: 'configuration',
        retryable: false,
        cause,
        context,
      });
    }

    if (CREDENTIAL_REFUSED.has(failure.name ?? '') || status === 401 || status === 403) {
      return new WorkerError('dependency_unavailable', {
        detail:
          `The configured credentials were refused for bucket "${this.config.bucket}" ` +
          `(${failure.name ?? `HTTP ${String(status)}`}). A token scoped to a different ` +
          'bucket authenticates successfully and then denies every write, so check the ' +
          'bucket scope on the token before assuming the key itself is wrong or expired.',
        failureClass: 'configuration',
        retryable: false,
        cause,
        context,
      });
    }

    return new WorkerError('dependency_unavailable', {
      detail:
        `Writing "${key}" to bucket "${this.config.bucket}" failed ` +
        `(${failure.name ?? 'unknown'}${status === undefined ? '' : `, HTTP ${String(status)}`}).`,
      failureClass: 'tool',
      retryable: true,
      cause,
      context,
    });
  }

  async put(key: string, body: Buffer, mediaType: string): Promise<void> {
    const sdk = await this.#ensure();
    try {
      await sdk.client.send(
        new sdk.PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: mediaType,
          // No transport-level ChecksumAlgorithm. `ObjectStore.get` already
          // verifies the body against the SHA-256 recorded in `stored_objects`,
          // which is the stronger check because it also covers at-rest corruption
          // and is enforced on every read. Adding an S3 checksum header would put
          // an untested R2 compatibility question on the write path — and a write
          // path that fails only when a real artefact is first stored is a worse
          // failure than one that fails at boot.
        }),
      );
    } catch (cause) {
      throw this.#writeFailure(key, cause);
    }
  }

  async get(key: string): Promise<Buffer> {
    const sdk = await this.#ensure();
    let response: { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    try {
      response = await sdk.client.send(
        new sdk.GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    } catch (cause) {
      // The caller reached here from a `stored_objects` row, so the object is
      // registered. Missing content is a chain-of-custody failure, not a miss.
      throw new WorkerError('dependency_unavailable', {
        detail:
          `Object "${key}" is registered for this tenant but absent from bucket ` +
          `"${this.config.bucket}". An evidence artefact that the database ` +
          'accounts for and the store cannot produce is a chain-of-custody failure.',
        failureClass: 'internal',
        retryable: false,
        cause,
        context: { object_key: key },
      });
    }
    if (!response.Body) {
      throw new WorkerError('dependency_unavailable', {
        detail: `Object "${key}" returned no body from bucket "${this.config.bucket}".`,
        failureClass: 'internal',
        retryable: true,
        context: { object_key: key },
      });
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    const sdk = await this.#ensure();
    try {
      await sdk.client.send(new sdk.HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return true;
    } catch {
      // HEAD distinguishes absence from failure poorly across S3 implementations;
      // callers use this only to skip a redundant upload, so treating any
      // negative answer as "not present" costs a re-put and never corrupts.
      return false;
    }
  }
}

export interface ObjectStoreOptions {
  readonly db: Database;
  readonly driver: ObjectStoreDriver;
  readonly residencyZone: string;
}

export class ObjectStore {
  readonly #db: Database;
  readonly #driver: ObjectStoreDriver;
  readonly #residencyZone: string;

  constructor(options: ObjectStoreOptions) {
    this.#db = options.db;
    this.#driver = options.driver;
    this.#residencyZone = options.residencyZone;
  }

  /**
   * Write once, content-addressed.
   *
   * An identical body written twice produces the same reference and is not
   * re-uploaded — which also makes attachment OCR idempotent, since the
   * content hash is the OCR key (file 05 s.10.7).
   */
  async put(input: PutObjectInput, scope?: TenantScope): Promise<StoredObject> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    const digest = createHash('sha256').update(body).digest('hex');
    const contentHash = `sha256:${digest}`;

    // Tenant prefix first: s.10.6 requires object prefixes namespaced by tenant.
    const key = input.key ?? `${input.tenantId}/${input.objectClass}/${digest}`;
    const storageRef = `obj://${key}`;

    if (!(await this.#driver.exists(key))) {
      await this.#driver.put(key, body, input.mediaType);
    }

    const record = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO stored_objects (
          tenant_id, storage_ref, content_hash, media_type, size_bytes,
          object_class, data_classes, residency_zone, retention_until
        ) VALUES (
          ${input.tenantId}, ${storageRef}, ${contentHash}, ${input.mediaType}, ${body.length},
          ${input.objectClass},
          ${input.dataClasses ?? []},
          ${this.#residencyZone},
          ${input.retentionUntil ?? null}
        )
        ON CONFLICT (tenant_id, storage_ref) DO NOTHING
      `;
    };

    if (scope) await record(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: input.tenantId, residencyZone: this.#residencyZone },
        record,
      );

    return {
      storage_ref: storageRef,
      content_hash: contentHash,
      size_bytes: body.length,
      media_type: input.mediaType,
    };
  }

  /**
   * Read an object back, verifying the content hash.
   *
   * A mismatch means the object store returned something other than what was
   * written — which for an evidence artefact is a chain-of-custody failure, not
   * a cache miss.
   */
  async get(tenantId: string, storageRef: string): Promise<Buffer> {
    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) =>
        scope.sql<{ content_hash: string; redacted_at: string | null }[]>`
          SELECT content_hash, redacted_at FROM stored_objects
           WHERE tenant_id = ${tenantId} AND storage_ref = ${storageRef}
        `,
    );

    const row = rows[0];
    if (!row) {
      throw new WorkerError('not_found', {
        detail: `Object ${storageRef} is not registered for this tenant.`,
        failureClass: 'internal',
        retryable: false,
      });
    }
    if (row.redacted_at !== null) {
      // s.10.7: purge redacts content and retains the record that the content
      // existed. This is that record answering.
      throw new WorkerError('not_found', {
        detail:
          `Object ${storageRef} was redacted at ${row.redacted_at} under the retention ` +
          'policy. The record that it existed is retained; the content is not.',
        failureClass: 'configuration',
        retryable: false,
      });
    }

    const key = storageRef.replace(/^obj:\/\//, '');
    const body = await this.#driver.get(key);
    const actual = `sha256:${createHash('sha256').update(body).digest('hex')}`;

    if (actual !== row.content_hash) {
      throw new WorkerError('internal_error', {
        detail:
          `Content hash mismatch for ${storageRef}: expected ${row.content_hash}, ` +
          `read ${actual}. The object store returned something other than what was written.`,
        failureClass: 'internal',
        retryable: false,
      });
    }

    return body;
  }

  /**
   * Mark an object redacted — s.10.7.
   *
   *   "Purge redacts content and retains the audit event that says the content
   *    existed and was purged. Deleting the evidence that something happened is
   *    never a retention outcome."
   */
  async redact(tenantId: string, storageRef: string, reason: string): Promise<void> {
    await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (scope) => {
      const rows = await scope.sql<{ referenced_by_audit: boolean }[]>`
          SELECT referenced_by_audit FROM stored_objects
           WHERE tenant_id = ${tenantId} AND storage_ref = ${storageRef}
             AND (retention_until IS NULL OR retention_until <= now())
        `;
      if (rows.length === 0) {
        throw new WorkerError('state_conflict', {
          detail:
            `Refusing to redact ${storageRef}: it is either unknown or still within its ` +
            'retention period. No object is deleted while its retention has not expired ' +
            '(DWD-06 s.10.4).',
          failureClass: 'configuration',
          retryable: false,
          context: { reason },
        });
      }

      await scope.sql`
          UPDATE stored_objects SET redacted_at = now()
           WHERE tenant_id = ${tenantId} AND storage_ref = ${storageRef}
        `;
    });
  }
}

export function createObjectStore(options: {
  readonly db: Database;
  readonly residencyZone: string;
  readonly driver: 'local' | 's3';
  readonly localPath: string;
  readonly bucket?: string;
  readonly endpoint?: string | null;
  readonly accessKeyId?: string | null;
  readonly secretAccessKey?: string | null;
}): ObjectStore {
  if (options.driver === 'local') {
    return new ObjectStore({
      db: options.db,
      residencyZone: options.residencyZone,
      driver: new LocalObjectStoreDriver(options.localPath),
    });
  }

  // Named individually rather than as "credentials are incomplete": the whole
  // point of the settings contract is that a refusal says which field is
  // missing, so the operator does not go hunting.
  const missing = [
    options.bucket ? null : 'OBJECT_STORE_BUCKET',
    options.endpoint ? null : 'OBJECT_STORE_ENDPOINT',
    options.accessKeyId ? null : 'OBJECT_STORE_ACCESS_KEY_ID',
    options.secretAccessKey ? null : 'OBJECT_STORE_SECRET_ACCESS_KEY',
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new WorkerError('contract_invalid', {
      detail:
        `The S3/R2 object store is selected but ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Absence is a refusal, ` +
        'not a silent fallback to local disk — an evidence artefact written to a ' +
        "container's ephemeral disk is lost on the next deploy.",
      failureClass: 'configuration',
      retryable: false,
    });
  }

  return new ObjectStore({
    db: options.db,
    residencyZone: options.residencyZone,
    driver: new S3ObjectStoreDriver({
      bucket: options.bucket as string,
      endpoint: options.endpoint as string,
      accessKeyId: options.accessKeyId as string,
      secretAccessKey: options.secretAccessKey as string,
    }),
  });
}
