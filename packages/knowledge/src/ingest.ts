/**
 * L2 corpus ingestion — file 08 s.3.1.
 *
 *   "L2 corpus ingestion and chunk versioning with effective dates. Ingest the
 *    27 accounting and finance modules; chunk ids stable; version history
 *    retained."
 *
 * Two properties matter more than throughput:
 *
 *   **Stable chunk ids.** A citation in an evidence bundle two years old must
 *   still resolve. So the id is derived from (module, heading path), not from
 *   position — inserting a paragraph must not renumber everything after it.
 *
 *   **Version history retained.** Re-ingesting changed text does not overwrite:
 *   it closes the old version's effective range and opens a new one. That is
 *   what lets "what did the rule say in July 2024" be answerable.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256, type DateOnly } from '@eiaaw/core';
import { withPlatformScope, type Database } from '@eiaaw/db';
import type { EmbeddingProvider } from './service.js';

export interface ModuleFrontmatter {
  readonly id?: string;
  readonly title?: string;
  readonly jurisdictions?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly last_verified?: string;
  readonly effective_from?: string;
  readonly depth?: string;
}

export interface ParsedChunk {
  readonly chunk_id: string;
  readonly module_id: string;
  readonly source_id: string;
  readonly citation_locator: string;
  readonly heading_path: readonly string[];
  readonly content: string;
  readonly content_hash: string;
  readonly token_estimate: number;
  readonly is_statutory_rate: boolean;
}

/** Very rough, and only used to keep a chunk within a model's context budget. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Text that names a rate, a band or a threshold and therefore goes stale.
 *
 * Erring toward over-detection is correct here: a chunk wrongly flagged as a
 * statutory rate causes an extra verification task, while one wrongly missed
 * lets immutable rule 10 fail to fire on a figure that has since changed.
 */
const STATUTORY_RATE_SIGNALS =
  /\b(?:rate|band|threshold|ceiling|allowance|relief|exemption limit)\b[^.]{0,80}?\b\d+(?:\.\d+)?\s*(?:%|per ?cent)|\bRM\s?[\d,]+(?:\.\d+)?\b|\b(?:EPF|SOCSO|EIS|PCB|SST|GST|LHDN)\b/i;

/** Frontmatter is human-authored, so a scalar where a list belongs is normal. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

/**
 * Map corpus jurisdiction names onto the ISO-ish codes the L0 axes carry.
 *
 * The modules are written for humans ("Malaysia"), while a resolved context
 * carries "MY". Without this the axis filter would silently match nothing and
 * every question would look like a coverage gap.
 */
const JURISDICTION_CODES: Readonly<Record<string, string>> = {
  MALAYSIA: 'MY',
  SINGAPORE: 'SG',
  INDONESIA: 'ID',
  THAILAND: 'TH',
  'UNITED KINGDOM': 'GB',
  UK: 'GB',
  'UNITED STATES': 'US',
  USA: 'US',
  AUSTRALIA: 'AU',
  'HONG KONG': 'HK',
  INDIA: 'IN',
};

function normaliseJurisdiction(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper === '') return '';
  return JURISDICTION_CODES[upper] ?? (upper.length === 2 ? upper : upper);
}

/** Split a markdown module into chunks at `##` and `###` boundaries. */
export function parseModule(
  moduleId: string,
  markdown: string,
): { frontmatter: ModuleFrontmatter; chunks: ParsedChunk[] } {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const chunks: ParsedChunk[] = [];

  const lines = body.split(/\r?\n/);
  let currentH2 = '';
  let currentH3 = '';
  let buffer: string[] = [];

  const flush = (): void => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content.length < 40) return; // headings with no body

    const headingPath = [currentH2, currentH3].filter(Boolean);
    if (headingPath.length === 0) return;

    // Stable across edits: derived from identity, not from position.
    const locator = headingPath.join(' > ');
    const chunkId = `ck_${sha256(`${moduleId}|${locator}`).slice(0, 16)}`;

    chunks.push({
      chunk_id: chunkId,
      module_id: moduleId,
      source_id: moduleId,
      citation_locator: locator,
      heading_path: headingPath,
      content,
      content_hash: `sha256:${sha256(content)}`,
      token_estimate: estimateTokens(content),
      is_statutory_rate: STATUTORY_RATE_SIGNALS.test(content),
    });
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);

    if (h2) {
      flush();
      currentH2 = h2[1] as string;
      currentH3 = '';
      continue;
    }
    if (h3) {
      flush();
      currentH3 = h3[1] as string;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { frontmatter, chunks };
}

