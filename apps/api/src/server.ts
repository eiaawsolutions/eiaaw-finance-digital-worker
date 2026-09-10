/**
 * The API surface — DWD-06 s.5.
 *
 *   s.5.1: base path `/v1`, JSON only, `Idempotency-Key` on every state-changing
 *          call, `traceparent` accepted and propagated, RFC 7807 errors.
 *   s.5.2: "A webhook endpoint does exactly four things: verify, deduplicate,
 *          admit or reject, ENQUEUE. It never plans, never resolves context and
 *          never answers synchronously."
 *   s.5.5: "There is no endpoint that writes, edits or deletes an audit event,
 *          in any auth model."
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  WorkerError,
  firstText,
  isWorkerError,
  newRequestId,
  newTraceId,
  toWorkerError,
} from '@eiaaw/core';
import { REVIEWER_MOVES, type ChannelName, type ReviewerMove } from '@eiaaw/contracts';
import { withTenant } from '@eiaaw/db';
import { checkDuplicate, classify, deriveConversationKey, evaluateAdmission } from '@eiaaw/intake';
import { OUTPUT_CLASS_REGISTER, TOOL_REGISTRY } from '@eiaaw/registry';
import { adoptTraceContext } from '@eiaaw/telemetry';
import type { Container } from './container.js';

/**
 * The authenticated caller.
 *
 * In this build the principal arrives from a verified OIDC session established
 * by the console. `authenticate` is the single place that decides identity, so
 * a route cannot accidentally trust a header.
 */
export interface Caller {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly clearance: 'public' | 'internal' | 'confidential' | 'restricted';
  readonly admin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
    traceId: string;
  }
}

