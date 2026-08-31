#!/usr/bin/env tsx
/**
 * The L8 release gate, wired to CI — file 08 s.11.11.
 *
 * Exit code 1 on a failing gate. That is the whole point: DWD-06 s.14 lists
 * "a go-live with the release gate advisory rather than blocking" as a red
 * flag, and an exit code is the only form of "blocking" a CI runner respects.
 *
 * Flags:
 *   --gate          evaluate the release gate and exit non-zero on failure
 *   --suite <name>  run one suite
 *   --prove-gate    inject a deliberately failing case (Phase 0 acceptance P0-4)
 *   --json <path>   write the full run report
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_THRESHOLDS,
  evaluateReleaseGate,
  formatRun,
  runSuites,
  type SuiteName,
} from './harness.js';
import { CANARY_FAILURE, PHASE_0_SUITES } from './suites.js';

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value?.startsWith('--') ? undefined : value;
}

async function main(): Promise<void> {
  const isGate = process.argv.includes('--gate');
  const proveGate = process.argv.includes('--prove-gate');
  const suite = flagValue('suite') as SuiteName | undefined;

  const cases = proveGate ? [...PHASE_0_SUITES, CANARY_FAILURE] : PHASE_0_SUITES;

  const run = await runSuites(cases, suite ? { filter: suite } : {});

  // s.14: blocking by default. Making it advisory requires an explicit opt-out
  // that shows up in a config diff.
  const blocking = process.env['ASSURANCE_RELEASE_GATE_BLOCKING'] !== 'false';
  const gate = evaluateReleaseGate(run, DEFAULT_THRESHOLDS, blocking);

  console.log(formatRun(run, gate));

  const outputPath =
    flagValue('json') ??
    join(process.env['ASSURANCE_RUN_OUTPUT_PATH'] ?? './assurance-runs', `${run.run_id}.json`);
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify({ run, gate }, null, 2), 'utf8');
    console.log(`  report written to ${outputPath}\n`);
  } catch {
    // A report we could not write must not turn a passing gate into a failure.
  }

  if (proveGate) {
    // Inverted: the canary run PROVES the gate works by failing.
    if (gate.decision === 'fail') {
      console.log('  ✔ P0-4 satisfied: the gate blocked a deliberately broken change.\n');
      process.exit(0);
    }
    console.error('  ✖ P0-4 FAILED: the canary case did not block the gate.\n');
    process.exit(1);
  }

  if (isGate && gate.decision === 'fail' && blocking) process.exit(1);
  process.exit(0);
}

void main();
