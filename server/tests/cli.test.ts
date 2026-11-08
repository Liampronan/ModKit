import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createModKitServer,
  memoryStore,
  runCli,
  staticTokens,
} from '../dist/index.js'

test('CLI: modkit migrations copy copies 001_modkit_v1.sql and refuses overwrite', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'modkit-cli-migrations-'))
  try {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(['migrations', 'copy', tempDir], {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    })
    assert.equal(code, 0)
    assert.equal(err.length, 0)
    const files = await readdir(tempDir)
    assert.deepEqual(files, ['001_modkit_v1.sql'])

    const sqlText = await readFile(join(tempDir, '001_modkit_v1.sql'), 'utf8')
    assert.match(sqlText, /CREATE SCHEMA IF NOT EXISTS modkit;/)

    // Second copy to same directory fails with EEXIST guard
    const dupErr: string[] = []
    const dupCode = await runCli(['migrations', 'copy', tempDir], {
      stdout: () => {},
      stderr: (l) => dupErr.push(l),
    })
    assert.equal(dupCode, 1)
    assert.ok(dupErr.some((l) => l.includes('already exists')))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('CLI: reports list, reports resolve (remove|dismiss|ban), and bans add/remove/list', async () => {
  const store = memoryStore()
  const r1 = await store.createReport({
    reporterId: 'reporter-1',
    targetType: 'trash_pickup',
    targetId: 'pickup-1',
    targetAuthorId: 'author-1',
    reason: 'objectionable',
    details: 'Bad photo',
  })
  const r2 = await store.createReport({
    reporterId: 'reporter-2',
    targetType: 'trash_pickup',
    targetId: 'pickup-2',
    targetAuthorId: 'author-2',
    reason: 'harassment',
  })

  // 1. List open reports
  const listOut: string[] = []
  const listCode = await runCli(['reports', 'list', '--db', 'postgres://mock', '--status', 'open'], {
    storeFactory: () => store,
    stdout: (l) => listOut.push(l),
    stderr: (l) => assert.fail(l),
  })
  assert.equal(listCode, 0)
  assert.ok(listOut.some((l) => l.includes(r1.id)))
  assert.ok(listOut.some((l) => l.includes(r2.id)))

  // 2. Resolve r1 with --action remove
  const res1Out: string[] = []
  const res1Code = await runCli(
    [
      'reports',
      'resolve',
      r1.id,
      '--action',
      'remove',
      '--note',
      'Confirmed inappropriate',
      '--db',
      'postgres://mock',
    ],
    {
      storeFactory: () => store,
      stdout: (l) => res1Out.push(l),
      stderr: (l) => assert.fail(l),
    },
  )
  assert.equal(res1Code, 0)
  assert.equal((await store.getItem('trash_pickup', 'pickup-1'))?.status, 'rejected')
  assert.equal((await store.getReportById(r1.id))?.status, 'actioned')

  // 3. Resolve r2 with --action ban
  const res2Code = await runCli(
    ['reports', 'resolve', r2.id, '--action', 'ban', '--note', 'Repeat offender', '--db', 'postgres://mock'],
    {
      storeFactory: () => store,
      stdout: () => {},
      stderr: (l) => assert.fail(l),
    },
  )
  assert.equal(res2Code, 0)
  assert.equal(await store.isBanned('author-2'), true)

  // 4. Direct bans add / list / remove
  const banAddCode = await runCli(
    ['bans', 'add', 'author-3', '--reason', 'Spamming pickups', '--db', 'postgres://mock'],
    {
      storeFactory: () => store,
      stdout: () => {},
      stderr: (l) => assert.fail(l),
    },
  )
  assert.equal(banAddCode, 0)
  assert.equal(await store.isBanned('author-3'), true)

  const banListOut: string[] = []
  const banListCode = await runCli(['bans', 'list', '--db', 'postgres://mock'], {
    storeFactory: () => store,
    stdout: (l) => banListOut.push(l),
    stderr: (l) => assert.fail(l),
  })
  assert.equal(banListCode, 0)
  assert.ok(banListOut.some((l) => l.includes('author-3')))

  const banRemoveCode = await runCli(['bans', 'remove', 'author-3', '--db', 'postgres://mock'], {
    storeFactory: () => store,
    stdout: () => {},
    stderr: (l) => assert.fail(l),
  })
  assert.equal(banRemoveCode, 0)
  assert.equal(await store.isBanned('author-3'), false)
})

test('CLI: modkit conformance --server runs end-to-end checks', async () => {
  const store = memoryStore()
  const handler = createModKitServer({
    store,
    authenticate: staticTokens({
      'cli-test-token': 'user-cli-1',
    }),
    webhookSecret: 'wh-cli-secret',
  })

  const out: string[] = []
  const code = await runCli(
    [
      'conformance',
      '--server',
      'https://example.supabase.co/functions/v1/modkit',
      '--token',
      'cli-test-token',
      '--webhook-secret',
      'wh-cli-secret',
    ],
    {
      fetchImpl: async (input, init) => handler(new Request(input, init)),
      stdout: (l) => out.push(l),
      stderr: (l) => assert.fail(l),
    },
  )
  assert.equal(code, 0)
  assert.ok(out.some((l) => l.includes('Conformance suite passed')))
})
