import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  createModKitServer,
  memoryStore,
  openAIClassifier,
  runConformanceSuite,
  staticTokens,
  supabaseJwt,
  supabaseStorage,
  type ModKitAlertEvent,
  type ModKitNotifier,
} from '../dist/index.js'

function createHs256Jwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url')
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${b64Header}.${b64Payload}`
  const sig = createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url')
  return `${signingInput}.${sig}`
}

test('createModKitServer passes full /v1 conformance suite at /functions/v1/modkit prefix', async () => {
  const store = memoryStore()
  const events: ModKitAlertEvent[] = []
  const testNotifier: ModKitNotifier = {
    name: 'test-sink',
    async notify(event) {
      events.push(event)
    },
  }

  const handler = createModKitServer({
    store,
    authenticate: staticTokens({
      'token-alice': '2ae6284c-246d-4c35-bc08-7936ee643e19',
      'token-bob': '99999999-0000-0000-0000-000000000002',
    }),
    webhookSecret: 'whsec-super-secret',
    notifier: testNotifier,
    classifier: openAIClassifier({
      apiKey: 'sk-test',
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              flagged: false,
              categories: { sexual: false, violence: false },
              category_scores: { sexual: 0.001, violence: 0.002 },
            },
          ],
        }),
    }),
  })

  const suite = await runConformanceSuite({
    baseUrl: 'https://example.supabase.co/functions/v1/modkit',
    userAToken: 'token-alice',
    userBToken: 'token-bob',
    webhookSecret: 'whsec-super-secret',
    fetch: async (input, init) => handler(new Request(input, init)),
  })

  assert.equal(
    suite.ok,
    true,
    `Conformance failed: ${JSON.stringify(suite.steps.filter((s) => !s.ok))}`,
  )
  assert.equal(suite.steps.length, 7)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind, 'report_submitted')
})

test('supabaseJwt verifies HS256 and ES256 JWKS tokens and rejects expired/invalid tokens', async () => {
  const now = new Date('2026-11-08T01:30:00.000Z')
  const nowSec = Math.floor(now.getTime() / 1000)
  const secret = 'supabase-jwt-secret-key-for-unit-test'

  // Also generate an ES256 keypair via Web Crypto for JWKS verification
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

  const auth = supabaseJwt({
    jwksUrl: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
    secret,
    now: () => now,
    fetchImpl: async () =>
      Response.json({
        keys: [{ ...publicJwk, kid: 'key-es256-1', alg: 'ES256', kty: 'EC' }],
      }),
  })

  // 1. Valid HS256 token
  const validHs256 = createHs256Jwt(
    {
      sub: 'user-hs256',
      email: 'alice@trashapp.cc',
      aud: 'authenticated',
      iss: 'https://example.supabase.co/auth/v1',
      exp: nowSec + 3600,
    },
    secret,
  )
  const principalHs = await auth(
    new Request('https://example.com/v1/state', {
      headers: { authorization: `Bearer ${validHs256}` },
    }),
  )
  assert.deepEqual(principalHs, {
    userId: 'user-hs256',
    email: 'alice@trashapp.cc',
  })

  // 2. Expired HS256 token -> null
  const expiredHs256 = createHs256Jwt(
    {
      sub: 'user-hs256',
      aud: 'authenticated',
      iss: 'https://example.supabase.co/auth/v1',
      exp: nowSec - 10,
    },
    secret,
  )
  const expiredPrincipal = await auth(
    new Request('https://example.com/v1/state', {
      headers: { authorization: `Bearer ${expiredHs256}` },
    }),
  )
  assert.equal(expiredPrincipal, null)

  // 3. Valid ES256 token signed with Web Crypto
  const esHeader = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: 'key-es256-1', typ: 'JWT' }),
  ).toString('base64url')
  const esPayload = Buffer.from(
    JSON.stringify({
      sub: 'user-es256',
      email: 'bob@trashapp.cc',
      aud: 'authenticated',
      iss: 'https://example.supabase.co/auth/v1',
      exp: nowSec + 3600,
    }),
  ).toString('base64url')
  const esSigningInput = `${esHeader}.${esPayload}`
  const esSigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(esSigningInput),
  )
  const validEs256 = `${esSigningInput}.${Buffer.from(esSigBuf).toString('base64url')}`

  const principalEs = await auth(
    new Request('https://example.com/v1/state', {
      headers: { authorization: `Bearer ${validEs256}` },
    }),
  )
  assert.deepEqual(principalEs, {
    userId: 'user-es256',
    email: 'bob@trashapp.cc',
  })
})

test('POST /v1/webhooks/content extracts storage images, classifies flagged content as rejected, and fires notifier', async () => {
  const store = memoryStore()
  const alerts: ModKitAlertEvent[] = []

  const storage = supabaseStorage({
    url: 'https://example.supabase.co',
    serviceRoleKey: 'srv-key',
    bucket: 'trash-pickup-images',
    fetchImpl: async (input) => {
      const urlStr = String(input)
      const key = urlStr.split('/trash-pickup-images/')[1]
      return Response.json({
        signedURL: `/object/sign/trash-pickup-images/${key}?token=signed`,
      })
    },
  })

  const classifiedUrls: string[] = []
  const handler = createModKitServer({
    store,
    authenticate: staticTokens({}),
    webhookSecret: 'whsec-123',
    notifier: {
      name: 'alert-catcher',
      async notify(event) {
        alerts.push(event)
      },
    },
    classifier: {
      name: 'mock-openai',
      async classify(input) {
        classifiedUrls.push(...(input.imageUrls ?? []))
        return {
          provider: 'openai',
          flagged: true,
          categories: { sexual: true },
          scores: { sexual: 0.99 },
        }
      },
    },
    contentExtractor: async (payload) => {
      const row = payload.record
      const keys = [row.before_photo_key, row.after_photo_key].filter(Boolean) as string[]
      const imageUrls = await Promise.all(keys.map((k) => storage.createSignedReadUrl(k, 300)))
      return {
        targetType: 'trash_pickup',
        targetId: String(row.id),
        authorId: String(row.user_id),
        text: typeof row.description === 'string' ? row.description : '',
        imageUrls,
      }
    },
  })

  const res = await handler(
    new Request('https://example.supabase.co/functions/v1/modkit/v1/webhooks/content', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-modkit-webhook-secret': 'whsec-123',
      },
      body: JSON.stringify({
        type: 'INSERT',
        table: 'trash_pickups',
        schema: 'public',
        record: {
          id: 'df039bb9-4651-4cfa-9039-5667513802b6',
          user_id: 'bad-actor-id',
          description: 'Bad pickup',
          before_photo_key: 'bad-actor-id/before.jpg',
          after_photo_key: 'bad-actor-id/after.jpg',
        },
      }),
    }),
  )

  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    target_type: string
    target_id: string
    status: string
    flagged: boolean
  }
  assert.deepEqual(body, {
    target_type: 'trash_pickup',
    target_id: 'df039bb9-4651-4cfa-9039-5667513802b6',
    status: 'rejected',
    flagged: true,
  })
  assert.equal(classifiedUrls.length, 2)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.kind, 'content_rejected')

  const storedItem = await store.getItem('trash_pickup', 'df039bb9-4651-4cfa-9039-5667513802b6')
  assert.equal(storedItem?.status, 'rejected')
  assert.deepEqual(storedItem?.classifier_categories, { sexual: true })
})
