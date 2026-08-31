import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider, createEmbeddingProvider } from './embeddings.js';
import { parseModule } from './ingest.js';

const MODULE = `---
id: pp-05
title: Tax Compliance and e-Invoicing
jurisdictions: [malaysia]
frameworks: [MFRS]
last_verified: 2026-08-01
---

## 5. Sales and Service Tax

Introductory text that is long enough to be retained as a chunk of its own,
describing the scope of the section and what it covers.

### 5.4 Output tax computation

The standard rate is 6 per cent applied to the taxable value of the supply.
Registered persons must account for output tax in the taxable period.

### 5.5 Exempt supplies

Certain supplies are exempt. The exemption is applied at the line level and
must be evidenced against the gazette order in force for the period.

## 6. e-Invoicing

Content for the e-invoicing section, describing the submission workflow and
the validation steps that precede it.
`;

describe('parseModule', () => {
  const { frontmatter, chunks } = parseModule('05-tax-compliance', MODULE);

  it('reads the frontmatter', () => {
    expect(frontmatter.jurisdictions).toEqual(['malaysia']);
    expect(frontmatter.frameworks).toEqual(['MFRS']);
    expect(frontmatter.last_verified).toBe('2026-08-01');
  });

  it('splits at heading boundaries', () => {
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const locators = chunks.map((c) => c.citation_locator);
    expect(locators).toContain('5. Sales and Service Tax > 5.4 Output tax computation');
    expect(locators).toContain('6. e-Invoicing');
  });

  it('derives chunk ids from identity, not position', () => {
    // Inserting a section earlier in the module must not renumber later ones,
    // or every citation in every historical evidence bundle would break.
    const withInsertion = MODULE.replace(
      '## 6. e-Invoicing',
      '### 5.6 Newly inserted section\n\nSome new content added later that is long enough to keep.\n\n## 6. e-Invoicing',
    );
    const after = parseModule('05-tax-compliance', withInsertion);

    const before = chunks.find((c) => c.citation_locator === '6. e-Invoicing');
    const afterChunk = after.chunks.find((c) => c.citation_locator === '6. e-Invoicing');
    expect(afterChunk?.chunk_id).toBe(before?.chunk_id);
  });

  it('changes the content hash when the text changes', () => {
    const edited = MODULE.replace('6 per cent', '8 per cent');
    const after = parseModule('05-tax-compliance', edited);

    const before = chunks.find((c) => c.citation_locator.includes('5.4'));
    const afterChunk = after.chunks.find((c) => c.citation_locator.includes('5.4'));

    // Same id — it is the same clause — but a different hash, which is what
    // opens a new version rather than overwriting the old one.
    expect(afterChunk?.chunk_id).toBe(before?.chunk_id);
    expect(afterChunk?.content_hash).not.toBe(before?.content_hash);
  });

  it('flags chunks that name a statutory rate', () => {
    const rateChunk = chunks.find((c) => c.citation_locator.includes('5.4'));
    expect(rateChunk?.is_statutory_rate).toBe(true);

    const prose = chunks.find((c) => c.citation_locator === '6. e-Invoicing');
    expect(prose?.is_statutory_rate).toBe(false);
  });

  it('drops headings with no substantive body', () => {
    const thin = parseModule('x', '## A heading\n\n## Another heading\n\nreal content here');
    expect(thin.chunks.every((c) => c.content.length >= 40)).toBe(true);
  });

  it('handles a module with no frontmatter', () => {
    const result = parseModule('x', '## Section\n\nSome content long enough to be a chunk here.');
    expect(result.frontmatter).toEqual({});
    expect(result.chunks).toHaveLength(1);
  });
});

describe('DeterministicEmbeddingProvider', () => {
  const provider = new DeterministicEmbeddingProvider(128);

  it('produces unit vectors of the declared width', async () => {
    const [vector] = await provider.embed(['the standard rate is six per cent']);
    expect(vector).toHaveLength(128);
    const norm = Math.sqrt((vector as number[]).reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('is deterministic across calls — a retrieval test measures retrieval, not drift', async () => {
    const [a] = await provider.embed(['output tax computation']);
    const [b] = await provider.embed(['output tax computation']);
    expect(a).toEqual(b);
  });

  it('places lexically similar text closer than unrelated text', async () => {
    const [query, near, far] = await provider.embed([
      'output tax computation for the taxable period',
      'computation of output tax in the taxable period',
      'fixed asset depreciation schedule and useful life',
    ]);

    const cosine = (x: number[], y: number[]): number =>
      x.reduce((acc, v, i) => acc + v * (y[i] as number), 0);

    expect(cosine(query as number[], near as number[])).toBeGreaterThan(
      cosine(query as number[], far as number[]),
    );
  });

  it('returns a valid vector for empty text', async () => {
    const [vector] = await provider.embed(['']);
    const norm = Math.sqrt((vector as number[]).reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe('createEmbeddingProvider', () => {
  it('refuses the deterministic provider in prod', () => {
    expect(() => createEmbeddingProvider({ deployEnvironment: 'prod' })).toThrow(/refused in prod/);
  });

  it('supplies the deterministic provider in dev and test', () => {
    expect(createEmbeddingProvider({ deployEnvironment: 'dev' }).model).toBe(
      'deterministic-hash-v1',
    );
  });

  it('prefers a hosted provider when one is configured', () => {
    const hosted = { model: 'voyage-3', dimensions: 1024, embed: () => Promise.resolve([]) };
    expect(createEmbeddingProvider({ deployEnvironment: 'prod', hosted }).model).toBe('voyage-3');
  });
});
