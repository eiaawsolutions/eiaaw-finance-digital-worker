#!/usr/bin/env tsx
/**
 * Secret scanner run at the commit boundary by lefthook.
 *
 * EIAAW Deploy Contract: no non-bootstrap secret value ever enters history.
 * This catches the common shapes before the commit exists, which is the only
 * point at which removal is cheap — a secret in history is a rotation event,
 * not a `git rm`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly description: string;
}

const RULES: readonly Rule[] = [
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, description: 'Anthropic API key' },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/, description: 'OpenAI API key' },
  {
    id: 'stripe-live',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/,
    description: 'Stripe live key',
  },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/, description: 'AWS access key id' },
  { id: 'github-pat', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/, description: 'GitHub token' },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, description: 'Slack token' },
  {
    id: 'telegram-bot-token',
    pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,
    description: 'Telegram bot token',
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    description: 'PEM private key block',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    description: 'JWT (may embed a live claim set)',
  },
  {
    id: 'postgres-url-with-password',
    pattern: /\bpostgres(?:ql)?:\/\/[^:\s]+:(?!postgres@)[^@\s]{8,}@/,
    description: 'Postgres URL with an embedded password',
  },
];

/**
 * A `secret://` handle is the *correct* shape and must never be flagged, even
 * though it sits where a secret would. Likewise the documented placeholders.
 */
const ALLOW = [
  /secret:\/\//,
  /\bsk-ant-\.\.\./,
  /\bsk_live_\.\.\./,
  /<[A-Za-z0-9_ -]+>/,
  /EXAMPLE|PLACEHOLDER|REDACTED|xxxx/i,
];

const SKIP_PATHS = /(?:^|[\\/])(?:node_modules|dist|coverage|\.next|pnpm-lock\.yaml)(?:[\\/]|$)/;
const MAX_BYTES = 2_000_000;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly description: string;
  readonly excerpt: string;
}

function scanFile(file: string): Finding[] {
  let contents: string;
  try {
    if (statSync(file).size > MAX_BYTES) return [];
    contents = readFileSync(file, 'utf8');
  } catch {
    return []; // deleted in this commit, or binary
  }

  const findings: Finding[] = [];
  const lines = contents.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (ALLOW.some((allowed) => allowed.test(line))) return;
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      findings.push({
        file,
        line: index + 1,
        ruleId: rule.id,
        description: rule.description,
        // Never echo the whole match — the scanner's own output must not leak it.
        excerpt: `${match[0].slice(0, 8)}…${match[0].length} chars`,
      });
    }
  });

  return findings;
}

/**
 * Ask git for the file list rather than taking it as arguments.
 *
 * A large commit passes more paths than a Windows command line can hold, and
 * the failure mode is the hook erroring out — which, on a scanner whose whole
 * job is to block, is the worst possible way to fail. Enumerating here also
 * means the definition of "staged" is git's rather than the caller's.
 */
function filesFromGit(mode: 'staged' | 'all'): string[] {
  const args =
    mode === 'all'
      ? ['ls-files', '-z']
      : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];

  const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f !== '');
}

function main(): void {
  const args = process.argv.slice(2);
  const scanAll = args.includes('--all');
  const explicit = args.filter((a) => !a.startsWith('--'));

  const candidates = explicit.length > 0 ? explicit : filesFromGit(scanAll ? 'all' : 'staged');
  const files = candidates.filter((f) => !SKIP_PATHS.test(f));

  if (files.length === 0) {
    console.log('Secret scan: nothing to scan.');
    process.exit(0);
  }

  const findings = files.flatMap(scanFile);
  if (findings.length === 0) {
    console.log(`Secret scan: ${files.length} file(s) clean.`);
    process.exit(0);
  }

  console.error('\n✖ Secret scan failed — commit blocked.\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.ruleId}] ${f.description}  (${f.excerpt})`);
  }
  console.error(
    '\nEIAAW Deploy Contract: every non-bootstrap secret lives in Infisical and is\n' +
      'referenced as secret://<project>/<env>/<path>/<NAME>. Move the value into\n' +
      'Infisical, replace it with a handle, and commit again.\n' +
      '\nIf this is a false positive, widen the ALLOW list in scripts/scan-secrets.ts\n' +
      'rather than bypassing the hook.\n',
  );
  process.exit(1);
}

main();
