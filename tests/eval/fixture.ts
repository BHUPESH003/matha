import * as fs from 'fs/promises'
import * as path from 'path'
import { CURRENT_SCHEMA_VERSION, componentToFilename } from '../../src/core/schema.js'

/**
 * Synthetic golden-set fixture: a fictional payment service brain plus
 * queries with expected record ids. This is the data the scoring constants
 * in retrieve/match.ts are tuned against — grow it before touching them.
 *
 * ponytail: one synthetic fixture brain. Add a dogfood-derived and a
 * field-eval-derived brain (target-architecture §3.1) once the dogfood
 * brain has accumulated enough real records to be worth freezing.
 */

/** Deterministic clock for recency decay: 2026-07-01. */
export const FIXED_NOW = Date.parse('2026-07-01T00:00:00Z')

const DECISIONS = [
  {
    id: 'd-retry-idempotency',
    timestamp: '2026-06-20T10:00:00Z',
    component: 'src/payments/retry.ts',
    previous_assumption: 'gateway retries are idempotent',
    correction: 'gateway double-charges on retry; every retry must reuse the idempotency key',
    trigger: 'test', confidence: 'confirmed', status: 'active', supersedes: null, session_id: 's1',
  },
  {
    id: 'd-session-ttl',
    timestamp: '2026-06-01T10:00:00Z',
    component: 'src/auth/session.ts',
    previous_assumption: 'session TTL is a fixed 24 hours',
    correction: 'TTL is 30 minutes sliding, extended on each authenticated request',
    trigger: 'test', confidence: 'probable', status: 'active', supersedes: null, session_id: 's2',
  },
  {
    id: 'd-invoice-rounding',
    timestamp: '2024-07-01T10:00:00Z', // two years old — decay floor case
    component: 'src/billing/invoice.ts',
    previous_assumption: 'invoice totals round per line item',
    correction: 'totals round once at invoice level, required by EU VAT rules',
    trigger: 'test', confidence: 'confirmed', status: 'active', supersedes: null, session_id: 's3',
  },
  {
    id: 'd-routes-auth',
    timestamp: '2026-05-15T10:00:00Z',
    component: 'src/api/routes.ts',
    previous_assumption: 'all routes require the auth middleware',
    correction: 'health and metrics endpoints are deliberately unauthenticated',
    trigger: 'test', confidence: 'probable', status: 'active', supersedes: null, session_id: 's4',
  },
  {
    id: 'd-uncertain-cache',
    timestamp: '2026-06-25T10:00:00Z',
    component: 'src/payments/gateway.ts',
    previous_assumption: 'gateway client performs no caching',
    correction: 'it may cache tokenization responses — unverified, treat with suspicion',
    trigger: 'test', confidence: 'uncertain', status: 'active', supersedes: null, session_id: 's5',
  },
  {
    id: 'd-config-boot',
    timestamp: '2026-04-10T10:00:00Z',
    component: 'configuration', // text-only component — lexical-match case
    previous_assumption: 'env vars are read at call time',
    correction: 'config is frozen at boot; an env var change needs a restart to take effect',
    trigger: 'test', confidence: 'probable', status: 'active', supersedes: null, session_id: 's6',
  },
  {
    id: 'd-retired',
    timestamp: '2026-06-28T10:00:00Z',
    component: 'src/payments/retry.ts',
    previous_assumption: 'this record is retired',
    correction: 'must never surface in any query',
    trigger: 'test', confidence: 'confirmed', status: 'retired', supersedes: null, session_id: 's7',
  },
]

