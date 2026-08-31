/**
 * JSON Schema 2020-12 definitions for the sixteen canonical contracts.
 *
 * DWD-06 names JSON Schema 2020-12 as the contract-definition dialect, so these
 * are the normative artefacts — the TypeScript types in `types.ts` are the
 * compile-time mirror, and `contracts.test.ts` asserts the two stay in step.
 *
 * `additionalProperties: false` everywhere. DWD-06 s.0 red flag: "A contract
 * extended informally by adding fields at a call site." Rejecting unknown keys
 * is how that stops being possible rather than merely discouraged.
 *
 * Note on MINOR evolution: s.2.3 says consumers ignore unknown fields within
 * the same MAJOR. That is handled by `stripUnknown` in the validator, which
 * removes unknown keys on *ingress from an older peer* before validation —
 * strictness at the boundary, tolerance on the wire.
 */
import {
  ACTOR_KINDS,
  ADMISSION_CHECKS,
  ADMISSION_DECISIONS,
  ASSURANCE_GATES,
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  AUTHOR_KINDS,
  AUTHORISATION_VERDICTS,
  AUTONOMY_LEVELS,
  CHANNELS,
  COMPONENTS,
  CONFIDENCE_BANDS,
  CONTEXT_AXES,
  CONVERSATION_STATES,
  CORRECTNESS_LABELS,
  COVERAGE_TIERS,
  DECISION_TYPES,
  DELIVERY_STATUSES,
  EXTRACTION_STATUSES,
  FEEDBACK_HOOK_KINDS,
  FEEDBACK_SIGNALS,
  FEEDBACK_SOURCES,
  FISCAL_PERIOD_STATUSES,
  GATE_RESULTS,
  GRAPH_STATES,
  HANDOFF_STATES,
  IMMUTABLE_RULES,
  INVOCATION_STATUSES,
  LAYERS,
  MESSAGE_DIRECTIONS,
  NODE_KINDS,
  NODE_OWNER_KINDS,
  NODE_STATES,
  OUTPUT_CLASSES,
  POLICY_VERDICTS,
  PRINCIPAL_RESOLUTIONS,
  QUALITY_CRITERION_RESULTS,
  REDACTION_STATES,
  REJECTION_REASON_CODES,
  RESOLUTION_STATUSES,
  REVIEWER_MOVES,
  SCAN_VERDICTS,
  SENSITIVITY_TIERS,
  SKILL_MODES,
  TOOL_OUTCOMES,
  TRIGGER_CLASSES,
  TRUST_CLASSES,
} from './enums.js';

export type JsonSchema = Record<string, unknown>;

const BASE_URI = 'https://contracts.eiaaw.dev/finance-digital-worker';
export const COMMON_SCHEMA_ID = `${BASE_URI}/common.schema.json`;
export const schemaId = (name: string): string => `${BASE_URI}/${name}.schema.json`;

const ref = (name: string): JsonSchema => ({ $ref: `${COMMON_SCHEMA_ID}#/$defs/${name}` });
const enumOf = (values: readonly (string | number)[]): JsonSchema => ({ enum: [...values] });

/**
 * Shared definitions. Keeping money, timestamps, hashes and lineage in one
 * place is what makes "money is integers everywhere, with no exception"
 * checkable rather than aspirational.
 */
