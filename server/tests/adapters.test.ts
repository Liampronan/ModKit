import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  ModKitError,
  emailNotifier,
  memoryStore,
  openAIClassifier,
  postgresStore,
  rekognitionClassifier,
  slackNotifier,
  supabaseStorage,
  type ModKitStore,
} from '../dist/index.js'

const execFileAsync = promisify(execFile)

async function runStoreContractTests(store: ModKitStore): Promise<void> {
  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'

  // Initial state is empty
  const initialState = await store.getUserState(userA)
  assert.deepEqual(initialState, {
    user_id: userA,
    accepted_terms_versions: [],
    blocked_user_ids: [],
    hidden_items: [],
  })

  // Terms acceptance is idempotent and preserves first accepted_at
  const t1 = new Date('2026-11-08T01:00:00.000Z')
  const t2 = new Date('2026-11-08T02:00:00.000Z')
  const accepted1 = await store.acceptTerms({
    userId: userA,
    termsVersion: '2026-11-01',
    now: t1,
  })
  assert.equal(accepted1.user_id, userA)
  assert.equal(accepted1.terms_version, '2026-11-01')
  assert.equal(accepted1.accepted_at, t1.toISOString())

  const acceptedAgain = await store.acceptTerms({
    userId: userA,
    termsVersion: '2026-11-01',
    now: t2,
  })
  assert.equal(acceptedAgain.accepted_at, t1.toISOString())

  // Blocking and self-block rejection
  await assert.rejects(
    () => store.blockUser({ blockerId: userA, blockedUserId: userA }),
    (err: unknown) => err instanceof ModKitError && err.code === 'self_block_forbidden',
  )

  const blockRecord = await store.blockUser({
    blockerId: userA,
    blockedUserId: userB,
    now: t1,
  })
  assert.equal(blockRecord.blocker_id, userA)
  assert.equal(blockRecord.blocked_user_id, userB)

  // Submitting report creates hidden_items entry and auto-flags item
  const report = await store.createReport({
    reporterId: userA,
    targetType: 'trash_pickup',
    targetId: 'pickup-101',
    targetAuthorId: userB,
    reason: 'objectionable',
    details: 'Inappropriate photo',
    now: t1,
  })
  assert.equal(report.status, 'open')
  assert.equal(report.reason, 'objectionable')

  const itemAfterReport = await store.getItem('trash_pickup', 'pickup-101')
  assert.ok(itemAfterReport)
  assert.equal(itemAfterReport.status, 'flagged')
  assert.equal(itemAfterReport.author_id, userB)

  const stateAfterActions = await store.getUserState(userA)
  assert.deepEqual(stateAfterActions, {
    user_id: userA,
    accepted_terms_versions: ['2026-11-01'],
    blocked_user_ids: [userB],
    hidden_items: [{ target_type: 'trash_pickup', target_id: 'pickup-101' }],
  })

  // Unblock removes userB from blocked_user_ids
  await store.unblockUser({ blockerId: userA, blockedUserId: userB })
  const stateAfterUnblock = await store.getUserState(userA)
  assert.deepEqual(stateAfterUnblock.blocked_user_ids, [])

  // Dismissing a flagged report restores item status to approved
  const dismissed = await store.resolveReport({
    reportId: report.id,
    action: 'dismiss',
    note: 'False alarm',
    resolvedBy: 'admin-1',
    now: t2,
  })
  assert.ok(dismissed)
  assert.equal(dismissed.status, 'dismissed')
  assert.equal(dismissed.resolution_note, 'False alarm')
  const itemAfterDismiss = await store.getItem('trash_pickup', 'pickup-101')
  assert.equal(itemAfterDismiss?.status, 'approved')

  // Resolving a report with 'ban' marks item rejected and bans the author
  const report2 = await store.createReport({
    reporterId: userA,
    targetType: 'trash_pickup',
    targetId: 'pickup-202',
    targetAuthorId: userC,
    reason: 'harassment',
    now: t2,
  })
  const openReports = await store.listReports({ status: 'open' })
  assert.equal(openReports.length, 1)
  assert.equal(openReports[0]?.id, report2.id)

  const bannedReport = await store.resolveReport({
    reportId: report2.id,
    action: 'ban',
    note: 'Severe violation',
    resolvedBy: 'admin-1',
    now: t2,
  })
  assert.equal(bannedReport?.status, 'actioned')
  assert.equal((await store.getItem('trash_pickup', 'pickup-202'))?.status, 'rejected')
  assert.equal(await store.isBanned(userC, t2), true)

  const bans = await store.listBans()
  assert.equal(bans.length, 1)
  assert.equal(bans[0]?.user_id, userC)

  assert.equal(await store.removeBan(userC), true)
  assert.equal(await store.isBanned(userC, t2), false)

  // Upserting classifier item scores and categories
  const classifiedItem = await store.upsertItem({
    targetType: 'trash_pickup',
    targetId: 'pickup-303',
    authorId: userB,
    status: 'rejected',
    classifierProvider: 'openai',
    classifierCategories: { sexual: true, violence: false },
    classifierScores: { sexual: 0.98, violence: 0.01 },
    now: t2,
  })
  assert.equal(classifiedItem.status, 'rejected')
  assert.equal(classifiedItem.classifier_provider, 'openai')
  assert.deepEqual(classifiedItem.classifier_categories, { sexual: true, violence: false })
  assert.deepEqual(classifiedItem.classifier_scores, { sexual: 0.98, violence: 0.01 })
}

