# Local development environment.
#
# Every value here is a DEV-ONLY placeholder. `INFISICAL_RESOLVER_ENABLED=false`
# selects the EnvSecretProvider, which reads a secret by the NAME in its handle
# — so for local work the variables below hold raw values rather than handles.
#
# The provider refuses to run at all when DEPLOY_ENVIRONMENT=prod, so this file
# cannot accidentally become the production path.

$env:NODE_ENV = 'development'
$env:DEPLOY_ENVIRONMENT = 'dev'
$env:RESIDENCY_ZONE = 'my-central'
$env:PLATFORM_VERSION = '0.1.0'

$env:DATABASE_URL = 'postgresql://postgres:postgres@localhost:5460/eiaaw_fdw'
$env:DATABASE_SSL = 'false'

$env:INFISICAL_RESOLVER_ENABLED = 'false'

# Dev-only key material. Never reused anywhere else, and never in a deployment.
$env:AUDIT_CHAIN_ANCHOR_KEY = 'dev-only-anchor-key-do-not-reuse'
$env:KMS_MASTER_KEY = 'dev-only-kms-key-do-not-reuse'
$env:NONCE_SIGNING_KEY = 'dev-only-nonce-key-do-not-reuse'
$env:SESSION_SIGNING_KEY = 'dev-only-session-key-do-not-reuse'

# The canary must never appear in a prompt, a log line or a model response.
# The assurance harness sweeps for it (Phase 0 acceptance P0-7).
$env:SECRET_CANARY = 'EIAAW-CANARY-3f8b2d91c4a7'

$env:OBJECT_STORE_DRIVER = 'local'
$env:OBJECT_STORE_LOCAL_PATH = './.local-object-store'

$env:API_PORT = '3000'
$env:PUBLIC_API_URL = 'http://localhost:3000'
$env:PUBLIC_CONSOLE_URL = 'http://localhost:3001'

$env:LOG_LEVEL = 'debug'
$env:OBSERVABILITY_CONFORMANCE_STRICT = 'true'
$env:ASSURANCE_RELEASE_GATE_BLOCKING = 'true'

$env:WHATSAPP_BSP_DRIVER = 'stub'

Write-Host 'Development environment set.' -ForegroundColor Green
Write-Host "  DEPLOY_ENVIRONMENT = $env:DEPLOY_ENVIRONMENT (dry-run is FORCED for every state-changing tool)"
Write-Host "  DATABASE_URL       = $env:DATABASE_URL"
Write-Host "  API                = $env:PUBLIC_API_URL"