const DANGER_ZONES = [
  {
    id: 'z-payments',
    component: 'src/payments/',
    pattern: 'retry storm',
    description: 'Retries here can double-charge customers if the gateway acknowledges late',
    confidence: 'confirmed',
  },
  {
    id: 'z-auth-session',
    component: 'src/auth/session.ts',
    pattern: 'key rotation',
    description: 'Session tokens are cached in-process; rotating the signing key without a restart invalidates nothing',
    confidence: 'confirmed',
  },
  {
    id: 'z-migrations',
    component: 'db/migrations/',
    pattern: 'non-idempotent migration',
    description: 'Migrations run in parallel on deploy; any non-idempotent migration corrupts staging',
    confidence: 'probable',
  },
  {
    id: 'z-webhooks',
    component: 'src/webhooks/handler.ts',
    pattern: 'slow ack',
    description: 'Webhook handler must ack within 5 seconds or the provider retries and duplicates events',
    confidence: 'confirmed',
  },
  {
    id: 'z-rate-limit',
    component: 'rate limiting', // concept-worded, no path — the embeddings-tripwire case
    pattern: 'per-pod counters',
    description: 'The rate limiter counts per pod, not per cluster — configured limits are multiplied by pod count',
    confidence: 'confirmed',
  },
]

const BOUNDARIES = [
  {
    id: 'b-ledger-schema',
    component: 'db/schema/',
    rule: 'Ledger schema changes require DBA sign-off — never edit generated schema files by hand',
    declaredBy: 'admin',
    created: '2024-01-01T00:00:00Z', // old on purpose: boundaries never decay
  },
]

const CONTRACTS = [
  {
    component: 'src/payments/retry.ts',
    version: 2,
    last_updated: '2026-06-20T10:00:00Z',
    assertions: [
      {
        id: 'a1',
        description: 'every retry carries the original idempotency key',
        type: 'invariant', status: 'active', violation_count: 2, last_violated: '2026-06-18T10:00:00Z',
      },
      {
        id: 'a2',
        description: 'max three attempts with exponential backoff',
        type: 'invariant', status: 'active', violation_count: 0, last_violated: null,
      },
    ],
  },
  {
    component: 'src/api/routes.ts',
    version: 1,
    last_updated: '2026-05-15T10:00:00Z',
    assertions: [
      {
        id: 'a3',
        description: 'all non-public routes pass through requireAuth',
        type: 'invariant', status: 'active', violation_count: 0, last_violated: null,
      },
    ],
  },
]

const STABILITY = [
  {
    filepath: 'src/core/ledger.ts',
    stability: 'frozen', confidence: 'high',
    reason: 'high connectivity, low churn — double-entry ledger core',
    classificationSource: 'derived',
    changeCount: 2, coChangeCount: 6, ageInDays: 700, daysSinceLastChange: 400,
  },
  {
    filepath: 'src/api/routes.ts',
    stability: 'stable', confidence: 'medium', reason: 'moderate churn',
    classificationSource: 'derived',
    changeCount: 12, coChangeCount: 3, ageInDays: 500, daysSinceLastChange: 30,
  },
  {
    filepath: 'src/payments/retry.ts',
    stability: 'volatile', confidence: 'high', reason: 'high recent churn',
    classificationSource: 'derived',
    changeCount: 30, coChangeCount: 4, ageInDays: 300, daysSinceLastChange: 3,
  },
]

const CO_CHANGES = [
  { fileA: 'src/payments/retry.ts', fileB: 'src/payments/gateway.ts', coChangeCount: 6 },
  { fileA: 'src/api/routes.ts', fileB: 'src/api/middleware.ts', coChangeCount: 4 },
  { fileA: 'src/core/ledger.ts', fileB: 'src/billing/invoice.ts', coChangeCount: 5 },
  { fileA: 'src/payments/retry.ts', fileB: 'src/jobs/reconcile.ts', coChangeCount: 8 },
]

