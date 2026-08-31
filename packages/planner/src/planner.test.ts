import { describe, expect, it } from 'vitest';
import type { TaskNode } from '@eiaaw/contracts';
import { assertIrreversibleOrdering } from './planner.js';

const node = (overrides: Partial<TaskNode> & { node_id: string }): TaskNode => ({
  schema_version: '1.0.0',
  graph_id: 'tg_0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60',
  kind: 'tool_call',
  label: 'test',
  owner: { kind: 'tool', ref: 'TL-ERPW-02' },
  depends_on: [],
  sequence_rank: 50,
  state: 'pending',
  state_changing: false,
  irreversible: false,
  dry_run: true,
  attempt: 0,
  max_attempts: 3,
  started_at: null,
  ended_at: null,
  failure: null,
  ...overrides,
});

// DWD-06 s.9.6 / file 05 s.13. The constraint exists so that when an
// irreversible act runs, everything before it can still be undone.
describe('the irreversible-step ordering constraint', () => {
  it('accepts a graph with no irreversible node', () => {
    expect(
      assertIrreversibleOrdering([
        node({ node_id: 'n1', state_changing: true, sequence_rank: 60 }),
        node({ node_id: 'n2', state_changing: true, sequence_rank: 60 }),
      ]),
    ).toBeNull();
  });

  it('accepts a graph with no reversible write', () => {
    expect(
      assertIrreversibleOrdering([
        node({ node_id: 'n1', state_changing: true, irreversible: true, sequence_rank: 900 }),
      ]),
    ).toBeNull();
  });

  it('accepts an irreversible node ranked after every reversible write', () => {
    expect(
      assertIrreversibleOrdering([
        node({ node_id: 'n1', state_changing: true, sequence_rank: 60 }),
        node({ node_id: 'n2', state_changing: true, sequence_rank: 60 }),
        node({ node_id: 'n3', state_changing: true, irreversible: true, sequence_rank: 900 }),
      ]),
    ).toBeNull();
  });

  it('rejects an irreversible node that would run before a reversible write', () => {
    const problem = assertIrreversibleOrdering([
      node({ node_id: 'n1', state_changing: true, irreversible: true, sequence_rank: 40 }),
      node({ node_id: 'n2', state_changing: true, sequence_rank: 60 }),
    ]);

    expect(problem).not.toBeNull();
    expect(problem).toMatch(/n1 is irreversible/);
    // The explanation states the reason, not just the rule: everything before
    // an irreversible act must still be compensatable when it runs.
    expect(problem).toMatch(/so everything before it can still be compensated/);
  });

  it('rejects an irreversible node tied with a reversible write', () => {
    // Equal ranks give no ordering guarantee, which is the same defect.
    expect(
      assertIrreversibleOrdering([
        node({ node_id: 'n1', state_changing: true, irreversible: true, sequence_rank: 60 }),
        node({ node_id: 'n2', state_changing: true, sequence_rank: 60 }),
      ]),
    ).not.toBeNull();
  });

  it('ignores read-only nodes when computing the boundary', () => {
    // A read ranked above an irreversible write is fine: there is nothing to
    // compensate for a read.
    expect(
      assertIrreversibleOrdering([
        node({ node_id: 'n1', state_changing: false, sequence_rank: 950 }),
        node({ node_id: 'n2', state_changing: true, irreversible: true, sequence_rank: 900 }),
      ]),
    ).toBeNull();
  });
});