export const commonSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: COMMON_SCHEMA_ID,
  title: 'Shared contract definitions',
  $defs: {
    schemaVersion: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
      description: 'Semver. Consumers reject an unknown MAJOR (DWD-06 s.2.3).',
    },
    uuid: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    },
    prefixedId: { type: 'string', pattern: '^[a-z]{2,4}_[0-9a-f-]{36}$' },
    tenantId: { type: 'string', pattern: '^tnt_[a-z0-9][a-z0-9_-]{1,62}$' },
    traceId: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    spanId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
    idempotencyKey: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      description: '64 lowercase hex (SHA-256), derived at compile time (DWD-06 s.8.1).',
    },
    timestamp: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$',
      description: 'RFC 3339 with an explicit offset (DWD-06 s.2.2).',
    },
    dateOnly: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    period: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    locale: { type: 'string', pattern: '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$' },
    prefixedHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    storageRef: { type: 'string', pattern: '^(obj|worm)://.+' },
    settingRef: { type: 'string', pattern: '^AS-[A-Z]{3}-([A-Z]+-)?([0-9]{3}|\\*)$' },
    decimalString: {
      type: 'string',
      pattern: '^-?\\d+(\\.\\d+)?$',
      description: 'Explicit precision. Never a float (DWD-06 s.2.2).',
    },
    money: {
      type: 'object',
      additionalProperties: false,
      required: ['amount_minor', 'currency', 'scale'],
      properties: {
        amount_minor: { type: 'integer' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        scale: { type: 'integer', minimum: 0, maximum: 6 },
      },
      description: 'Integer minor units. The arithmetic gate cannot certify a float.',
    },
    failure: {
      type: 'object',
      additionalProperties: false,
      required: ['class', 'code', 'message', 'retryable'],
      properties: {
        class: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
      },
    },
    knowledgeUsed: {
      type: 'object',
      additionalProperties: false,
      required: [
        'module_id',
        'chunk_id',
        'version',
        'effective_from',
        'effective_to',
        'citation_locator',
        'licence_class',
      ],
      properties: {
        module_id: { type: 'string' },
        chunk_id: { type: 'string' },
        version: { type: 'string' },
        effective_from: ref('dateOnly'),
        effective_to: { oneOf: [ref('dateOnly'), { type: 'null' }] },
        citation_locator: { type: 'string' },
        licence_class: { type: 'string' },
      },
      description: 'The L2 knowledge chunk minimum schema. The grounding gate reads this.',
    },
    recordUsed: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source_system_id',
        'record_type',
        'entity_id',
        'period',
        'content_hash',
        'connector_version',
        'extracted_at',
      ],
      properties: {
        source_system_id: { type: 'string' },
        record_type: { type: 'string' },
        entity_id: { type: 'string' },
        period: { type: 'string' },
        content_hash: ref('prefixedHash'),
        connector_version: { type: 'string' },
        extracted_at: ref('timestamp'),
      },
      description: 'The L1 record minimum schema, including lineage.',
    },
    citation: {
      type: 'object',
      additionalProperties: false,
      required: ['claim_ref', 'chunk_id', 'version', 'effective_from'],
      properties: {
        claim_ref: { type: 'string' },
        chunk_id: { type: 'string' },
        version: { type: 'string' },
        effective_from: ref('dateOnly'),
        locator: { type: 'string' },
      },
    },
    namedPrincipal: {
      type: 'object',
      additionalProperties: false,
      required: ['principal_id', 'role_ref', 'source'],
      properties: {
        principal_id: { type: 'string' },
        role_ref: { type: 'string' },
        source: ref('settingRef'),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 3.1 InboundRequest
// ---------------------------------------------------------------------------
export const inboundRequestSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('InboundRequest'),
  title: 'InboundRequest',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'request_id',
    'tenant_id',
    'trace_id',
    'channel',
    'transport_message_id',
    'conversation_key',
    'received_at',
    'principal',
    'body_text',
    'body_raw_ref',
    'security_flags',
    'admission',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    request_id: ref('uuid'),
    tenant_id: ref('tenantId'),
    trace_id: ref('traceId'),
    channel: enumOf(CHANNELS),
    transport_message_id: { type: 'string', minLength: 1 },
    conversation_key: { type: 'string', minLength: 1 },
    received_at: ref('timestamp'),
    transport_sent_at: ref('timestamp'),
    principal: {
      type: 'object',
      additionalProperties: false,
      required: ['resolution', 'confidence'],
      properties: {
        principal_id: { type: 'string' },
        resolution: enumOf(PRINCIPAL_RESOLUTIONS),
        confidence: enumOf(CONFIDENCE_BANDS),
        binding_id: { type: 'string' },
        claimed_identity: { type: 'string' },
      },
      // "principal_id is required when resolution is bound" (DWD-06 s.3.1).
      allOf: [
        {
          if: { properties: { resolution: { const: 'bound' } }, required: ['resolution'] },
          then: { required: ['principal_id'] },
        },
      ],
    },
    body_text: { type: 'string' },
    body_raw_ref: ref('storageRef'),
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'attachment_id',
          'filename',
          'media_type',
          'size_bytes',
          'content_hash',
          'storage_ref',
          'scan_verdict',
          'extraction_status',
        ],
        properties: {
          attachment_id: { type: 'string' },
          filename: { type: 'string' },
          media_type: { type: 'string' },
          size_bytes: { type: 'integer', minimum: 0 },
          content_hash: ref('prefixedHash'),
          storage_ref: ref('storageRef'),
          scan_verdict: enumOf(SCAN_VERDICTS),
          extraction_status: enumOf(EXTRACTION_STATUSES),
        },
      },
    },
    intent_hint: {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'value'],
      properties: { source: { type: 'string' }, value: { type: 'string' } },
    },
    reply_context: {
      type: 'object',
      additionalProperties: false,
      properties: {
        in_reply_to: { type: 'string' },
        references: { type: 'array', items: { type: 'string' } },
      },
    },
    locale_hint: ref('locale'),
    security_flags: {
      type: 'object',
      additionalProperties: false,
      required: ['sender_external', 'allow_list', 'loop_indicator', 'replay_suspected'],
      properties: {
        dmarc: enumOf(['pass', 'fail', 'none', 'not_applicable']),
        spf: enumOf(['pass', 'fail', 'none', 'not_applicable']),
        dkim: enumOf(['pass', 'fail', 'none', 'not_applicable']),
        sender_external: { type: 'boolean' },
        allow_list: enumOf(['member', 'non_member', 'not_applicable']),
        loop_indicator: { type: 'boolean' },
        replay_suspected: { type: 'boolean' },
      },
    },
    admission: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'reason_code'],
      properties: {
        decision: enumOf(ADMISSION_DECISIONS),
        reason_code: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      allOf: [
        {
          if: { properties: { decision: { const: 'rejected' } }, required: ['decision'] },
          then: { properties: { reason_code: { type: 'string', minLength: 1 } } },
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// 3.2 ResolvedContext
// ---------------------------------------------------------------------------
const axisSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'source', 'coverage_tier'],
  properties: {
    value: { type: 'string', minLength: 1 },
    source: { type: 'string' },
    coverage_tier: enumOf(COVERAGE_TIERS),
  },
};

export const resolvedContextSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('ResolvedContext'),
  title: 'ResolvedContext',
  description:
    'Implements the L0 minimum artefact schema in full. A build may extend it; ' +
    'it may never omit a field.',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'context_id',
    'request_id',
    'tenant_id',
    'resolution_status',
    'resolution_reason',
    'axes',
    'pack',
    'residency_zone',
    'resolved_locale',
    'knowledge_pin',
    'resolved_at',
    'expires_at',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    context_id: ref('prefixedId'),
    request_id: ref('uuid'),
    tenant_id: ref('tenantId'),
    resolution_status: enumOf(RESOLUTION_STATUSES),
    resolution_reason: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    axes: {
      type: 'object',
      additionalProperties: false,
      required: [...CONTEXT_AXES],
      properties: Object.fromEntries(CONTEXT_AXES.map((axis) => [axis, axisSchema])),
    },
    pack: {
      type: 'object',
      additionalProperties: false,
      required: ['pack_id', 'pack_version'],
      properties: { pack_id: { type: 'string' }, pack_version: { type: 'string' } },
    },
    residency_zone: { type: 'string', minLength: 1 },
    resolved_locale: ref('locale'),
    fiscal_period: {
      type: 'object',
      additionalProperties: false,
      required: ['period_id', 'start_date', 'end_date', 'status'],
      properties: {
        period_id: { type: 'string' },
        start_date: ref('dateOnly'),
        end_date: ref('dateOnly'),
        status: enumOf(FISCAL_PERIOD_STATUSES),
      },
    },
    knowledge_pin: {
      type: 'object',
      additionalProperties: false,
      required: ['pinned_at', 'modules'],
      properties: {
        pinned_at: ref('timestamp'),
        modules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['module_id', 'version', 'effective_from', 'effective_to'],
            properties: {
              module_id: { type: 'string' },
              version: { type: 'string' },
              effective_from: ref('dateOnly'),
              effective_to: { oneOf: [ref('dateOnly'), { type: 'null' }] },
            },
          },
        },
      },
    },
    resolved_at: ref('timestamp'),
    expires_at: ref('timestamp'),
  },
  allOf: [
    {
      // s.3.2: reason is required when status is partial or refused.
      if: {
        properties: { resolution_status: { enum: ['partial', 'refused'] } },
        required: ['resolution_status'],
      },
      then: { properties: { resolution_reason: { type: 'string', minLength: 1 } } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.3 Conversation
// ---------------------------------------------------------------------------
export const conversationSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('Conversation'),
  title: 'Conversation',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'conversation_key',
    'tenant_id',
    'principal_id',
    'channels_seen',
    'primary_channel',
    'state',
    'opened_at',
    'last_activity_at',
    'closes_at',
    'sensitivity_ceiling',
    'handoff_open',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    conversation_key: { type: 'string', minLength: 1 },
    tenant_id: ref('tenantId'),
    principal_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    channels_seen: { type: 'array', minItems: 1, items: enumOf(CHANNELS) },
    primary_channel: enumOf(CHANNELS),
    state: enumOf(CONVERSATION_STATES),
    opened_at: ref('timestamp'),
    last_activity_at: ref('timestamp'),
    closes_at: ref('timestamp'),
    context_ref: { type: 'string' },
    working_memory_ref: { type: 'string' },
    preference_snapshot: { type: 'object', additionalProperties: { type: 'string' } },
    sensitivity_ceiling: enumOf(SENSITIVITY_TIERS),
    handoff_open: { type: 'boolean' },
  },
};

// ---------------------------------------------------------------------------
// 3.4 Message
// ---------------------------------------------------------------------------
export const messageSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('Message'),
  title: 'Message',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'message_id',
    'conversation_key',
    'tenant_id',
    'direction',
    'channel',
    'transport_message_id',
    'author',
    'sent_at',
    'content_text',
    'trust_class',
    'related_request_id',
    'related_delivery_id',
    'redaction_state',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    message_id: ref('prefixedId'),
    conversation_key: { type: 'string' },
    tenant_id: ref('tenantId'),
    direction: enumOf(MESSAGE_DIRECTIONS),
    channel: enumOf(CHANNELS),
    transport_message_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    author: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'principal_id'],
      properties: {
        kind: enumOf(AUTHOR_KINDS),
        principal_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    sent_at: ref('timestamp'),
    content_text: { type: 'string' },
    content_blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: enumOf(['text', 'citation', 'table', 'code', 'divider', 'action', 'diff']),
          text: { type: 'string' },
          data: { type: 'object' },
        },
      },
    },
    attachment_ids: { type: 'array', items: { type: 'string' } },
    trust_class: enumOf(TRUST_CLASSES),
    related_request_id: { oneOf: [ref('uuid'), { type: 'null' }] },
    related_delivery_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    redaction_state: enumOf(REDACTION_STATES),
  },
  allOf: [
    {
      // DWD-06 s.3.4: "Inbound is always untrusted."
      // Modelled here so an inbound message can never claim instruction status.
      if: { properties: { direction: { const: 'inbound' } }, required: ['direction'] },
      then: { properties: { trust_class: { const: 'untrusted_content' } } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.5 TaskGraph
// ---------------------------------------------------------------------------
export const taskGraphSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('TaskGraph'),
  title: 'TaskGraph',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'graph_id',
    'tenant_id',
    'request_id',
    'context_ref',
    'trigger_class',
    'intent',
    'root_skill_id',
    'skill_version',
    'effective_autonomy',
    'autonomy_basis',
    'nodes',
    'edges',
    'sequence_ranks',
    'admission',
    'budget',
    'state',
    'created_at',
    'completed_at',
    'workflow_run_id',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    graph_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    request_id: ref('uuid'),
    context_ref: ref('prefixedId'),
    trigger_class: enumOf(TRIGGER_CLASSES),
    intent: { type: 'string', minLength: 1 },
    root_skill_id: { type: 'string', pattern: '^SK-[A-Z0-9]+-[0-9]{2}$' },
    skill_version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    effective_autonomy: enumOf(AUTONOMY_LEVELS),
    autonomy_basis: {
      type: 'object',
      additionalProperties: false,
      required: ['platform_ceiling', 'as_scp_grant', 'supervisor_ref', 'supervisor_active'],
      properties: {
        platform_ceiling: enumOf(AUTONOMY_LEVELS),
        as_scp_grant: enumOf(AUTONOMY_LEVELS),
        supervisor_ref: { oneOf: [ref('settingRef'), { type: 'null' }] },
        supervisor_active: { type: 'boolean' },
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id'],
        properties: { node_id: { type: 'string' } },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'kind'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: enumOf(['sequence', 'data', 'compensation']),
        },
      },
    },
    sequence_ranks: { type: 'object', additionalProperties: { type: 'integer' } },
    admission: {
      type: 'object',
      additionalProperties: false,
      required: ['checks_passed', 'decision'],
      properties: {
        checks_passed: { type: 'array', items: enumOf(ADMISSION_CHECKS), uniqueItems: true },
        decision: enumOf(ADMISSION_DECISIONS),
        failed_check: enumOf(ADMISSION_CHECKS),
        reason: { type: 'string' },
      },
      allOf: [
        {
          // "A graph is never admitted 'with a warning'" — admission requires
          // every check, not a subset.
          if: { properties: { decision: { const: 'admitted' } }, required: ['decision'] },
          then: {
            properties: {
              checks_passed: { type: 'array', minItems: ADMISSION_CHECKS.length },
            },
          },
        },
        {
          if: { properties: { decision: { const: 'rejected' } }, required: ['decision'] },
          then: { required: ['failed_check', 'reason'] },
        },
      ],
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['token_ceiling', 'cost_ceiling', 'source'],
      properties: {
        token_ceiling: { type: 'integer', minimum: 0 },
        cost_ceiling: ref('money'),
        source: ref('settingRef'),
      },
    },
    state: enumOf(GRAPH_STATES),
    created_at: ref('timestamp'),
    completed_at: { oneOf: [ref('timestamp'), { type: 'null' }] },
    workflow_run_id: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// 3.6 TaskNode
// ---------------------------------------------------------------------------
export const taskNodeSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('TaskNode'),
  title: 'TaskNode',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'node_id',
    'graph_id',
    'kind',
    'label',
    'owner',
    'depends_on',
    'sequence_rank',
    'state',
    'state_changing',
    'irreversible',
    'dry_run',
    'attempt',
    'max_attempts',
    'started_at',
    'ended_at',
    'failure',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    node_id: { type: 'string', minLength: 1 },
    graph_id: ref('prefixedId'),
    kind: enumOf(NODE_KINDS),
    label: { type: 'string' },
    owner: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'ref'],
      properties: { kind: enumOf(NODE_OWNER_KINDS), ref: { type: 'string', minLength: 1 } },
    },
    sop_step_ref: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    sequence_rank: { type: 'integer' },
    state: enumOf(NODE_STATES),
    state_changing: { type: 'boolean' },
    irreversible: { type: 'boolean' },
    idempotency_key: ref('idempotencyKey'),
    compensation: {
      type: 'object',
      additionalProperties: false,
      required: ['tool_id', 'invoked', 'compensation_key'],
      properties: {
        tool_id: { type: 'string' },
        invoked: { type: 'boolean' },
        compensation_key: { oneOf: [ref('idempotencyKey'), { type: 'null' }] },
      },
    },
    dry_run: { type: 'boolean' },
    attempt: { type: 'integer', minimum: 0 },
    max_attempts: { type: 'integer', minimum: 1 },
    started_at: { oneOf: [ref('timestamp'), { type: 'null' }] },
    ended_at: { oneOf: [ref('timestamp'), { type: 'null' }] },
    confidence: ref('decimalString'),
    cost: ref('money'),
    failure: { oneOf: [ref('failure'), { type: 'null' }] },
  },
  allOf: [
    {
      // s.3.6: idempotency_key is required when state_changing is true.
      if: { properties: { state_changing: { const: true } }, required: ['state_changing'] },
      then: { required: ['idempotency_key'] },
    },
    {
      // s.3.6: compensation is required when state-changing and reversible.
      // A skill whose state change has no compensation sets irreversible: true
      // (file 05 s.2.2), which forces dual control and last-position sequencing.
      if: {
        properties: { state_changing: { const: true }, irreversible: { const: false } },
        required: ['state_changing', 'irreversible'],
      },
      then: { required: ['compensation'] },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.7 PolicyVerdict
// ---------------------------------------------------------------------------
export const policyVerdictSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('PolicyVerdict'),
  title: 'PolicyVerdict',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'verdict_id',
    'graph_id',
    'node_id',
    'rule_id',
    'rule_version',
    'context_selector',
    'condition_evaluated',
    'inputs_hash',
    'verdict',
    'threshold_values',
    'precedence_rank',
    'effective_from',
    'effective_to',
    'owner',
    'immutable_rules_evaluated',
    'immutable_rule_engaged',
    'decided_at',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    verdict_id: ref('prefixedId'),
    graph_id: ref('prefixedId'),
    node_id: { type: 'string' },
    rule_id: { type: 'string' },
    rule_version: { type: 'string' },
    context_selector: { type: 'object', additionalProperties: { type: 'string' } },
    condition_evaluated: { type: 'string' },
    inputs_hash: ref('prefixedHash'),
    verdict: enumOf(POLICY_VERDICTS),
    threshold_values: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['setting_id', 'value_ref', 'value_hash'],
        properties: {
          setting_id: ref('settingRef'),
          value_ref: { type: 'string' },
          value_hash: ref('prefixedHash'),
        },
      },
      description: 'References plus hashes — never inline client values (DWD-06 s.3.7).',
    },
    precedence_rank: { type: 'integer' },
    effective_from: ref('dateOnly'),
    effective_to: { oneOf: [ref('dateOnly'), { type: 'null' }] },
    owner: { type: 'string' },
    immutable_rules_evaluated: { type: 'array', items: enumOf(IMMUTABLE_RULES) },
    immutable_rule_engaged: { oneOf: [enumOf(IMMUTABLE_RULES), { type: 'null' }] },
    decided_at: ref('timestamp'),
  },
  allOf: [
    {
      // s.3.7: a non-null immutable rule forces `refuse` regardless of the rule
      // verdict. Encoding it here means no code path can emit the contradiction.
      if: {
        properties: { immutable_rule_engaged: { type: 'integer' } },
        required: ['immutable_rule_engaged'],
      },
      then: { properties: { verdict: { const: 'refuse' } } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.8 SkillInvocation
// ---------------------------------------------------------------------------
export const skillInvocationSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('SkillInvocation'),
  title: 'SkillInvocation',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'invocation_id',
    'graph_id',
    'node_id',
    'skill_id',
    'skill_version',
    'mode',
    'context_ref',
    'inputs_ref',
    'inputs_hash',
    'knowledge_used',
    'records_used',
    'tool_call_ids',
    'model_route',
    'output_ref',
    'output_hash',
    'citations',
    'quality_criteria_results',
    'tokens',
    'cost',
    'duration_ms',
    'status',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    invocation_id: ref('prefixedId'),
    graph_id: ref('prefixedId'),
    node_id: { type: 'string' },
    skill_id: { type: 'string' },
    skill_version: { type: 'string' },
    mode: enumOf(SKILL_MODES),
    context_ref: ref('prefixedId'),
    inputs_ref: ref('storageRef'),
    inputs_hash: ref('prefixedHash'),
    knowledge_used: { type: 'array', items: ref('knowledgeUsed') },
    records_used: { type: 'array', items: ref('recordUsed') },
    tool_call_ids: { type: 'array', items: { type: 'string' } },
    model_route: {
      type: 'object',
      additionalProperties: false,
      required: ['route_id', 'model', 'fallback_used'],
      properties: {
        route_id: { type: 'string' },
        model: { type: 'string' },
        fallback_used: { type: 'boolean' },
      },
    },
    output_ref: { oneOf: [ref('storageRef'), { type: 'null' }] },
    output_hash: { oneOf: [ref('prefixedHash'), { type: 'null' }] },
    citations: { type: 'array', items: ref('citation') },
    confidence: ref('decimalString'),
    quality_criteria_results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'result'],
        properties: {
          criterion: { type: 'string' },
          result: enumOf(QUALITY_CRITERION_RESULTS),
          detail: { type: 'string' },
        },
      },
    },
    tokens: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'output'],
      properties: {
        input: { type: 'integer', minimum: 0 },
        output: { type: 'integer', minimum: 0 },
      },
    },
    cost: ref('money'),
    duration_ms: { type: 'integer', minimum: 0 },
    status: enumOf(INVOCATION_STATUSES),
  },
};

