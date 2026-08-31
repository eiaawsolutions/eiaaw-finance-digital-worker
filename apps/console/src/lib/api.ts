/**
 * The API client.
 *
 * Server-side only: every call runs in a React Server Component or a server
 * action, so the session credential never reaches the browser. The console has
 * no client-side fetch to the API at all.
 */
const API_URL = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';

export interface Session {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly admin: boolean;
}

/**
 * The development session.
 *
 * In production this is established by OIDC and read from a signed cookie. The
 * header form below only works because the API refuses it when
 * DEPLOY_ENVIRONMENT is prod.
 */
export function currentSession(): Session {
  return {
    tenant_id: process.env['CONSOLE_TENANT_ID'] ?? 'tnt_acme-demo',
    principal_id: process.env['CONSOLE_PRINCIPAL_ID'] ?? 'usr_console',
    admin: process.env['CONSOLE_ADMIN'] !== 'false',
  };
}

/**
 * Reads one string field out of an untrusted payload.
 *
 * The API always sends RFC 7807 strings here, but an intermediary that
 * rewrites an error body does not, and `String(someObject)` would put
 * "[object Object]" in front of a reviewer as if it were the refusal reason.
 * Anything that is not already a string falls back to the caller's text.
 */
function stringField(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : fallback;
}

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly data: T | null;
  /** The RFC 7807 detail, surfaced verbatim — it is written to be read. */
  readonly problem: {
    title: string;
    detail: string;
    error_code: string;
    status: number;
  } | null;
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const session = currentSession();

  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        'x-tenant-id': session.tenant_id,
        'x-principal-id': session.principal_id,
        ...(session.admin ? { 'x-admin': 'true' } : {}),
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ok: false,
        data: null,
        problem: {
          title: stringField(problem, 'title', 'Request failed'),
          // The API's refusals are written to be shown to a person: they name
          // what is missing, why it is needed and who owns it. Paraphrasing
          // them here would lose exactly that.
          detail: stringField(problem, 'detail', `The API returned ${response.status}.`),
          error_code: stringField(problem, 'error_code', 'unknown'),
          status: response.status,
        },
      };
    }

    return { ok: true, data: (await response.json()) as T, problem: null };
  } catch {
    return {
      ok: false,
      data: null,
      problem: {
        title: 'The API is unreachable',
        detail:
          `Could not reach ${API_URL}. The console shows nothing rather than showing ` +
          'stale or invented data.',
        error_code: 'dependency_unavailable',
        status: 503,
      },
    };
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const session = currentSession();

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': session.tenant_id,
        'x-principal-id': session.principal_id,
        ...(session.admin ? { 'x-admin': 'true' } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      return {
        ok: false,
        data: null,
        problem: {
          title: stringField(payload, 'title', 'Request failed'),
          detail: stringField(payload, 'detail', `The API returned ${response.status}.`),
          error_code: stringField(payload, 'error_code', 'unknown'),
          status: response.status,
        },
      };
    }

    return { ok: true, data: payload as T, problem: null };
  } catch {
    return {
      ok: false,
      data: null,
      problem: {
        title: 'The API is unreachable',
        detail: `Could not reach ${API_URL}.`,
        error_code: 'dependency_unavailable',
        status: 503,
      },
    };
  }
}

// --- shapes the console reads -------------------------------------------

export interface Health {
  status: string;
  platform_version: string;
  environment: string;
  residency_zone: string;
  force_dry_run: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface FamilyHealth {
  family: string;
  field_count: number;
  populated_count: number;
  blank_mandatory_count: number;
  tbc_count: number;
  requires_reverification_count: number;
  complete: boolean;
}

export interface SettingsHealth {
  tenant_id: string;
  families: FamilyHealth[];
  snapshot_version: number | null;
  snapshot_age_seconds: number | null;
  stale: boolean;
  ready_for_execution: boolean;
}

export interface HandoffRow {
  handoff_id: string;
  graph_id: string;
  bundle_id: string;
  bundle_version: number;
  question: string;
  decision_type: string;
  assignee_principal_id: string;
  assignee_role_ref: string;
  dual_control_required: boolean;
  permitted_moves: string[];
  sla_due_at: string;
  state: string;
  issued_at: string;
  breached: boolean;
}

export interface OutputClassRow {
  output_class: string;
  label: string;
  reserved_act: boolean;
  worker_maximum_contribution: string;
  accountable_role_ref: string;
  gate_behaviour: string;
  autonomy_ceiling: string;
  immutable_rule_ref?: number;
  notes?: string;
}

export interface ToolRow {
  tool_id: string;
  name: string;
  class: string;
  permission_scope: string;
  state_changing: boolean;
  irreversible: boolean;
  compensation_tool_id: string | null;
}

export interface AuditEventRow {
  event_id: string;
  occurred_at: string;
  layer: string;
  component: string;
  event_type: string;
  outcome: string;
  subject: { kind: string; id: string };
  graph_id: string | null;
  event_hash: string;
}

export interface ChainVerification {
  ok: boolean;
  verified: number;
  from: number;
  to: number;
  brokenAt?: { index: number; event_id: string; reason: string };
}
