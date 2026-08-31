export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        // packages, named by the component they implement
        'core',
        'contracts',
        'telemetry',
        'db',
        'audit', // C15
        'config', // C16
        'identity', // C2
        'context', // C3
        'intake', // C4
        'planner', // C5
        'policy', // C6
        'workflow', // C7
        'skills', // C8
        'llm', // C9
        'connectors', // C10
        'knowledge', // C11
        'records', // C12
        'assurance', // C13
        'delivery', // C14
        'channels', // C1
        'authorisation', // L9
        // apps
        'api',
        'worker',
        'console',
        // cross-cutting
        'deps',
        'ci',
        'docs',
        'deploy',
        'repo',
      ],
    ],
    'body-max-line-length': [1, 'always', 100],
  },
};