// ---------------------------------------------------------------------------
// 3.9 ToolCall
// ---------------------------------------------------------------------------
export const toolCallSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('ToolCall'),
  title: 'ToolCall',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'tool_call_id',
    'graph_id',
    'node_id',
    'invocation_id',
    'tool_id',
    'capability_schema_version',
    'permission_scope_requested',
    'permission_scope_granted',
    'scope_qualifiers',
    'authority_ref',
    'state_changing',
    'dry_run',
    'request_hash',
    'attempt',
    'started_at',
    'ended_at',
    'outcome',
    'cost',
    'error',
    'compensated_by',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    tool_call_id: ref('prefixedId'),
    graph_id: ref('prefixedId'),
    node_id: { type: 'string' },
    invocation_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
    tool_id: { type: 'string', pattern: '^TL-[A-Z]+-[0-9]{2}$' },
    capability_schema_version: { type: 'string' },
    permission_scope_requested: { type: 'string' },
    permission_scope_granted: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    scope_qualifiers: { type: 'object' },
    authority_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['autonomy', 'policy_verdict_id', 'approval_ref'],
      properties: {
        autonomy: enumOf(AUTONOMY_LEVELS),
        policy_verdict_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
        approval_ref: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    state_changing: { type: 'boolean' },
    dry_run: { type: 'boolean' },
    idempotency_key: ref('idempotencyKey'),
    request_hash: ref('prefixedHash'),
    attempt: { type: 'integer', minimum: 1 },
    started_at: ref('timestamp'),
    ended_at: { oneOf: [ref('timestamp'), { type: 'null' }] },
    outcome: enumOf(TOOL_OUTCOMES),
    provider_reference: { type: 'string' },
    business_key: { type: 'string' },
    rate_limit_remaining: { type: 'integer', minimum: 0 },
    cost: ref('money'),
    error: { oneOf: [ref('failure'), { type: 'null' }] },
    compensated_by: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  allOf: [
    {
      if: { properties: { state_changing: { const: true } }, required: ['state_changing'] },
      then: { required: ['idempotency_key'] },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.10 EvidenceBundle
// ---------------------------------------------------------------------------
export const evidenceBundleSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('EvidenceBundle'),
  title: 'EvidenceBundle',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'bundle_id',
    'tenant_id',
    'graph_id',
    'output_class',
    'bundle_version',
    'proposed_output',
    'trace',
    'citations',
    'records',
    'policy_verdicts',
    'confidence_by_step',
    'lowest_confidence_step',
    'assurance',
    'cost_to_date',
    'pack_version',
    'platform_version',
    'assembled_at',
    'worm_ref',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    bundle_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    graph_id: ref('prefixedId'),
    output_class: enumOf(OUTPUT_CLASSES),
    bundle_version: { type: 'integer', minimum: 1 },
    proposed_output: {
      type: 'object',
      additionalProperties: false,
      required: ['artifact_ref', 'content_hash'],
      properties: {
        artifact_ref: ref('storageRef'),
        content_hash: ref('prefixedHash'),
        render_ref: ref('storageRef'),
      },
    },
    trace: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'kind', 'summary'],
        properties: {
          node_id: { type: 'string' },
          kind: enumOf(NODE_KINDS),
          summary: { type: 'string' },
        },
      },
      description:
        'Node-level trace, not a model transcript. Reasoning text is never placed ' +
        'in a bundle (file 04 s.6.1).',
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chunk_id', 'module_id', 'version', 'effective_from', 'locator'],
        properties: {
          chunk_id: { type: 'string' },
          module_id: { type: 'string' },
          version: { type: 'string' },
          effective_from: ref('dateOnly'),
          locator: { type: 'string' },
        },
      },
    },
    records: { type: 'array', items: ref('recordUsed') },
    policy_verdicts: { type: 'array', items: ref('prefixedId') },
    confidence_by_step: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'confidence'],
        properties: { node_id: { type: 'string' }, confidence: ref('decimalString') },
      },
    },
    lowest_confidence_step: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    assurance: {
      type: 'object',
      additionalProperties: false,
      required: [...ASSURANCE_GATES, 'harness_version'],
      properties: {
        ...Object.fromEntries(ASSURANCE_GATES.map((gate) => [gate, enumOf(GATE_RESULTS)])),
        harness_version: { type: 'string' },
      },
      // s.3.10: "A bundle cannot be assembled with a failing gate."
      allOf: ASSURANCE_GATES.map((gate) => ({
        properties: { [gate]: { not: { const: 'fail' } } },
      })),
    },
    cost_to_date: {
      type: 'object',
      additionalProperties: false,
      required: ['amount_minor', 'currency', 'scale', 'budget_ref'],
      properties: {
        amount_minor: { type: 'integer' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        scale: { type: 'integer', minimum: 0, maximum: 6 },
        budget_ref: ref('settingRef'),
      },
    },
    pack_version: { type: 'string' },
    platform_version: { type: 'string' },
    assembled_at: ref('timestamp'),
    worm_ref: { type: 'string', pattern: '^worm://.+' },
  },
};

