/**
 * Stub connectors for `dev` and `test` — DWD-06 s.14.3.
 *
 *   "dev: synthetic only; connectors: stubs implementing the capability schemas."
 *
 * These are graduation stage 1 (file 05 s.11.2). They implement the same
 * capability schemas as a live connector, so the orchestration above them is
 * exercised for real — the only thing that is synthetic is the system of record.
 *
 * Every write here is deliberately *observable*: the stub records what it was
 * asked to do, so a test can assert that a dry-run reached the connector and
 * produced no effect, which is a different thing from never being called.
 */
import { asText, firstText, money, sha256 } from '@eiaaw/core';
import type { Connector, ConnectorInvocation, ConnectorResult } from '../invoker.js';

export interface StubLedgerEntry {
  readonly tool_id: string;
  readonly business_key: string;
  readonly dry_run: boolean;
  readonly idempotency_key: string | undefined;
  readonly args: Record<string, unknown>;
  readonly provider_reference: string;
  readonly at: string;
}

/**
 * A synthetic ERP.
 *
 * Holds a small in-memory ledger so reads return something coherent and writes
 * are visible to assertions. Nothing persists across a process restart, which
 * is correct: `dev` data is synthetic by construction.
 */
export class StubErpConnector implements Connector {
  readonly id = 'stub-erp';
  readonly version = '1.0.0';
  readonly tools = [
    'TL-ERPR-01',
    'TL-ERPR-02',
    'TL-ERPR-03',
    'TL-ERPR-04',
    'TL-ERPR-05',
    'TL-ERPR-06',
    'TL-ERPR-07',
    'TL-ERPW-01',
    'TL-ERPW-02',
    'TL-ERPW-03',
    'TL-ERPW-04',
    'TL-ERPW-05',
    'TL-ERPW-06',
    'TL-ERPW-07',
    'TL-ERPW-08',
    'TL-ERPW-09',
    'TL-ERPW-10',
    'TL-ERPW-11',
    'TL-ERPW-12',
    'TL-ERPW-13',
    'TL-ERPW-14',
  ];

  /** Everything the stub was asked to do, in order. Assertions read this. */
  readonly ledger: StubLedgerEntry[] = [];