test('memoryStore satisfies ModKitStore contract', async () => {
  const store = memoryStore()
  await runStoreContractTests(store)
})

test('openAIClassifier sends multimodal payload and aggregates categories/scores', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const classifier = openAIClassifier({
    apiKey: 'sk-test-123',
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({
        results: [
          {
            flagged: true,
            categories: { 'sexual/minors': false, violence: true },
            category_scores: { 'sexual/minors': 0.001, violence: 0.94 },
          },
        ],
      })
    },
  })

  const emptyResult = await classifier.classify({ text: '   ', imageUrls: [] })
  assert.equal(emptyResult.flagged, false)
  assert.equal(requests.length, 0)

  const result = await classifier.classify({
    text: 'Check out this pickup',
    imageUrls: ['https://example.supabase.co/storage/v1/object/sign/bucket/img1.jpg?token=abc'],
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, 'https://api.openai.com/v1/moderations')
  const parsedBody = JSON.parse(String(requests[0]?.init?.body)) as {
    model: string
    input: unknown[]
  }
  assert.equal(parsedBody.model, 'omni-moderation-latest')
  assert.deepEqual(parsedBody.input, [
    { type: 'text', text: 'Check out this pickup' },
    {
      type: 'image_url',
      image_url: {
        url: 'https://example.supabase.co/storage/v1/object/sign/bucket/img1.jpg?token=abc',
      },
    },
  ])

  assert.equal(result.provider, 'openai')
  assert.equal(result.flagged, true)
  assert.deepEqual(result.categories, { 'sexual/minors': false, violence: true })
  assert.deepEqual(result.scores, { 'sexual/minors': 0.001, violence: 0.94 })
})

test('rekognitionClassifier signs SigV4 request and evaluates ModerationLabels threshold', async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  const classifier = rekognitionClassifier({
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    minConfidence: 75,
    now: () => new Date('2026-11-08T01:00:00.000Z'),
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://cdn.example.com/')) {
        return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 })
      }
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      })
      return Response.json({
        ModerationLabels: [
          { Name: 'Explicit Nudity', Confidence: 92.5 },
          { Name: 'Suggestive', Confidence: 50.0 },
        ],
      })
    },
  })

  const result = await classifier.classify({
    imageUrls: ['https://cdn.example.com/photo.jpg'],
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://rekognition.us-east-1.amazonaws.com/')
  assert.ok(calls[0]?.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261108/us-east-1/rekognition/aws4_request'))
  assert.equal(calls[0]?.headers['x-amz-target'], 'RekognitionService.DetectModerationLabels')

  const sentPayload = JSON.parse(calls[0]!.body) as {
    Image: { Bytes: string }
    MinConfidence: number
  }
  assert.equal(sentPayload.Image.Bytes, Buffer.from([1, 2, 3, 4]).toString('base64'))
  assert.equal(sentPayload.MinConfidence, 75)

  assert.equal(result.provider, 'rekognition')
  assert.equal(result.flagged, true)
  assert.deepEqual(result.categories, {
    explicit_nudity: true,
    suggestive: false,
  })
  assert.deepEqual(result.scores, {
    explicit_nudity: 0.925,
    suggestive: 0.5,
  })
})

test('slackNotifier and emailNotifier format and dispatch moderation alerts', async () => {
  const slackPayloads: { text: string }[] = []
  const slack = slackNotifier({
    webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00',
    fetchImpl: async (_input, init) => {
      slackPayloads.push(JSON.parse(String(init?.body)) as { text: string })
      return new Response('ok', { status: 200 })
    },
  })

  await slack.notify({
    kind: 'report_submitted',
    report: {
      id: 'rep-1',
      reporter_id: 'user-1',
      target_type: 'trash_pickup',
      target_id: 'pick-1',
      target_author_id: 'user-2',
      reason: 'objectionable',
      details: 'Offensive image',
      status: 'open',
      resolution_note: null,
      resolved_by: null,
      created_at: '2026-11-08T01:00:00.000Z',
      resolved_at: null,
    },
  })
  assert.equal(slackPayloads.length, 1)
  assert.match(slackPayloads[0]!.text, /rep-1/)
  assert.match(slackPayloads[0]!.text, /trash_pickup\/pick-1/)

  const emailPayloads: { from: string; to: string[]; subject: string; text: string }[] = []
  const email = emailNotifier({
    apiKey: 're_test_123',
    from: 'modkit@trashapp.cc',
    to: ['trust@trashapp.cc'],
    fetchImpl: async (_input, init) => {
      emailPayloads.push(
        JSON.parse(String(init?.body)) as {
          from: string
          to: string[]
          subject: string
          text: string
        },
      )
      return Response.json({ id: 'email-1' }, { status: 200 })
    },
  })

  await email.notify({
    kind: 'content_rejected',
    item: {
      target_type: 'trash_pickup',
      target_id: 'pick-2',
      author_id: 'user-9',
      status: 'rejected',
      classifier_provider: 'openai',
      classifier_categories: { violence: true },
      classifier_scores: { violence: 0.99 },
      created_at: '2026-11-08T01:00:00.000Z',
      updated_at: '2026-11-08T01:00:00.000Z',
    },
  })

  assert.equal(emailPayloads.length, 1)
  assert.equal(emailPayloads[0]!.from, 'modkit@trashapp.cc')
  assert.deepEqual(emailPayloads[0]!.to, ['trust@trashapp.cc'])
  assert.match(emailPayloads[0]!.subject, /Classifier Rejected: trash_pickup\/pick-2/)
  assert.match(emailPayloads[0]!.text, /violence/)
})

test('supabaseStorage generates normalized signed read URLs and rejects invalid keys', async () => {
  const storage = supabaseStorage({
    url: 'https://xyzcompany.supabase.co/',
    serviceRoleKey: 'service-role-secret',
    bucket: 'trash-pickup-images',
    fetchImpl: async (input, init) => {
      assert.equal(
        String(input),
        'https://xyzcompany.supabase.co/storage/v1/object/sign/trash-pickup-images/user-1/before.jpg',
      )
      assert.equal(init?.method, 'POST')
      assert.equal(JSON.parse(String(init?.body)).expiresIn, 300)
      return Response.json({
        signedURL: '/object/sign/trash-pickup-images/user-1/before.jpg?token=signed-jwt',
      })
    },
  })

  const signedUrl = await storage.createSignedReadUrl('user-1/before.jpg', 300)
  assert.equal(
    signedUrl,
    'https://xyzcompany.supabase.co/storage/v1/object/sign/trash-pickup-images/user-1/before.jpg?token=signed-jwt',
  )

  await assert.rejects(
    () => storage.createSignedReadUrl('../secret.txt', 300),
    (err: unknown) => err instanceof ModKitError && err.code === 'invalid_storage_key',
  )
})

function findPostgresBinDir(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  try {
    const usrLibPg = '/usr/lib/postgresql'
    if (existsSync(usrLibPg)) {
      for (const ver of readdirSync(usrLibPg).sort().reverse()) {
        candidates.push(join(usrLibPg, ver, 'bin'))
      }
    }
  } catch {
    // Ignore
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) {
      return dir
    }
  }
  return null
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolvePort(port)))
    })
    srv.on('error', reject)
  })
}