// ---------------------------------------------------------------------------
// 3.11 HandoffPackage
// ---------------------------------------------------------------------------
export const handoffPackageSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('HandoffPackage'),
  title: 'HandoffPackage',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'handoff_id',
    'graph_id',
    'node_id',
    'bundle_id',
    'bundle_version',
    'question',
    'decision_type',
    'assignee',
    'dual_control_required',
    'second_approver',
    'sod_exclusions_applied',
    'permitted_moves',
    'channels',
    'sla',
    'nonce',
    'issued_at',
    'state',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    handoff_id: ref('prefixedId'),
    graph_id: ref('prefixedId'),
    node_id: { type: 'string' },
    bundle_id: ref('prefixedId'),
    bundle_version: { type: 'integer', minimum: 1 },
    question: { type: 'string', minLength: 1 },
    decision_type: enumOf(DECISION_TYPES),
    assignee: ref('namedPrincipal'),
    dual_control_required: { type: 'boolean' },
    second_approver: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['principal_id', 'role_ref'],
          properties: { principal_id: { type: 'string' }, role_ref: { type: 'string' } },
        },
        { type: 'null' },
      ],
    },
    sod_exclusions_applied: { type: 'array', items: { type: 'string' } },
    permitted_moves: {
      type: 'array',
      minItems: 1,
      maxItems: REVIEWER_MOVES.length,
      uniqueItems: true,
      items: enumOf(REVIEWER_MOVES),
      description: 'Exactly the four moves; no fifth value is representable.',
    },
    channels: {
      type: 'object',
      additionalProperties: false,
      required: ['delivery', 'approval'],
      properties: {
        delivery: { type: 'array', minItems: 1, items: enumOf(CHANNELS) },
        approval: { type: 'array', minItems: 1, items: enumOf(CHANNELS) },
      },
    },
    sla: {
      type: 'object',
      additionalProperties: false,
      required: ['due_at', 'source', 'escalation_target'],
      properties: {
        due_at: ref('timestamp'),
        source: ref('settingRef'),
        escalation_target: ref('settingRef'),
      },
    },
    nonce: { type: 'string', minLength: 32 },
    issued_at: ref('timestamp'),
    state: enumOf(HANDOFF_STATES),
  },
};