export async function writeFixtureBrain(projectDir: string): Promise<string> {
  const mathaDir = path.join(projectDir, '.matha')
  await fs.mkdir(path.join(mathaDir, 'hippocampus', 'decisions'), { recursive: true })
  await fs.mkdir(path.join(mathaDir, 'cerebellum', 'contracts'), { recursive: true })
  await fs.mkdir(path.join(mathaDir, 'cortex'), { recursive: true })

  const write = (rel: string, data: unknown) =>
    fs.writeFile(path.join(mathaDir, rel), JSON.stringify(data, null, 2))

  await write('config.json', { schema_version: CURRENT_SCHEMA_VERSION })
  await write(path.join('hippocampus', 'intent.json'), {
    why: 'Fixture payment service: charge cards without ever double-charging a customer.',
  })
  await write(path.join('hippocampus', 'rules.json'), {
    rules: [
      'A customer is never charged twice for one order',
      'Ledger entries are append-only',
      'All amounts are integer minor units — never floats',
    ],
  })
  await write(path.join('hippocampus', 'danger-zones.json'), { zones: DANGER_ZONES })
  await write(path.join('hippocampus', 'boundaries.json'), { boundaries: BOUNDARIES })
  for (const d of DECISIONS) {
    await write(path.join('hippocampus', 'decisions', `${d.id}.json`), d)
  }
  for (const c of CONTRACTS) {
    await write(
      path.join('cerebellum', 'contracts', `${componentToFilename(c.component)}.json`),
      c,
    )
  }
  await write(path.join('cortex', 'stability.json'), STABILITY)
  await write(path.join('cortex', 'co-changes.json'), CO_CHANGES)
  return mathaDir
}