  #balances = new Map<string, number>([
    ['1000', 1_250_00],
    ['2000', -840_50],
    ['4000', -3_400_00],
    ['5000', 2_990_50],
  ]);

  // eslint-disable-next-line @typescript-eslint/require-await
  async invoke(input: ConnectorInvocation): Promise<ConnectorResult> {
    if (input.tool_id.startsWith('TL-ERPR-')) return this.#read(input);
    return this.#write(input);
  }

  #read(input: ConnectorInvocation): ConnectorResult {
    const entity = asText(input.scope_qualifiers['entity_id'], 'ENT-0000');
    const period = asText(input.scope_qualifiers['period'], '2026-07');

    switch (input.tool_id) {
      case 'TL-ERPR-01':
        return {
          output: {
            entity_id: entity,
            period,
            balances: [...this.#balances.entries()].map(([account, amount]) => ({
              account,
              balance: money(amount, 'MYR'),
            })),
            // The provenance the L1 minimum schema needs.
            extracted_at: new Date().toISOString(),
            connector_version: this.version,
          },
        };

      case 'TL-ERPR-02':
        return {
          output: {
            entity_id: entity,
            period,
            lines: [
              {
                document: 'INV-7741',
                supplier: 'SUP-0042',
                net: money(1_000_00, 'MYR'),
                tax: money(60_00, 'MYR'),
                gross: money(1_060_00, 'MYR'),
                po: 'PO-3310',
                gr: 'GR-8821',
              },
              {
                document: 'INV-7742',
                supplier: 'SUP-0042',
                net: money(2_400_00, 'MYR'),
                tax: money(144_00, 'MYR'),
                gross: money(2_544_00, 'MYR'),
                po: 'PO-3311',
                gr: 'GR-8822',
              },
            ],
            extracted_at: new Date().toISOString(),
            connector_version: this.version,
          },
        };

      case 'TL-ERPR-03':
        return {
          output: {
            entity_id: entity,
            records: [
              {
                id: 'SUP-0042',
                name: 'Synthetic Supplier Sdn Bhd',
                payment_terms: 'NET30',
                // Masked at the source: D15 is never rendered in full, so the
                // stub does not produce a value that would have to be masked
                // downstream.
                bank_account_masked: '****4417',
              },
            ],
            extracted_at: new Date().toISOString(),
            connector_version: this.version,
          },
        };

      default:
        return {
          output: {
            entity_id: entity,
            period,
            note: `synthetic response for ${input.tool_id}`,
            rows: [],
            extracted_at: new Date().toISOString(),
            connector_version: this.version,
          },
        };
    }
  }

  #write(input: ConnectorInvocation): ConnectorResult {
    const businessKey = firstText([input.args['business_key'], input.args['document']], 'UNKNOWN');
    // Derived from the idempotency key so a replay would produce the same
    // reference — which is what makes the ledger assertion meaningful.
    const providerReference = `ERP-${sha256(input.idempotency_key ?? businessKey)
      .slice(0, 10)
      .toUpperCase()}`;

    this.ledger.push({
      tool_id: input.tool_id,
      business_key: businessKey,
      dry_run: input.dry_run,
      idempotency_key: input.idempotency_key,
      args: input.args,
      provider_reference: providerReference,
      at: new Date().toISOString(),
    });

    if (input.dry_run) {
      // A dry-run validates and reports; it never mutates. The distinction is
      // visible in the ledger, so a test can prove the call happened AND that
      // it had no effect.
      return {
        output: {
          dry_run: true,
          would_post: { tool_id: input.tool_id, business_key: businessKey, args: input.args },
          validation: { ok: true, findings: [] },
        },
        business_key: businessKey,
        cost: money(0, 'MYR'),
      };
    }

    if (input.tool_id === 'TL-ERPW-02' || input.tool_id === 'TL-ERPW-03') {
      const lines =
        (input.args['lines'] as { account: string; amount: number }[] | undefined) ?? [];
      for (const line of lines) {
        this.#balances.set(line.account, (this.#balances.get(line.account) ?? 0) + line.amount);
      }
    }

    return {
      output: { posted: true, document: providerReference, business_key: businessKey },
      provider_reference: providerReference,
      business_key: businessKey,
      rate_limit_remaining: 500,
      cost: money(3, 'MYR'),
    };
  }

  /** Live writes only — a dry-run is not an effect. */
  effectsApplied(): StubLedgerEntry[] {
    return this.ledger.filter((entry) => !entry.dry_run);
  }

  reset(): void {
    this.ledger.length = 0;
  }
}

/** A synthetic document store and OCR pair. */
export class StubDocumentConnector implements Connector {
  readonly id = 'stub-docs';
  readonly version = '1.0.0';
  readonly tools = [
    'TL-DOCS-01',
    'TL-DOCS-02',
    'TL-DOCS-03',
    'TL-DOCS-05',
    'TL-DOCS-06',
    'TL-OCR-01',
    'TL-OCR-02',
    'TL-OCR-03',
  ];

  readonly stored = new Map<string, unknown>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async invoke(input: ConnectorInvocation): Promise<ConnectorResult> {
    if (input.tool_id.startsWith('TL-OCR-')) {
      return {
        output: {
          // Extraction output is untrusted content, and is labelled as such so
          // the skill runtime places it in segment 5.
          trust_class: 'untrusted_content',
          document_type: 'supplier_invoice',
          fields: {
            supplier_name: 'Synthetic Supplier Sdn Bhd',
            invoice_number: 'INV-7741',
            invoice_date: '2026-07-15',
            net: money(1_000_00, 'MYR'),
            tax: money(60_00, 'MYR'),
            gross: money(1_060_00, 'MYR'),
          },
          confidence: '0.94',
        },
      };
    }

    if (input.tool_id === 'TL-DOCS-01') {
      const ref = String(input.args['storage_ref']);
      return { output: this.stored.get(ref) ?? { not_found: true, storage_ref: ref } };
    }

    const ref = `obj://stub/${sha256(JSON.stringify(input.args)).slice(0, 16)}`;
    if (!input.dry_run) this.stored.set(ref, input.args);

    return {
      output: { dry_run: input.dry_run, storage_ref: ref },
      provider_reference: ref,
      cost: money(1, 'MYR'),
    };
  }
}

/** Every stub, for the dev and test wiring. */
export const stubConnectors = (): Connector[] => [
  new StubErpConnector(),
  new StubDocumentConnector(),
];