// ---------------------------------------------------------------------------
// 3.12 ReviewerAction
// ---------------------------------------------------------------------------
export const reviewerActionSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('ReviewerAction'),
  title: 'ReviewerAction',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'action_id',
    'handoff_id',
    'bundle_version_acted_on',
    'actor',
    'move',
    'nonce_presented',
    'nonce_valid',
    'reason_code',
    'free_text',
    'diff_ref',
    'acted_at',
    'ip_or_device_ref',
    'second_approver_action_id',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    action_id: ref('prefixedId'),
    handoff_id: ref('prefixedId'),
    bundle_version_acted_on: { type: 'integer', minimum: 1 },
    actor: {
      type: 'object',
      additionalProperties: false,
      required: ['principal_id', 'auth_method', 'channel'],
      properties: {
        principal_id: { type: 'string' },
        auth_method: { type: 'string' },
        channel: enumOf(CHANNELS),
      },
    },
    move: enumOf(REVIEWER_MOVES),
    nonce_presented: { type: 'string' },
    nonce_valid: { type: 'boolean' },
    reason_code: { oneOf: [enumOf(REJECTION_REASON_CODES), { type: 'null' }] },
    free_text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    diff_ref: { oneOf: [ref('storageRef'), { type: 'null' }] },
    materiality: {
      type: 'object',
      additionalProperties: false,
      required: ['assessed', 'material', 'threshold_ref', 'change_request_id'],
      properties: {
        assessed: { type: 'boolean' },
        material: { type: 'boolean' },
        threshold_ref: ref('settingRef'),
        change_request_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    approved_output_hash: ref('prefixedHash'),
    acted_at: ref('timestamp'),
    ip_or_device_ref: { type: 'string' },
    second_approver_action_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
  },
  allOf: [
    {
      // s.3.12: approved_output_hash is required on approve and edit_and_approve.
      // "This exact artefact is what may be released."
      if: {
        properties: { move: { enum: ['approve', 'edit_and_approve'] } },
        required: ['move'],
      },
      then: { required: ['approved_output_hash'] },
    },
    {
      // s.3.12: materiality is required on edit_and_approve.
      if: { properties: { move: { const: 'edit_and_approve' } }, required: ['move'] },
      then: { required: ['materiality', 'diff_ref'] },
    },
    {
      // s.3.12: reason_code is required on reject_with_reason.
      if: { properties: { move: { const: 'reject_with_reason' } }, required: ['move'] },
      then: { properties: { reason_code: enumOf(REJECTION_REASON_CODES) } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.13 DecisionRecord
// ---------------------------------------------------------------------------
export const decisionRecordSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('DecisionRecord'),
  title: 'DecisionRecord',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'decision_id',
    'tenant_id',
    'output_class',
    'authorisation_verdict',
    'named_owner',
    'evidence_bundle_ref',
    'pack_version',
    'platform_version',
    'skill_versions',
    'reviewer_action_id',
    'reserved_act_ref',
    'graph_id',
    'timestamp',
    'worm_ref',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    decision_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    output_class: enumOf(OUTPUT_CLASSES),
    authorisation_verdict: enumOf(AUTHORISATION_VERDICTS),
    named_owner: ref('namedPrincipal'),
    evidence_bundle_ref: { type: 'string', pattern: '^worm://.+' },
    pack_version: { type: 'string' },
    platform_version: { type: 'string' },
    skill_versions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['skill_id', 'version'],
        properties: { skill_id: { type: 'string' }, version: { type: 'string' } },
      },
    },
    reviewer_action_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
    reserved_act_ref: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    graph_id: ref('prefixedId'),
    timestamp: ref('timestamp'),
    worm_ref: { type: 'string', pattern: '^worm://.+' },
  },
  allOf: [
    {
      // s.3.13: `requires_human` means a reviewer action produced the decision.
      if: {
        properties: { authorisation_verdict: { const: 'requires_human' } },
        required: ['authorisation_verdict'],
      },
      then: { properties: { reviewer_action_id: ref('prefixedId') } },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3.14 AuditEvent
// ---------------------------------------------------------------------------
export const auditEventSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('AuditEvent'),
  title: 'AuditEvent',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'event_id',
    'tenant_id',
    'trace_id',
    'span_id',
    'occurred_at',
    'recorded_at',
    'layer',
    'component',
    'event_type',
    'actor',
    'subject',
    'context_ref',
    'graph_id',
    'outcome',
    'payload_hash',
    'payload_ref',
    'prev_event_hash',
    'event_hash',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    event_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    trace_id: ref('traceId'),
    span_id: ref('spanId'),
    occurred_at: ref('timestamp'),
    recorded_at: ref('timestamp'),
    layer: enumOf(LAYERS),
    component: enumOf(COMPONENTS),
    event_type: enumOf(AUDIT_EVENT_TYPES),
    actor: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'principal_id'],
      properties: {
        kind: enumOf(ACTOR_KINDS),
        skill_id: { type: 'string' },
        principal_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { type: 'string' }, id: { type: 'string' } },
    },
    context_ref: { oneOf: [ref('prefixedId'), { type: 'null' }] },
    graph_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
    outcome: enumOf(AUDIT_OUTCOMES),
    payload_hash: ref('prefixedHash'),
    payload_ref: { oneOf: [ref('storageRef'), { type: 'null' }] },
    prev_event_hash: ref('prefixedHash'),
    event_hash: ref('prefixedHash'),
  },
};

