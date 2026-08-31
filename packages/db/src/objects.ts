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
}): ObjectStore {
  if (options.driver === 'local') {
    return new ObjectStore({
      db: options.db,
      residencyZone: options.residencyZone,
      driver: new LocalObjectStoreDriver(options.localPath),
    });
  }
  throw new WorkerError('contract_invalid', {
    detail:
      'The S3/R2 object store driver is not wired in this build. Set ' +
      'OBJECT_STORE_DRIVER=local, or implement ObjectStoreDriver against R2 and ' +
      'register it here. Absence is a refusal, not a silent fallback to local disk.',
    failureClass: 'configuration',
    retryable: false,
  });
}