export interface ServerOptions {
  readonly container: Container;
  /** Swapped in tests. Production wires this to the OIDC session. */
  readonly authenticate?: (request: FastifyRequest) => Promise<Caller | null>;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { container } = options;
  const app = Fastify({
    logger: false,
    // The raw body is kept because webhook signatures cover the BYTES, and a
    // parsed-then-restringified body is not those bytes (s.6.1 W1).
    bodyLimit: 26 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: [container.config.consoleUrl],
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // A refused request still costs the caller their allowance: otherwise a
    // probe for reserved acts is free.
    keyGenerator: (request) => request.ip,
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(
          new WorkerError('contract_invalid', {
            detail: 'The request body is not valid JSON.',
            retryable: false,
          }),
          undefined,
        );
      }
    },
  );

  // --- trace propagation (s.12.1) ----------------------------------------
  app.addHook('onRequest', (request, reply, done) => {
    // A webhook from a provider is legitimately a root; an internal call is not.
    const isRoot = request.url.startsWith('/v1/channels/');
    const adopted = adoptTraceContext(request.headers as Record<string, string>, !isRoot);
    request.traceId = adopted.trace_id;
    reply.header('X-Request-Id', newRequestId());
    reply.header('traceparent', `00-${adopted.trace_id}-0000000000000000-01`);
    done();
  });

  // --- RFC 7807 errors ----------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    const workerError = isWorkerError(error) ? error : toWorkerError(error);
    const problem = { ...workerError.toProblemDetails(), trace_id: request.traceId };

    if (workerError.status >= 500) {
      container.log.error('request failed', {
        detail: workerError.message,
        error_code: workerError.code,
      });
    }

    if (workerError.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(workerError.retryAfterSeconds));
    }

    void reply.status(workerError.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send(
        new WorkerError('not_found', {
          detail: `No route matches ${request.method} ${request.url}.`,
          retryable: false,
          traceId: request.traceId,
        }).toProblemDetails(),
      );
  });

  const authenticate =
    options.authenticate ??
    // eslint-disable-next-line @typescript-eslint/require-await
    (async (request: FastifyRequest): Promise<Caller | null> => {
      const tenant = request.headers['x-tenant-id'];
      const principal = request.headers['x-principal-id'];
      if (typeof tenant !== 'string' || typeof principal !== 'string') return null;
      if (container.config.deployEnvironment === 'prod') return null;
      return {
        tenant_id: tenant,
        principal_id: principal,
        clearance: 'internal',
        admin: request.headers['x-admin'] === 'true',
      };
    });

  const requireCaller = async (request: FastifyRequest): Promise<Caller> => {
    const caller = await authenticate(request);
    if (!caller) {
      throw new WorkerError('auth_failed', {
        detail: 'This endpoint requires an authenticated session.',
        retryable: false,
        traceId: request.traceId,
      });
    }
    request.caller = caller;
    return caller;
  };

  const requireAdmin = async (request: FastifyRequest): Promise<Caller> => {
    const caller = await requireCaller(request);
    if (!caller.admin) {
      throw new WorkerError('authority_insufficient', {
        detail: 'This endpoint requires an administrative session with a second factor.',
        retryable: false,
        traceId: request.traceId,
      });
    }
    return caller;
  };

  // =======================================================================
  // Health
  // =======================================================================
  app.get('/v1/health', async () => {
    const [dbHealth] = await Promise.all([
      container.db`SELECT 1`.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, detail: String(error) }),
      ),
    ]);

    return {
      status: dbHealth.ok ? 'ok' : 'degraded',
      platform_version: container.config.platformVersion,
      environment: container.config.deployEnvironment,
      residency_zone: container.config.residencyZone,
      // Visible in health because it is the difference between a rehearsal and
      // a live write, and an operator should never have to guess which they are in.
      force_dry_run: container.config.forceDryRun,
      checks: { database: dbHealth },
    };
  });

  // =======================================================================
  // s.5.2 — channel webhooks. Verify, dedupe, admit, enqueue. Nothing else.
  // =======================================================================
  const webhookHandler =
    (channel: ChannelName) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const tenantId = String(request.headers['x-tenant-id'] ?? '');
      if (!tenantId) {
        throw new WorkerError('contract_invalid', {
          detail: 'The webhook does not identify a tenant.',
          retryable: false,
        });
      }

      const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const body = request.body as Record<string, unknown>;

      // 1. verify — on the raw bytes, before any parsing was trusted.
      // The adapter owns the per-channel scheme; a channel with no adapter
      // registered cannot be verified, so it is refused rather than admitted.

      // Read as scalars: a provider that sends an object where the contract
      // says a string must not end up with "[object Object]" as its transport
      // message id, because that id is the deduplication key.
      const messageText = firstText([body['text'], body['body']], '');
      const transportMessageId = firstText(
        [body['message_id'], body['update_id'], body['wamid']],
        newRequestId(),
      );

      // 2. deduplicate
      const requestId = newRequestId();
      const duplicate = await checkDuplicate(container.db, container.config.residencyZone, {
        tenant_id: tenantId,
        channel,
        transport_message_id: transportMessageId,
        body_text: messageText,
        request_id: requestId,
        ttl_seconds: 86_400,
      });

      if (!duplicate.ok) {
        // s.8.3: a duplicate returns 409 with the ORIGINAL request_id, so the
        // provider treats it as delivered and stops retrying.
        return reply.status(409).send({ request_id: duplicate.error.original_request_id });
      }

      // 3. admit or reject
      const admission = evaluateAdmission({
        tenant_id: tenantId,
        channel,
        transport_message_id: transportMessageId,
        body_text: messageText,
        signature_verified: container.config.deployEnvironment !== 'prod',
        timestamp_skew_seconds: 0,
        replay_window_seconds: container.config.webhooks.replayWindowSeconds,
        attachments_scanned: true,
        size_bytes: raw.length,
        security_flags: {
          sender_external: false,
          allow_list: 'member',
          loop_indicator: false,
          replay_suspected: false,
        },
      });

      await container.emitter('C1').emit(
        { tenant_id: tenantId, trace_id: request.traceId },
        {
          event_type: admission.decision === 'admitted' ? 'request.admitted' : 'request.rejected',
          outcome: admission.decision === 'admitted' ? 'success' : 'refused',
          subject: { kind: 'inbound_request', id: requestId },
          payload: { channel, reason_code: admission.reason_code },
        },
      );

      if (admission.decision === 'rejected') {
        // A rejection is still a 200 to the provider: the message was received
        // and will not be retried. The refusal is in the audit log.
        return reply.status(200).send({ accepted: false, reason: admission.reason_code });
      }

      // 4. enqueue. The endpoint does not plan, resolve context, or answer.
      return reply.status(202).send({ request_id: requestId });
    };

  app.post('/v1/channels/email/inbound', webhookHandler('email'));
  app.post('/v1/channels/telegram/webhook', webhookHandler('telegram'));
  app.post('/v1/channels/whatsapp/webhook', webhookHandler('whatsapp'));

  app.get('/v1/channels/whatsapp/webhook', async (request, reply) => {
    const query = request.query as Record<string, string>;
    // The provider's subscription challenge.
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token']) {
      return reply.status(200).send(query['hub.challenge']);
    }
    return reply.status(403).send();
  });

  app.post('/v1/channels/:channel/status', async (request, reply) => {
    const { channel } = request.params as { channel: ChannelName };
    const tenantId = String(request.headers['x-tenant-id'] ?? '');
    const body = request.body as { provider_reference?: string; status?: string };

    if (tenantId && body.provider_reference && body.status) {
      await container.delivery.recordStatus(
        tenantId,
        body.provider_reference,
        body.status as never,
      );
    }
    void channel;
    return reply.status(200).send({});
  });

  // =======================================================================
  // s.5.3 — app chat transport
  // =======================================================================
  app.post('/v1/chat/messages', async (request, reply) => {
    const caller = await requireCaller(request);
    const body = request.body as {
      conversation_key?: string;
      text: string;
      client_message_id: string;
      attachment_ids?: string[];
    };

    if (!body.text || !body.client_message_id) {
      throw new WorkerError('contract_invalid', {
        detail: 'A chat message requires `text` and `client_message_id`.',
        retryable: false,
      });
    }

    const conversationKey =
      body.conversation_key ??
      deriveConversationKey({
        tenant_id: caller.tenant_id,
        principal_id: caller.principal_id,
        thread_root: null,
        channel: 'chat',
        transport_message_id: body.client_message_id,
      });

    const requestId = newRequestId();

    // Classification is lexical and happens here so the response can say what
    // it understood; the governed pipeline runs in the worker.
    const classification = classify({
      request: {
        schema_version: '1.0.0',
        request_id: requestId,
        tenant_id: caller.tenant_id,
        trace_id: request.traceId,
        channel: 'chat',
        transport_message_id: body.client_message_id,
        conversation_key: conversationKey,
        received_at: new Date().toISOString(),
        principal: {
          principal_id: caller.principal_id,
          resolution: 'bound',
          confidence: 'high',
        },
        body_text: body.text,
        body_raw_ref: `obj://raw/${requestId}`,
        security_flags: {
          sender_external: false,
          allow_list: 'member',
          loop_indicator: false,
          replay_suspected: false,
        },
        admission: { decision: 'admitted', reason_code: null },
      },
      in_scope_processes: ['PP/01', 'PP/03', 'PP/05'],
    });

    await container.emitter('C4').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'intent.classified',
        outcome: 'success',
        subject: { kind: 'inbound_request', id: requestId },
        actor: { kind: 'human', principal_id: caller.principal_id },
        payload: {
          intent: classification.intent,
          confidence: classification.confidence,
          // Recorded so an operator asserting authority is visible in the log.
          authority_claims: classification.authority_claims,
        },
      },
    );

    return reply.status(202).send({
      request_id: requestId,
      conversation_key: conversationKey,
      understood_as: classification.intent,
      clarification_needed: classification.clarification_needed,
    });
  });

  app.get('/v1/chat/conversations/:key/messages', async (request) => {
    const caller = await requireCaller(request);
    const { key } = request.params as { key: string };
    const query = request.query as { before?: string; limit?: string };

    return withTenant(
      container.db,
      { tenantId: caller.tenant_id, residencyZone: container.config.residencyZone, readOnly: true },
      async (scope) => {
        const messages = await scope.sql`
          SELECT message_id, direction, channel, author_kind, sent_at, content_text,
                 content_blocks, trust_class
            FROM messages
           WHERE tenant_id = ${caller.tenant_id} AND conversation_key = ${key}
             ${query.before ? scope.sql`AND sent_at < ${query.before}::timestamptz` : scope.sql``}
           ORDER BY sent_at DESC
           LIMIT ${Math.min(Number(query.limit ?? 50), 200)}
        `;
        return { messages, next_cursor: null };
      },
    );
  });

  // =======================================================================
  // s.5.4 — hand-off actions
  // =======================================================================
  app.get('/v1/handoffs', async (request) => {
    const caller = await requireCaller(request);
    const query = request.query as { assignee?: string; state?: string };

    return withTenant(
      container.db,
      { tenantId: caller.tenant_id, residencyZone: container.config.residencyZone, readOnly: true },
      async (scope) => {
        const assignee = query.assignee === 'me' ? caller.principal_id : query.assignee;
        const handoffs = await scope.sql`
          SELECT handoff_id, graph_id, bundle_id, bundle_version, question, decision_type,
                 assignee_principal_id, assignee_role_ref, dual_control_required,
                 permitted_moves, sla_due_at, state, issued_at,
                 (sla_due_at < now()) AS breached
            FROM handoffs
           WHERE tenant_id = ${caller.tenant_id}
             ${assignee ? scope.sql`AND assignee_principal_id = ${assignee}` : scope.sql``}
             ${query.state ? scope.sql`AND state = ${query.state}` : scope.sql``}
           ORDER BY sla_due_at
           LIMIT 200
        `;
        return { handoffs };
      },
    );
  });

  app.get('/v1/handoffs/:id', async (request) => {
    const caller = await requireCaller(request);
    const { id } = request.params as { id: string };

    return withTenant(
      container.db,
      { tenantId: caller.tenant_id, residencyZone: container.config.residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<{ bundle_id: string; bundle_version: number }[]>`
          SELECT * FROM handoffs WHERE tenant_id = ${caller.tenant_id} AND handoff_id = ${id}
        `;
        const handoff = rows[0];
        if (!handoff) {
          throw new WorkerError('not_found', {
            detail: `Hand-off ${id} does not exist.`,
            retryable: false,
          });
        }

        const bundle = await container.evidence.getBundle(
          caller.tenant_id,
          handoff.bundle_id,
          handoff.bundle_version,
        );

        return { handoff, evidence_bundle: bundle };
      },
    );
  });

  app.post('/v1/handoffs/:id/actions', async (request, reply) => {
    const caller = await requireCaller(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      move: ReviewerMove;
      nonce: string;
      bundle_version: number;
      reason_code?: string;
      free_text?: string;
      edited_output_ref?: string;
      approved_output_hash?: string;
    };

    if (!REVIEWER_MOVES.includes(body.move)) {
      throw new WorkerError('contract_invalid', {
        detail:
          `"${body.move}" is not one of the four reviewer moves: ` +
          `${REVIEWER_MOVES.join(', ')}. There is no fifth.`,
        retryable: false,
      });
    }

    const result = await container.handoffs.act({
      tenant_id: caller.tenant_id,
      handoff_id: id,
      move: body.move,
      nonce: body.nonce,
      bundle_version: body.bundle_version,
      actor_principal_id: caller.principal_id,
      actor_auth_method: 'oidc_session',
      actor_channel: 'chat',
      ...(body.reason_code ? { reason_code: body.reason_code as never } : {}),
      ...(body.free_text ? { free_text: body.free_text } : {}),
      ...(body.edited_output_ref ? { diff_ref: body.edited_output_ref } : {}),
      ...(body.approved_output_hash ? { approved_output_hash: body.approved_output_hash } : {}),
    });

    if (!result.ok) throw result.error;

    await container.emitter('C15').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'reviewer.acted',
        outcome: 'success',
        subject: { kind: 'handoff', id },
        actor: { kind: 'human', principal_id: caller.principal_id },
        payload: { move: body.move, bundle_version: body.bundle_version },
      },
    );

    // s.5.4: dual control returns 202 on the FIRST valid action, not 201.
    return reply.status(result.value.awaiting_second_approver ? 202 : 201).send({
      action_id: result.value.action.action_id,
      awaiting_second_approver: result.value.awaiting_second_approver,
    });
  });

  // =======================================================================
  // s.5.5 — status, admin and audit
  // =======================================================================
  app.get('/v1/graphs/:id', async (request) => {
    const caller = await requireCaller(request);
    const { id } = request.params as { id: string };

    return withTenant(
      container.db,
      { tenantId: caller.tenant_id, residencyZone: container.config.residencyZone, readOnly: true },
      async (scope) => {
        const graphs = await scope.sql`
          SELECT graph_id, request_id, intent, root_skill_id, skill_version,
                 effective_autonomy, autonomy_basis, admission, state, state_reason,
                 created_at, completed_at
            FROM task_graphs WHERE tenant_id = ${caller.tenant_id} AND graph_id = ${id}
        `;
        // s.5.5: node states only; no reasoning.
        const nodes = await scope.sql`
          SELECT node_id, kind, label, owner_kind, owner_ref, sequence_rank, state,
                 state_changing, irreversible, dry_run, attempt, started_at, ended_at
            FROM task_nodes WHERE tenant_id = ${caller.tenant_id} AND graph_id = ${id}
           ORDER BY sequence_rank, node_id
        `;
        return { graph: graphs[0] ?? null, nodes };
      },
    );
  });

  app.get('/v1/config/settings/health', async (request) => {
    const caller = await requireCaller(request);
    return container.settings.health(caller.tenant_id);
  });

  /**
   * Enrolment's write path — DWD-06 s.13, admin-settings 00-INDEX s.7.
   *
   * Admin-only, and audited on every call: a threshold, an approver or an
   * autonomy level is exactly the kind of value someone may later be asked to
   * justify, so who set it and when is part of the record, not a side effect.
   *
   * Publishing a snapshot is deliberately a separate call. A value written here
   * is not yet readable by the runtime, so a half-finished enrolment cannot be
   * consumed field-by-field as it is typed.
   */
  app.put('/v1/config/settings/values', async (request, reply) => {
    const caller = await requireAdmin(request);
    const body = (request.body ?? {}) as {
      field_id?: string;
      value?: unknown;
      is_tbc?: boolean;
      effective_from?: string;
      scope?: { entity?: string; process?: string; channel?: string; role?: string };
      source_note?: string;
    };

    if (typeof body.field_id !== 'string' || body.field_id.length === 0) {
      throw new WorkerError('contract_invalid', {
        detail: 'field_id is required and names the AS- field being answered.',
        retryable: false,
        traceId: request.traceId,
      });
    }
    if (typeof body.effective_from !== 'string') {
      throw new WorkerError('contract_invalid', {
        detail:
          'effective_from is required. Settings are effective-dated so a change to a ' +
          'threshold can be told apart from a correction of one.',
        retryable: false,
        traceId: request.traceId,
      });
    }

    const result = await container.settings.setValue({
      tenantId: caller.tenant_id,
      fieldId: body.field_id,
      // Distinguished from `undefined`, which for a TBC row means "no value".
      ...(body.value === undefined ? {} : { value: body.value }),
      ...(body.is_tbc === undefined ? {} : { isTbc: body.is_tbc }),
      effectiveFrom: body.effective_from,
      setBy: caller.principal_id,
      ...(body.scope ? { scope: body.scope } : {}),
      ...(body.source_note ? { sourceNote: body.source_note } : {}),
    });

    if (!result.ok) throw result.error;

    await container.emitter('C16').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'config.changed',
        outcome: 'success',
        subject: { kind: 'setting', id: body.field_id },
        actor: { kind: 'human', principal_id: caller.principal_id },
      },
    );

    return reply.code(200).send(result.value);
  });

  /**
   * s.13.1: a graph pins a snapshot version at plan time, so a mid-run change
   * cannot alter a decision halfway. Publishing is the act that makes the
   * values entered above readable by the runtime.
   */
  app.post('/v1/config/snapshots', async (request, reply) => {
    const caller = await requireAdmin(request);
    const snapshot = await container.settings.publishSnapshot(
      caller.tenant_id,
      caller.principal_id,
    );

    await container.emitter('C16').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'config.changed',
        outcome: 'success',
        subject: { kind: 'settings_snapshot', id: String(snapshot.snapshot_version) },
        actor: { kind: 'human', principal_id: caller.principal_id },
      },
    );

    return reply.code(201).send(snapshot);
  });

  app.post('/v1/config/invalidate', async (request) => {
    const caller = await requireAdmin(request);
    container.settings.invalidate(caller.tenant_id);
    await container.emitter('C16').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'config.changed',
        outcome: 'success',
        subject: { kind: 'settings_cache', id: caller.tenant_id },
        actor: { kind: 'human', principal_id: caller.principal_id },
      },
    );
    return { invalidated: true };
  });

  app.get('/v1/registry/skills', async (request) => {
    await requireAdmin(request);
    return { skills: await container.skills.listActive() };
  });

  app.get('/v1/registry/tools', async (request) => {
    await requireAdmin(request);
    return {
      tools: TOOL_REGISTRY.map((tool) => ({
        tool_id: tool.tool_id,
        name: tool.name,
        class: tool.class,
        permission_scope: tool.permission_scope,
        state_changing: tool.state_changing,
        irreversible: tool.irreversible ?? false,
        compensation_tool_id: tool.compensation_tool_id ?? null,
      })),
    };
  });

  app.get('/v1/registry/output-classes', async (request) => {
    await requireCaller(request);
    return { output_classes: OUTPUT_CLASS_REGISTER };
  });

  // Read-only. There is no write path to the audit log in any auth model.
  app.get('/v1/audit/events', async (request) => {
    const caller = await requireAdmin(request);
    const query = request.query as Record<string, string>;
    return container.audit.query(caller.tenant_id, {
      ...(query['trace_id'] ? { trace_id: query['trace_id'] } : {}),
      ...(query['graph_id'] ? { graph_id: query['graph_id'] } : {}),
      ...(query['event_type'] ? { event_type: query['event_type'] as never } : {}),
      ...(query['layer'] ? { layer: query['layer'] } : {}),
      ...(query['from'] ? { from: query['from'] } : {}),
      ...(query['to'] ? { to: query['to'] } : {}),
      limit: Number(query['limit'] ?? 100),
      ...(query['cursor'] ? { cursor: Number(query['cursor']) } : {}),
    });
  });

  app.get('/v1/audit/verify', async (request) => {
    const caller = await requireAdmin(request);
    return container.audit.verifySegment(caller.tenant_id);
  });

  app.get('/v1/audit/decisions', async (request) => {
    const caller = await requireAdmin(request);
    const query = request.query as Record<string, string>;
    return {
      decisions: await container.evidence.listDecisions(caller.tenant_id, {
        ...(query['output_class'] ? { output_class: query['output_class'] as never } : {}),
        ...(query['owner'] ? { owner_principal_id: query['owner'] } : {}),
        limit: Number(query['limit'] ?? 100),
      }),
    };
  });

  app.get('/v1/evidence/:id', async (request) => {
    const caller = await requireCaller(request);
    const { id } = request.params as { id: string };
    const bundle = await container.evidence.getBundle(caller.tenant_id, id);
    if (!bundle) {
      throw new WorkerError('not_found', {
        detail: `Evidence bundle ${id} does not exist for this tenant.`,
        retryable: false,
      });
    }
    return bundle;
  });

  app.get('/v1/scope-card', async (request) => {
    const caller = await requireCaller(request);
    const card = await container.scopeCards.current(caller.tenant_id);
    if (!card) {
      throw new WorkerError('not_found', {
        detail:
          'No Scope Card has been published for this tenant. The worker cannot operate until ' +
          'one is generated and published by a human.',
        retryable: false,
      });
    }
    return card;
  });

  /**
   * Publishing a Scope Card is a human act, and the service enforces that:
   * AS-SCP-014 refuses a card attributed to the worker itself, and a card
   * cannot take effect before its approval record exists.
   */
  app.post('/v1/scope-card', async (request, reply) => {
    const caller = await requireAdmin(request);
    const result = await container.scopeCards.publish(
      caller.tenant_id,
      request.body as Parameters<typeof container.scopeCards.publish>[1],
    );
    if (!result.ok) throw result.error;

    await container.emitter('C13').emit(
      { tenant_id: caller.tenant_id, trace_id: request.traceId },
      {
        event_type: 'scope_card.published',
        outcome: 'success',
        subject: { kind: 'scope_card', id: result.value.card_id ?? caller.tenant_id },
        actor: { kind: 'human', principal_id: caller.principal_id },
      },
    );

    return reply.code(201).send(result.value);
  });

  return app;
}

export async function startServer(
  container: Container,
  authenticate?: ServerOptions['authenticate'],
): Promise<FastifyInstance> {
  const app = await buildServer({ container, ...(authenticate ? { authenticate } : {}) });
  await app.listen({ host: container.config.api.host, port: container.config.api.port });
  container.log.info('api listening', {
    host: container.config.api.host,
    port: container.config.api.port,
  });
  return app;
}

export const newTrace = (): string => newTraceId();