// ---------------------------------------------------------------------------
// 3.15 OutboundDelivery
// ---------------------------------------------------------------------------
export const outboundDeliverySchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('OutboundDelivery'),
  title: 'OutboundDelivery',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'delivery_id',
    'tenant_id',
    'conversation_key',
    'graph_id',
    'decision_record_ref',
    'output_class',
    'recipient',
    'channel',
    'locale',
    'sensitivity',
    'payload',
    'contract_elements',
    'idempotency_key',
    'attempt_group',
    'status',
    'status_history',
    'provider_reference',
    'failure',
    'feedback_hook',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    delivery_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    conversation_key: { type: 'string' },
    graph_id: ref('prefixedId'),
    decision_record_ref: ref('prefixedId'),
    output_class: enumOf(OUTPUT_CLASSES),
    recipient: {
      type: 'object',
      additionalProperties: false,
      required: ['principal_id', 'external'],
      properties: { principal_id: { type: 'string' }, external: { type: 'boolean' } },
    },
    channel: enumOf(CHANNELS),
    locale: ref('locale'),
    sensitivity: enumOf(SENSITIVITY_TIERS),
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['body_ref'],
      properties: {
        body_ref: ref('storageRef'),
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['artifact_ref', 'content_hash'],
            properties: { artifact_ref: ref('storageRef'), content_hash: ref('prefixedHash') },
          },
        },
      },
    },
    contract_elements: {
      type: 'object',
      additionalProperties: false,
      required: [
        'answer',
        'basis_and_citations',
        'status_and_limits',
        'exclusions',
        'next_action_and_owner',
      ],
      properties: {
        answer: { const: true },
        basis_and_citations: { const: true },
        status_and_limits: { const: true },
        exclusions: { const: true },
        next_action_and_owner: { const: true },
      },
      description:
        'All five elements of the response contract present, or the delivery is ' +
        'refused (file 04 s.1). `const: true` makes a partial contract unrepresentable.',
    },
    idempotency_key: ref('idempotencyKey'),
    attempt_group: { type: 'integer', minimum: 1 },
    status: enumOf(DELIVERY_STATUSES),
    status_history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'at'],
        properties: { status: enumOf(DELIVERY_STATUSES), at: ref('timestamp') },
      },
    },
    provider_reference: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    failure: { oneOf: [ref('failure'), { type: 'null' }] },
    feedback_hook: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'token'],
      properties: {
        kind: enumOf(FEEDBACK_HOOK_KINDS),
        token: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 3.16 FeedbackEvent
// ---------------------------------------------------------------------------
export const feedbackEventSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaId('FeedbackEvent'),
  title: 'FeedbackEvent',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'feedback_id',
    'tenant_id',
    'delivery_id',
    'graph_id',
    'skill_id',
    'skill_version',
    'source',
    'signal',
    'category',
    'free_text',
    'correctness_label',
    'labelled_by',
    'affects_accuracy_floor',
    'created_at',
  ],
  properties: {
    schema_version: ref('schemaVersion'),
    feedback_id: ref('prefixedId'),
    tenant_id: ref('tenantId'),
    delivery_id: { oneOf: [ref('prefixedId'), { type: 'null' }] },
    graph_id: ref('prefixedId'),
    skill_id: { type: 'string' },
    skill_version: { type: 'string' },
    source: enumOf(FEEDBACK_SOURCES),
    signal: enumOf(FEEDBACK_SIGNALS),
    category: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    free_text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    correctness_label: { oneOf: [enumOf(CORRECTNESS_LABELS), { type: 'null' }] },
    labelled_by: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['principal_id', 'role_ref'],
          properties: { principal_id: { type: 'string' }, role_ref: { type: 'string' } },
        },
        { type: 'null' },
      ],
    },
    affects_accuracy_floor: { type: 'boolean' },
    created_at: ref('timestamp'),
  },
};

/** The sixteen, keyed by contract name. */
export const CONTRACT_SCHEMAS = {
  InboundRequest: inboundRequestSchema,
  ResolvedContext: resolvedContextSchema,
  Conversation: conversationSchema,
  Message: messageSchema,
  TaskGraph: taskGraphSchema,
  TaskNode: taskNodeSchema,
  PolicyVerdict: policyVerdictSchema,
  SkillInvocation: skillInvocationSchema,
  ToolCall: toolCallSchema,
  EvidenceBundle: evidenceBundleSchema,
  HandoffPackage: handoffPackageSchema,
  ReviewerAction: reviewerActionSchema,
  DecisionRecord: decisionRecordSchema,
  AuditEvent: auditEventSchema,
  OutboundDelivery: outboundDeliverySchema,
  FeedbackEvent: feedbackEventSchema,
} as const satisfies Record<string, JsonSchema>;
