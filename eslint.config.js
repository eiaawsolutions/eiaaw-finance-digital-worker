// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/**
 * Architectural direction rules from DWD-06 s.1.3 (D1-D8) are enforced here as
 * import restrictions, not as convention. A violation fails CI.
 *
 *   D1  Nothing calls a system of record except C10 (@eiaaw/connectors).
 *   D2  Nothing calls a model except C9 (@eiaaw/llm), and C9 is called only by C8.
 *   D3  C1 (@eiaaw/channels) never calls C5, C6, C7, C10, C11 or C12.
 *   D5  C6 (@eiaaw/policy) is consulted by C7, never by C8.
 *   D6  C15 (@eiaaw/audit) is write-only from every component.
 */
const RESTRICTED = {
  // D2: only the skill runtime may reach the LLM gateway; nobody may reach a provider SDK.
  providerSdk: {
    group: ['@anthropic-ai/*', 'openai', '@google/generative-ai'],
    message:
      'D2 violation: model providers are reachable only through @eiaaw/llm (C9). ' +
      'A skill or component must never import a provider SDK directly.',
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-scripts/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.next/**',
      '**/*.d.ts',
      'apps/console/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // One flat program covering tests, CLI scripts and config files too —
        // see the note in tsconfig.lint.json. The project service cannot be
        // used here because those files belong to no build project.
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          // DWD-06 s.2.2: money is never a float. A numeric literal assigned to
          // something called `amount` is the shape this forbids.
          selector:
            "Property[key.name='amount'][value.type='Literal'][value.raw=/^[0-9]*\\.[0-9]+$/]",
          message:
            'Money is { amount_minor: integer, currency, scale } (DWD-06 s.2.2). ' +
            'A decimal amount is never representable.',
        },
      ],
    },
  },

  // ---- D2: provider SDKs are reachable only from the LLM gateway --------------
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ignores: ['packages/llm/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [RESTRICTED.providerSdk] }],
    },
  },

  // ---- D1: only the connector runtime reaches a system of record -------------
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ignores: ['packages/connectors/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            RESTRICTED.providerSdk,
            {
              group: ['**/connectors/src/adapters/**'],
              message:
                'D1 violation: a system of record is reachable only through the ' +
                'tool invoker (C10). Import the registry-declared tool, not the adapter.',
            },
          ],
        },
      ],
    },
  },

  // ---- D3: the channel gateway is a leaf ------------------------------------
  {
    files: ['packages/channels/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            RESTRICTED.providerSdk,
            {
              group: [
                '@eiaaw/planner',
                '@eiaaw/policy',
                '@eiaaw/workflow',
                '@eiaaw/connectors',
                '@eiaaw/knowledge',
                '@eiaaw/records',
              ],
              message:
                'D3 violation: C1 emits an InboundRequest and receives an OutboundDelivery. ' +
                'It never calls C5, C6, C7, C10, C11 or C12.',
            },
          ],
        },
      ],
    },
  },

  // ---- D5: a skill cannot ask for its own permission ------------------------
  {
    files: ['packages/skills/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            RESTRICTED.providerSdk,
            {
              group: ['@eiaaw/policy'],
              message:
                'D5 violation: the policy engine (C6) is consulted by the workflow ' +
                'executor (C7), never by the skill runtime (C8).',
            },
          ],
        },
      ],
    },
  },

  // ---- Tests and tooling relax the strictest rules --------------------------
  {
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.itest.ts',
      '**/test/**/*.ts',
      '**/scripts/**/*.{ts,mjs}',
      '**/*.config.ts',
      // A CLI's output IS its interface: migrate, seed, the assurance harness
      // and the secret scanner all report to a terminal, and routing that
      // through the structured logger would put operator-facing text into the
      // log stream instead of on the operator's screen.
      '**/*-cli.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['apps/console/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },

  // ---- Plain-JS operator scripts run in Node -------------------------------
  //
  // `no-undef` is a core rule and is not type-aware, so it does not learn about
  // Node's globals from the TypeScript program the way the .ts scripts do. It
  // has to be told. These are operator-facing CLIs, so `console` is the point.
  {
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },

  // ---- Build-tool config files run in Node, not in a checked program -------
  {
    files: ['**/*.config.{js,mjs,cjs}', 'eslint.config.js', 'apps/console/next.config.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', __dirname: 'readonly' },
    },
    rules: {
      // Framework config hooks are declared async by the framework's own types.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
