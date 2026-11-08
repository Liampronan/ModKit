#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { constants, copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformanceSuite } from './conformance.js'
import { postgresStore } from './postgresStore.js'
import {
  MODKIT_REPORT_STATUSES,
  type ModKitReportStatus,
  type ModKitResolutionAction,
  type ModKitStore,
} from './store.js'

const VALID_ACTIONS = new Set<ModKitResolutionAction>(['remove', 'dismiss', 'ban'])

export type ClosableModKitStore = ModKitStore & { close?: () => Promise<void> }

export interface CliIo {
  stdout?: ((line: string) => void) | undefined
  stderr?: ((line: string) => void) | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
  cwd?: string | undefined
  storeFactory?: ((dbUrl: string) => ClosableModKitStore) | undefined
}

/**
 * Executes a `modkit` / `modkit-server` CLI command and returns a POSIX exit code (`0` on success, `1` on error).
 */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((line: string) => console.log(line))
  const stderr = io.stderr ?? ((line: string) => console.error(line))
  const fetchFn = io.fetchImpl ?? globalThis.fetch
  const cwd = io.cwd ?? process.cwd()
  const createStore =
    io.storeFactory ?? ((url: string) => postgresStore({ url, max: 1, prepare: false, fetchTypes: false }))

  try {
    const [group, subcommand, ...rest] = argv

    if (!group || group === '--help' || group === '-h' || group === 'help') {
      printUsage(stdout)
      return 0
    }

    if (group === 'migrations') {
      if (subcommand === 'copy') {
        const targetDirArg = rest[0]
        if (!targetDirArg) {
          stderr('Error: Usage: modkit migrations copy <dest-dir>')
          return 1
        }

        const targetDir = resolve(cwd, targetDirArg)
        await mkdir(targetDir, { recursive: true })

        const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
        const entries = await readdir(migrationsDir)
        const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort()

        if (sqlFiles.length === 0) {
          stderr('Error: No SQL migration files found.')
          return 1
        }

        for (const file of sqlFiles) {
          const srcPath = join(migrationsDir, file)
          const destPath = join(targetDir, file)
          try {
            await copyFile(srcPath, destPath, constants.COPYFILE_EXCL)
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
              stderr(`Error: Migration file already exists at destination: ${destPath}`)
              return 1
            }
            throw error
          }
          stdout(`Copied ${file} -> ${destPath}`)
        }
        return 0
      }

      stderr(`Error: Unknown migrations subcommand: ${subcommand ?? ''}`)
      return 1
    }

    if (group === 'reports') {
      if (subcommand === 'list') {
        const { flags } = parseFlags(rest)
        const dbUrl = flags.get('db') ?? process.env.DATABASE_URL
        if (!dbUrl) {
          stderr('Error: Missing --db <url> (or DATABASE_URL). Usage: modkit reports list --db <url> [--status open|actioned|dismissed]')
          return 1
        }

        const statusRaw = flags.get('status')
        let statusFilter: ModKitReportStatus | undefined
        if (statusRaw !== undefined) {
          if (!MODKIT_REPORT_STATUSES.includes(statusRaw as ModKitReportStatus)) {
            stderr(
              `Error: Invalid --status "${statusRaw}". Allowed: ${MODKIT_REPORT_STATUSES.join(', ')}`,
            )
            return 1
          }
          statusFilter = statusRaw as ModKitReportStatus
        }

        const store = createStore(dbUrl)
        try {
          const reports = await store.listReports({ status: statusFilter })
          if (reports.length === 0) {
            stdout('No reports found.')
            return 0
          }
          for (const r of reports) {
            stdout(
              `${r.id}\t${r.status}\t${r.reason}\t${r.target_type}/${r.target_id}\tauthor=${r.target_author_id ?? 'unknown'}\treporter=${r.reporter_id}\t${r.created_at}`,
            )
          }
          stdout(`Listed ${reports.length} report(s).`)
          return 0
        } finally {
          await store.close?.()
        }
      }

      if (subcommand === 'resolve') {
        const { positional, flags } = parseFlags(rest)
        const reportId = positional[0]
        const actionRaw = flags.get('action')
        const note = flags.get('note') ?? null
        const resolvedBy = flags.get('by') ?? 'cli'
        const dbUrl = flags.get('db') ?? process.env.DATABASE_URL

        if (!reportId || !actionRaw || !dbUrl) {
          stderr(
            'Error: Usage: modkit reports resolve <report-id> --action <remove|dismiss|ban> [--note "..."] --db <url>',
          )
          return 1
        }

        if (!VALID_ACTIONS.has(actionRaw as ModKitResolutionAction)) {
          stderr('Error: --action must be one of: remove, dismiss, ban')
          return 1
        }

        const store = createStore(dbUrl)
        try {
          const resolved = await store.resolveReport({
            reportId,
            action: actionRaw as ModKitResolutionAction,
            note,
            resolvedBy,
          })
          if (!resolved) {
            stderr(`Error: Report "${reportId}" not found.`)
            return 1
          }
          stdout(
            `Resolved report ${resolved.id} -> status=${resolved.status} (action=${actionRaw})`,
          )
          return 0
        } finally {
          await store.close?.()
        }
      }

      stderr(`Error: Unknown reports subcommand: ${subcommand ?? ''}`)
      return 1
    }

    if (group === 'bans') {
      if (subcommand === 'add') {
        const { positional, flags } = parseFlags(rest)
        const userId = positional[0]
        const reason = flags.get('reason')
        const bannedBy = flags.get('by') ?? 'cli'
        const expiresAt = flags.get('expires-at') ?? null
        const dbUrl = flags.get('db') ?? process.env.DATABASE_URL

        if (!userId || !reason || !dbUrl) {
          stderr('Error: Usage: modkit bans add <user-id> --reason "..." --db <url>')
          return 1
        }

        const store = createStore(dbUrl)
        try {
          const ban = await store.addBan({
            userId,
            reason,
            bannedBy,
            expiresAt,
          })
          stdout(`Banned user ${ban.user_id} (reason: ${ban.reason})`)
          return 0
        } finally {
          await store.close?.()
        }
      }

      if (subcommand === 'remove') {
        const { positional, flags } = parseFlags(rest)
        const userId = positional[0]
        const dbUrl = flags.get('db') ?? process.env.DATABASE_URL

        if (!userId || !dbUrl) {
          stderr('Error: Usage: modkit bans remove <user-id> --db <url>')
          return 1
        }

        const store = createStore(dbUrl)
        try {
          const removed = await store.removeBan(userId)
          if (!removed) {
            stderr(`Error: No active ban found for user "${userId}".`)
            return 1
          }
          stdout(`Removed ban for user ${userId}`)
          return 0
        } finally {
          await store.close?.()
        }
      }

      if (subcommand === 'list') {
        const { flags } = parseFlags(rest)
        const dbUrl = flags.get('db') ?? process.env.DATABASE_URL
        if (!dbUrl) {
          stderr('Error: Usage: modkit bans list --db <url>')
          return 1
        }

        const store = createStore(dbUrl)
        try {
          const bans = await store.listBans()
          if (bans.length === 0) {
            stdout('No bans found.')
            return 0
          }
          for (const b of bans) {
            stdout(`${b.user_id}\t${b.reason}\tcreated=${b.created_at}\texpires=${b.expires_at ?? 'never'}`)
          }
          return 0
        } finally {
          await store.close?.()
        }
      }

      stderr(`Error: Unknown bans subcommand: ${subcommand ?? ''}`)
      return 1
    }

    if (group === 'conformance') {
      const allArgs = subcommand ? [subcommand, ...rest] : rest
      const { flags } = parseFlags(allArgs)
      const serverUrl = flags.get('server')
      if (!serverUrl) {
        stderr(
          'Error: Usage: modkit conformance --server <url> [--token <jwt>] [--webhook-secret <secret>]',
        )
        return 1
      }

      const userAToken = flags.get('token') ?? process.env.MODKIT_TEST_TOKEN ?? 'test-user-a-token'
      const webhookSecret = flags.get('webhook-secret') ?? process.env.MODKIT_WEBHOOK_SECRET

      const result = await runConformanceSuite({
        baseUrl: serverUrl,
        userAToken,
        webhookSecret,
        fetch: fetchFn,
      })

      for (const step of result.steps) {
        if (step.ok) {
          stdout(`✓ ${step.name}`)
        } else {
          stderr(`✗ ${step.name}: ${step.detail ?? 'failed'}`)
        }
      }

      if (!result.ok) {
        stderr('Conformance suite failed.')
        return 1
      }

      stdout(`Conformance suite passed (${result.steps.length} steps).`)
      return 0
    }

    stderr(`Error: Unknown command "${group}". Run "modkit --help" for usage.`)
    return 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr(`Error: ${message}`)
    return 1
  }
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = []
  const flags = new Map<string, string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx >= 0) {
        const key = arg.slice(2, eqIdx)
        const val = arg.slice(eqIdx + 1)
        flags.set(key, val)
      } else {
        const key = arg.slice(2)
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next)
          i += 1
        } else {
          flags.set(key, 'true')
        }
      }
    } else {
      positional.push(arg)
    }
  }

  return { positional, flags }
}

function printUsage(stdout: (line: string) => void): void {
  stdout(`ModKit v1 Operator CLI

Usage:
  modkit migrations copy <dest-dir>
  modkit reports list --db <url> [--status open|actioned|dismissed]
  modkit reports resolve <report-id> --action <remove|dismiss|ban> [--note "..."] --db <url>
  modkit bans add <user-id> --reason "..." [--expires-at <iso>] --db <url>
  modkit bans remove <user-id> --db <url>
  modkit bans list --db <url>
  modkit conformance --server <url> [--token <jwt>] [--webhook-secret <secret>]`)
}

export function isCliEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  const modulePath = fileURLToPath(moduleUrl)
  try {
    return realpathSync(argv1) === realpathSync(modulePath)
  } catch {
    return resolve(argv1) === resolve(modulePath)
  }
}

const isMain = isCliEntrypoint(process.argv[1], import.meta.url)

if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