function splitFrontmatter(markdown: string): {
  frontmatter: ModuleFrontmatter;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };

  // The corpus uses both YAML list forms — inline `[a, b]` on some modules and
  // an indented block list on others — so both are handled rather than one
  // being declared canonical after the fact.
  const frontmatter: Record<string, unknown> = {};
  const lines = (match[1] as string).split(/\r?\n/);
  let blockListKey: string | null = null;

  for (const line of lines) {
    const blockItem = /^\s+-\s+(.*)$/.exec(line);
    if (blockItem && blockListKey !== null) {
      const value = (blockItem[1] as string).trim().replace(/^["']|["']$/g, '');
      if (value !== '') {
        frontmatter[blockListKey] = [...((frontmatter[blockListKey] as string[]) ?? []), value];
      }
      continue;
    }

    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;

    const key = kv[1] as string;
    const raw = (kv[2] as string).trim();
    blockListKey = null;

    if (raw.startsWith('[') && raw.endsWith(']')) {
      frontmatter[key] = raw
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (raw === '') {
      // A bare `key:` opens either a block list or a block scalar. Record the
      // key so the following `- item` lines attach to it.
      blockListKey = key;
    } else if (raw !== '>' && raw !== '|') {
      frontmatter[key] = raw.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter: frontmatter, body: match[2] as string };
}

export interface IngestOptions {
  readonly db: Database;
  readonly embeddings: EmbeddingProvider;
  readonly packId: string;
  readonly packVersion: string;
  readonly jurisdiction: string;
  readonly framework: string;
  readonly effectiveFrom: DateOnly;
  /** Client-entered at AS-REG-100. Absent means rates are treated as stale. */
  readonly verificationHorizonDays?: number;
  readonly batchSize?: number;
}

export interface IngestResult {
  readonly modules: number;
  readonly chunksInserted: number;
  readonly chunksSuperseded: number;
  readonly chunksUnchanged: number;
  readonly statutoryRateChunks: number;
}

/**
 * Ingest a directory of markdown modules into a pack version.
 *
 * Idempotent by content hash: re-running over unchanged text is a no-op, and
 * re-running over changed text supersedes rather than overwrites.
 */
export async function ingestDirectory(
  directory: string,
  options: IngestOptions,
): Promise<IngestResult> {
  const files = (await readdir(directory)).filter(
    (name) => name.endsWith('.md') && !name.startsWith('00-INDEX'),
  );

  let inserted = 0;
  let superseded = 0;
  let unchanged = 0;
  let rateChunks = 0;

  await withPlatformScope(options.db, async (sql) => {
    await sql`
      INSERT INTO packs (pack_id, pack_version, jurisdiction, reporting_framework,
                         status, effective_from, module_count)
      VALUES (${options.packId}, ${options.packVersion}, ${options.jurisdiction},
              ${options.framework}, 'draft', ${options.effectiveFrom}::date, ${files.length})
      ON CONFLICT (pack_id, pack_version) DO UPDATE SET module_count = EXCLUDED.module_count
    `;
  });

  for (const file of files) {
    const moduleId = basename(file, '.md');
    const markdown = await readFile(join(directory, file), 'utf8');
    const { frontmatter, chunks } = parseModule(moduleId, markdown);

    // A module tagged `global` carries no jurisdiction filter: an empty array
    // means "applies everywhere", which is what `retrieve_chunks` treats as a
    // wildcard. A module tagged only `global` must therefore end up empty, not
    // be dropped from retrieval entirely.
    const jurisdictions = asStringArray(frontmatter.jurisdictions)
      .map((j) => normaliseJurisdiction(j))
      .filter((j) => j !== '' && j !== 'GLOBAL');
    const frameworks = asStringArray(frontmatter.frameworks);
    const verifiedAt = frontmatter.last_verified ?? null;

    const batchSize = options.batchSize ?? 32;
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = chunks.slice(offset, offset + batchSize);
      const vectors = await options.embeddings.embed(batch.map((c) => c.content));

      await withPlatformScope(options.db, async (sql) => {
        for (const [index, chunk] of batch.entries()) {
          const existing = await sql<{ version: string; content_hash: string }[]>`
            SELECT version, content_hash FROM knowledge_chunks
             WHERE chunk_id = ${chunk.chunk_id} AND effective_to IS NULL
             ORDER BY effective_from DESC LIMIT 1
          `;

          const current = existing[0];
          if (current && current.content_hash === chunk.content_hash) {
            unchanged += 1;
            continue;
          }

          // Version history is retained: close the old range, open a new one.
          let version = '1.0.0';
          if (current) {
            await sql`
              UPDATE knowledge_chunks
                 SET effective_to = (${options.effectiveFrom}::date - 1)
               WHERE chunk_id = ${chunk.chunk_id} AND version = ${current.version}
            `;
            const [major = '1', minor = '0'] = current.version.split('.');
            version = `${major}.${Number(minor) + 1}.0`;
            superseded += 1;
          }

          if (chunk.is_statutory_rate) rateChunks += 1;

          await sql`
            INSERT INTO knowledge_chunks (
              chunk_id, tenant_id, pack_id, pack_version, module_id, source_id, version,
              citation_locator, heading_path, content, content_hash, token_count,
              effective_from, jurisdictions, frameworks, licence_class, clearance,
              supersedes_chunk_id, is_statutory_rate, verified_at, verification_horizon_days
            ) VALUES (
              ${chunk.chunk_id}, NULL, ${options.packId}, ${options.packVersion},
              ${chunk.module_id}, ${chunk.source_id}, ${version},
              ${chunk.citation_locator},
              ${chunk.heading_path},
              ${chunk.content}, ${chunk.content_hash}, ${chunk.token_estimate},
              ${options.effectiveFrom}::date,
              ${jurisdictions},
              ${frameworks},
              'internal', 'internal',
              ${current ? chunk.chunk_id : null},
              ${chunk.is_statutory_rate},
              ${chunk.is_statutory_rate ? verifiedAt : null}::date,
              ${chunk.is_statutory_rate ? (options.verificationHorizonDays ?? 365) : null}
            )
            ON CONFLICT (chunk_id, version) DO NOTHING
          `;

          const vector = vectors[index];
          if (vector) {
            await sql`
              INSERT INTO knowledge_embeddings (chunk_id, version, embedding_model, embedding)
              VALUES (${chunk.chunk_id}, ${version}, ${options.embeddings.model},
                      ${`[${vector.join(',')}]`}::vector)
              ON CONFLICT DO NOTHING
            `;
          }

          inserted += 1;
        }
      });
    }
  }

  await withPlatformScope(options.db, async (sql) => {
    await sql`
      UPDATE packs
         SET chunk_count = (
               SELECT count(*) FROM knowledge_chunks
                WHERE pack_id = ${options.packId} AND pack_version = ${options.packVersion}
             )
       WHERE pack_id = ${options.packId} AND pack_version = ${options.packVersion}
    `;
  });

  return {
    modules: files.length,
    chunksInserted: inserted,
    chunksSuperseded: superseded,
    chunksUnchanged: unchanged,
    statutoryRateChunks: rateChunks,
  };
}

/**
 * Publish a pack — architecture s.5.
 *
 * Publication supersedes the previous version rather than replacing it, so an
 * in-flight graph pinned to the old one keeps resolving (P0-8).
 */
export async function publishPack(
  db: Database,
  packId: string,
  packVersion: string,
  publishedBy: string,
  changeNote?: string,
): Promise<void> {
  await withPlatformScope(db, async (sql) => {
    await sql`
      UPDATE packs SET status = 'deprecated', effective_to = CURRENT_DATE
       WHERE pack_id = ${packId} AND pack_version <> ${packVersion} AND status = 'published'
    `;
    await sql`
      UPDATE packs
         SET status = 'published', published_at = now(), published_by = ${publishedBy},
             change_note = ${changeNote ?? null}
       WHERE pack_id = ${packId} AND pack_version = ${packVersion}
    `;
  });
}

/** Roll back to a prior version. Re-points resolution; deletes nothing. */
export async function rollbackPack(
  db: Database,
  packId: string,
  toVersion: string,
  reason: string,
): Promise<void> {
  await withPlatformScope(db, async (sql) => {
    await sql`
      UPDATE packs SET status = 'rolled_back', change_note = ${reason}
       WHERE pack_id = ${packId} AND status = 'published'
    `;
    await sql`
      UPDATE packs SET status = 'published', effective_to = NULL
       WHERE pack_id = ${packId} AND pack_version = ${toVersion}
    `;
  });
}