test('postgresStore satisfies ModKitStore contract and RLS visibility helpers against disposable Postgres', async (t) => {
  const pgBinDir = findPostgresBinDir()
  if (!pgBinDir || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('Local initdb/pg_ctl not available')
    return
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'modkit-pg-test-'))
  const dataDir = join(tempRoot, 'data')
  const logFile = join(tempRoot, 'postgres.log')
  const port = await getFreePort()
  const initdbBin = join(pgBinDir, 'initdb')
  const pgCtlBin = join(pgBinDir, 'pg_ctl')

  try {
    await execFileAsync(initdbBin, ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-instructions'])
    await execFileAsync(pgCtlBin, [
      '-D',
      dataDir,
      '-l',
      logFile,
      '-o',
      `-F -p ${port} -h 127.0.0.1 -k "${tempRoot}"`,
      '-w',
      'start',
    ])

    const dbName = `modkit_test_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const adminSql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      max: 1,
      onnotice: () => {},
    })
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`)
    await adminSql.end({ timeout: 5 })

    const store = postgresStore({
      url: `postgres://postgres@127.0.0.1:${port}/${dbName}`,
      max: 2,
      prepare: false,
      fetchTypes: false,
    })

    try {
      const migrationPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'migrations',
        '001_modkit_v1.sql',
      )
      const migrationSql = await readFile(migrationPath, 'utf8')
      await store.sql.unsafe(migrationSql)

      await runStoreContractTests(store)

      // Verify SQL helper functions reflect store state
      const visRows = await store.sql<{ visible_reporter: boolean; visible_other: boolean }[]>`
        SELECT
          modkit.is_visible(
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            'trash_pickup',
            'pickup-101',
            'post'
          ) AS visible_reporter,
          modkit.is_visible(
            '99999999-9999-9999-9999-999999999999',
            '22222222-2222-2222-2222-222222222222',
            'trash_pickup',
            'pickup-101',
            'post'
          ) AS visible_other
      `
      assert.equal(visRows[0]?.visible_reporter, false)
      assert.equal(visRows[0]?.visible_other, true)
    } finally {
      await store.close()
    }
  } finally {
    try {
      await execFileAsync(pgCtlBin, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'])
    } catch {
      // Ignore cleanup stop errors
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