export interface GoldenQuery {
  name: string
  scope: string
  intent: string
  filepaths?: string[]
  /** Record ids that must appear in the top 5 results. */
  expect: string[]
  /** Record ids allowed to be CRITICAL — any other critical is a false critical. */
  expectCritical: string[]
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    name: 'exact file in danger dir with violated contract',
    scope: 'src/payments/retry.ts',
    intent: 'change the retry logic',
    expect: ['z-payments', 'd-retry-idempotency', 'contract:src/payments/retry.ts'],
    expectCritical: ['z-payments', 'contract:src/payments/retry.ts'],
  },
  {
    name: 'directory scope pulls everything under it',
    scope: 'src/payments/',
    intent: 'refactor the payment module',
    expect: ['z-payments', 'd-retry-idempotency', 'contract:src/payments/retry.ts', 'd-uncertain-cache'],
    expectCritical: ['z-payments', 'contract:src/payments/retry.ts'],
  },
  {
    name: 'file inside danger dir, via filepaths',
    scope: 'src/payments/gateway.ts',
    intent: 'add tokenization support',
    filepaths: ['src/payments/gateway.ts'],
    expect: ['z-payments', 'd-uncertain-cache'],
    expectCritical: ['z-payments'],
  },
  {
    name: 'exact file danger zone plus its decision',
    scope: 'src/auth/session.ts',
    intent: 'rotate the signing keys',
    expect: ['z-auth-session', 'd-session-ttl'],
    expectCritical: ['z-auth-session'],
  },
  {
    name: 'parent dir of a file-scoped zone',
    scope: 'src/auth/',
    intent: 'audit the auth flows',
    expect: ['z-auth-session', 'd-session-ttl'],
    expectCritical: ['z-auth-session'],
  },
  {
    name: 'new file under a dir-scoped zone',
    scope: 'db/migrations/20260701_add_index.sql',
    intent: 'add an index migration',
    expect: ['z-migrations'],
    expectCritical: ['z-migrations'],
  },
  {
    name: 'dir-scoped zone matched by its own dir',
    scope: 'db/migrations/',
    intent: 'squash old migrations',
    expect: ['z-migrations'],
    expectCritical: ['z-migrations'],
  },
  {
    name: 'exact file zone',
    scope: 'src/webhooks/handler.ts',
    intent: 'add a new event type',
    expect: ['z-webhooks'],
    expectCritical: ['z-webhooks'],
  },
  {
    name: 'sibling of a file zone warns but is not critical',
    scope: 'src/webhooks/parser.ts',
    intent: 'parse the new payload format',
    expect: ['z-webhooks'],
    expectCritical: [],
  },
  {
    name: 'frozen file direct hit',
    scope: 'src/core/ledger.ts',
    intent: 'fix rounding in the ledger',
    expect: ['frozen:src/core/ledger.ts'],
    expectCritical: ['frozen:src/core/ledger.ts'],
  },
  {
    name: 'frozen file via its directory',
    scope: 'src/core/',
    intent: 'reorganise the core module',
    expect: ['frozen:src/core/ledger.ts'],
    expectCritical: ['frozen:src/core/ledger.ts'],
  },
  {
    name: 'sibling of a frozen file must not fire at all',
    scope: 'src/core/utils.ts',
    intent: 'add a small helper',
    expect: [],
    expectCritical: [],
  },
  {
    name: 'unrelated file surfaces nothing',
    scope: 'docs/readme-update.md',
    intent: 'update the documentation',
    expect: [],
    expectCritical: [],
  },
  {
    name: 'unrelated file with generic intent surfaces nothing',
    scope: 'scripts/deploy.sh',
    intent: 'improve performance and fix errors',
    expect: [],
    expectCritical: [],
  },
  {
    name: 'concept-worded zone found by intent wording (lexical)',
    scope: 'src/middleware/throttle.ts',
    intent: 'tune rate limiting for burst traffic',
    expect: ['z-rate-limit'],
    expectCritical: [],
  },
  {
    name: 'concept-worded decision found by intent wording (lexical)',
    scope: 'src/config/loader.ts',
    intent: 'env var change has no effect until restart',
    expect: ['d-config-boot'],
    expectCritical: [],
  },
  {
    name: 'co-change expansion: reconcile job pulls payment records',
    scope: 'src/jobs/reconcile.ts',
    intent: 'nightly reconciliation of settled payments',
    expect: ['z-payments', 'd-retry-idempotency'],
    expectCritical: [],
  },
  {
    name: 'two-year-old decision still reachable on exact path',
    scope: 'src/billing/invoice.ts',
    intent: 'adjust invoice rounding',
    expect: ['d-invoice-rounding'],
    expectCritical: [],
  },
  {
    name: 'clean contract shows as info alongside decision',
    scope: 'src/api/routes.ts',
    intent: 'add a public status endpoint',
    expect: ['d-routes-auth', 'contract:src/api/routes.ts'],
    expectCritical: [],
  },
  {
    name: 'sibling in api dir picks up routes records softly',
    scope: 'src/api/middleware.ts',
    intent: 'tighten the auth middleware ordering',
    expect: ['d-routes-auth'],
    expectCritical: [],
  },
  {
    name: 'multi-file scope, top five are exactly the relevant five',
    scope: 'src/payments/retry.ts, src/auth/session.ts',
    intent: 'harden retry and session handling',
    filepaths: ['src/payments/retry.ts', 'src/auth/session.ts'],
    expect: ['z-payments', 'z-auth-session', 'contract:src/payments/retry.ts', 'd-retry-idempotency', 'd-session-ttl'],
    expectCritical: ['z-payments', 'z-auth-session', 'contract:src/payments/retry.ts'],
  },
  {
    name: 'intent-only query (no paths) surfaces lexical matches, never criticals',
    scope: '',
    intent: 'customers report being double charged on payment retry',
    expect: ['z-payments', 'd-retry-idempotency'],
    expectCritical: [],
  },
  {
    name: 'deep new file under a zone dir',
    scope: 'src/payments/providers/stripe.ts',
    intent: 'add a stripe provider',
    expect: ['z-payments'],
    expectCritical: ['z-payments'],
  },
  {
    name: 'declared boundary fires critical on a file under its dir, despite age',
    scope: 'db/schema/ledger.sql',
    intent: 'add a column to the ledger table',
    expect: ['b-ledger-schema'],
    expectCritical: ['b-ledger-schema'],
  },
  {
    name: 'boundary wording in the intent alone never fires the boundary',
    scope: 'src/api/routes.ts',
    intent: 'does the ledger schema need DBA sign-off?',
    expect: ['d-routes-auth', 'contract:src/api/routes.ts'],
    expectCritical: [],
  },
  {
    name: 'retired decision never surfaces',
    scope: 'src/payments/retry.ts',
    intent: 'check retired records stay dead',
    expect: ['z-payments'],
    expectCritical: ['z-payments', 'contract:src/payments/retry.ts'],
  },
]
