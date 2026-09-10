/**
 * Generate the five crypto secrets the finance digital worker needs.
 *
 * Run this yourself and copy the values straight into the Infisical UI. The
 * values are printed to YOUR terminal and go nowhere else — do not paste them
 * into a chat message, a commit, a screenshot, or an agent session. That is the
 * same rule the deploy contract applies to every other secret; these are new
 * key material, which makes it more important, not less.
 *
 *   node scripts/generate-crypto-keys.mjs
 *
 * Each key is 32 bytes from the platform CSPRNG, base64-encoded. Generate once,
 * install once. Re-running produces different keys: if you install a second set
 * over the first, every audit anchor signed under the old AUDIT_CHAIN_ANCHOR_KEY
 * stops verifying (see docs/DEPLOY.md on key_epoch before rotating anything).
 */
import { randomBytes } from 'node:crypto';

/** The four keys that are pure random material. */
const KEYS = [
  ['AUDIT_CHAIN_ANCHOR_KEY', 'signs hourly anchors of the immutable audit hash chain'],
  ['KMS_MASTER_KEY', 'derives every tenant-scoped field encryption key'],
  ['NONCE_SIGNING_KEY', 'binds an approval nonce to a hand-off and a bundle version'],
  ['SESSION_SIGNING_KEY', 'signs console sessions'],
];

const line = (n = 74) => '-'.repeat(n);

console.log('');
console.log(line());
console.log('  Infisical  ›  eiaaw-all-projects  ›  Production  ›  (workspace root)');
console.log(line());
console.log('');

for (const [name, purpose] of KEYS) {
  console.log(`# ${purpose}`);
  console.log(`${name}`);
  console.log(`${randomBytes(32).toString('base64')}`);
  console.log('');
}

/**
 * The canary is a sentinel, not a credential. Assurance case P0-7 asserts it
 * never appears in a prompt or a log line, so its value has to be something you
 * can grep for with no false positives — random base64 would be lost in noise.
 */
console.log('# sentinel: P0-7 asserts this never reaches a prompt or a log line');
console.log('SECRET_CANARY');
console.log(`EIAAW-CANARY-${randomBytes(8).toString('hex').toUpperCase()}-DO-NOT-LOG`);
console.log('');

console.log(line());
console.log('  Five values above. Paste each into Infisical, then close this terminal.');
console.log('  They are not written to disk and are not recoverable after that.');
console.log(line());
console.log('');
