import { randomUUID } from 'node:crypto'
import postgres, { type JSONValue, type Sql } from 'postgres'
import { ModKitError } from './errors.js'
import {
  MODKIT_ITEM_STATUSES,
  MODKIT_REPORT_REASONS,
  type AcceptTermsInput,
  type AddBanInput,
  type BlockUserInput,
  type CreateReportInput,
  type ListReportsFilter,
  type ModKitBanRecord,
  type ModKitBlockRecord,
  type ModKitHiddenItem,
  type ModKitItemRecord,
  type ModKitItemStatus,
  type ModKitReportReason,
  type ModKitReportRecord,
  type ModKitReportStatus,
  type ModKitStore,
  type ModKitTermsAcceptanceRecord,
  type ModKitUserState,
  type ResolveReportInput,
  type UnblockUserInput,
  type UpsertItemInput,
} from './store.js'

export interface PostgresStoreOptions {
  url: string
  max?: number | undefined
  prepare?: boolean | undefined
  idleTimeout?: number | undefined
  maxLifetime?: number | undefined
  fetchTypes?: boolean | undefined
}

export interface PostgresModKitStore extends ModKitStore {
  readonly sql: Sql
  close(): Promise<void>
}

function toIsoString(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString()
}

function parseJsonObject<T extends Record<string, unknown>>(val: unknown): T {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as T
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T
      }
    } catch {
      // Ignore invalid JSON
    }
  }
  return {} as T
}

interface RawReportRow {
  id: string
  reporter_id: string
  target_type: string
  target_id: string
  target_author_id: string | null
  reason: ModKitReportReason
  details: string | null
  status: ModKitReportStatus
  resolution_note: string | null
  resolved_by: string | null
  created_at: Date | string
  resolved_at: Date | string | null
}

function mapReportRow(row: RawReportRow): ModKitReportRecord {
  return {
    id: String(row.id),
    reporter_id: String(row.reporter_id),
    target_type: String(row.target_type),
    target_id: String(row.target_id),
    target_author_id: row.target_author_id ? String(row.target_author_id) : null,
    reason: row.reason,
    details: row.details ?? null,
    status: row.status,
    resolution_note: row.resolution_note ?? null,
    resolved_by: row.resolved_by ?? null,
    created_at: toIsoString(row.created_at),
    resolved_at: row.resolved_at ? toIsoString(row.resolved_at) : null,
  }
}

interface RawItemRow {
  target_type: string
  target_id: string
  author_id: string
  status: ModKitItemStatus
  classifier_provider: string | null
  classifier_categories: unknown
  classifier_scores: unknown
  created_at: Date | string
  updated_at: Date | string
}

function mapItemRow(row: RawItemRow): ModKitItemRecord {
  return {
    target_type: String(row.target_type),
    target_id: String(row.target_id),
    author_id: String(row.author_id),
    status: row.status,
    classifier_provider: row.classifier_provider ?? null,
    classifier_categories: parseJsonObject<Record<string, boolean>>(row.classifier_categories),
    classifier_scores: parseJsonObject<Record<string, number>>(row.classifier_scores),
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  }
}

/**
 * Creates a PostgreSQL-backed `ModKitStore` using `postgres.js`.
 * Defaults `prepare: false` and `fetch_types: false` for Supavisor transaction-mode pooler compatibility.
 */
export function postgresStore(options: PostgresStoreOptions): PostgresModKitStore {
  const sql = postgres(options.url, {
    max: options.max ?? 5,
    prepare: options.prepare ?? false,
    fetch_types: options.fetchTypes ?? false,
    ...(options.idleTimeout !== undefined ? { idle_timeout: options.idleTimeout } : {}),
    ...(options.maxLifetime !== undefined ? { max_lifetime: options.maxLifetime } : {}),
    onnotice: () => {},
  })

  return {
    sql,

    async close(): Promise<void> {
      await sql.end({ timeout: 5 })
    },

    async getUserState(userId: string): Promise<ModKitUserState> {
      const normalizedUserId = userId.trim()
      if (!normalizedUserId) {
        throw new ModKitError(400, 'invalid_user_id', 'userId must be a non-empty string.')
      }

      const [termsRows, blockRows, reportRows] = await Promise.all([
        sql<{ terms_version: string }[]>`
          SELECT terms_version
          FROM modkit.terms_acceptances
          WHERE user_id = ${normalizedUserId}
          ORDER BY accepted_at ASC, terms_version ASC
        `,
        sql<{ blocked_id: string }[]>`
          SELECT blocked_id
          FROM modkit.blocks
          WHERE blocker_id = ${normalizedUserId}
          ORDER BY created_at ASC, blocked_id ASC
        `,
        sql<{ target_type: string; target_id: string }[]>`
          SELECT DISTINCT target_type, target_id
          FROM modkit.reports
          WHERE reporter_id = ${normalizedUserId}
          ORDER BY target_type ASC, target_id ASC
        `,
      ])

      const hiddenItems: ModKitHiddenItem[] = reportRows.map((row) => ({
        target_type: String(row.target_type),
        target_id: String(row.target_id),
      }))

      return {
        user_id: normalizedUserId,
        accepted_terms_versions: termsRows.map((r) => String(r.terms_version)),
        blocked_user_ids: blockRows.map((r) => String(r.blocked_id)),
        hidden_items: hiddenItems,
      }
    },

    async acceptTerms(input: AcceptTermsInput): Promise<ModKitTermsAcceptanceRecord> {
      const userId = input.userId.trim()
      const termsVersion = input.termsVersion.trim()
      if (!userId) {
        throw new ModKitError(400, 'invalid_user_id', 'userId must be a non-empty string.')
      }
      if (!termsVersion) {
        throw new ModKitError(400, 'invalid_terms_version', 'terms_version must be a non-empty string.')
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const rows = await sql<
        { user_id: string; terms_version: string; accepted_at: Date | string }[]
      >`
        INSERT INTO modkit.terms_acceptances (user_id, terms_version, accepted_at)
        VALUES (${userId}, ${termsVersion}, ${nowIso})
        ON CONFLICT (user_id, terms_version)
        DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING user_id, terms_version, accepted_at
      `

      const row = rows[0]!
      return {
        user_id: String(row.user_id),
        terms_version: String(row.terms_version),
        accepted_at: toIsoString(row.accepted_at),
      }
    },

    async blockUser(input: BlockUserInput): Promise<ModKitBlockRecord> {
      const blockerId = input.blockerId.trim()
      const blockedUserId = input.blockedUserId.trim()
      if (!blockerId || !blockedUserId) {
        throw new ModKitError(
          400,
          'invalid_block',
          'blockerId and blockedUserId must be non-empty strings.',
        )
      }
      if (blockerId === blockedUserId) {
        throw new ModKitError(400, 'self_block_forbidden', 'Users cannot block themselves.')
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const rows = await sql<
        { blocker_id: string; blocked_id: string; created_at: Date | string }[]
      >`
        INSERT INTO modkit.blocks (blocker_id, blocked_id, created_at)
        VALUES (${blockerId}, ${blockedUserId}, ${nowIso})
        ON CONFLICT (blocker_id, blocked_id)
        DO UPDATE SET blocker_id = EXCLUDED.blocker_id
        RETURNING blocker_id, blocked_id, created_at
      `

      const row = rows[0]!
      return {
        blocker_id: String(row.blocker_id),
        blocked_user_id: String(row.blocked_id),
        created_at: toIsoString(row.created_at),
      }
    },

    async unblockUser(input: UnblockUserInput): Promise<void> {
      const blockerId = input.blockerId.trim()
      const blockedUserId = input.blockedUserId.trim()
      if (!blockerId || !blockedUserId) {
        throw new ModKitError(
          400,
          'invalid_unblock',
          'blockerId and blockedUserId must be non-empty strings.',
        )
      }

      await sql`
        DELETE FROM modkit.blocks
        WHERE blocker_id = ${blockerId} AND blocked_id = ${blockedUserId}
      `
    },

    async createReport(input: CreateReportInput): Promise<ModKitReportRecord> {
      const reporterId = input.reporterId.trim()
      const targetType = input.targetType.trim()
      const targetId = input.targetId.trim()
      const targetAuthorId = input.targetAuthorId?.trim() || null
      if (!reporterId || !targetType || !targetId) {
        throw new ModKitError(
          400,
          'invalid_report',
          'reporterId, targetType, and targetId must be non-empty strings.',
        )
      }
      if (!MODKIT_REPORT_REASONS.includes(input.reason)) {
        throw new ModKitError(
          400,
          'invalid_reason',
          `reason must be one of: ${MODKIT_REPORT_REASONS.join(', ')}.`,
        )
      }

      const id = input.id?.trim() || randomUUID()
      const nowIso = (input.now ?? new Date()).toISOString()
      const details =
        typeof input.details === 'string' && input.details.trim().length > 0
          ? input.details.trim()
          : null
      const autoFlag = input.autoFlagItem ?? true

      const rows = await sql.begin(async (tx) => {
        const q = tx as unknown as Sql
        const inserted = await q<RawReportRow[]>`
          INSERT INTO modkit.reports (
            id, reporter_id, target_type, target_id, target_author_id, reason, details, status, created_at
          )
          VALUES (
            ${id}, ${reporterId}, ${targetType}, ${targetId}, ${targetAuthorId}, ${input.reason}, ${details}, 'open', ${nowIso}
          )
          RETURNING *
        `

        if (autoFlag) {
          if (targetAuthorId) {
            await q`
              INSERT INTO modkit.items (target_type, target_id, author_id, status, created_at, updated_at)
              VALUES (${targetType}, ${targetId}, ${targetAuthorId}, 'flagged', ${nowIso}, ${nowIso})
              ON CONFLICT (target_type, target_id)
              DO UPDATE SET
                status = CASE
                  WHEN modkit.items.status = 'rejected' THEN 'rejected'
                  ELSE 'flagged'
                END,
                updated_at = ${nowIso}
            `
          } else {
            await q`
              UPDATE modkit.items
              SET
                status = CASE
                  WHEN status = 'rejected' THEN 'rejected'
                  ELSE 'flagged'
                END,
                updated_at = ${nowIso}
              WHERE target_type = ${targetType} AND target_id = ${targetId}
            `
          }
        }

        return inserted
      })

      return mapReportRow(rows[0]!)
    },

    async getReportById(reportId: string): Promise<ModKitReportRecord | null> {
      const id = reportId.trim()
      if (!id) return null
      try {
        const rows = await sql<RawReportRow[]>`
          SELECT * FROM modkit.reports WHERE id = ${id}::uuid LIMIT 1
        `
        return rows[0] ? mapReportRow(rows[0]) : null
      } catch {
        return null
      }
    },

    async listReports(filter?: ListReportsFilter): Promise<ModKitReportRecord[]> {
      const limit = filter?.limit && filter.limit > 0 ? filter.limit : 100
      const status = filter?.status ?? null
      const targetType = filter?.targetType ?? null
      const targetId = filter?.targetId ?? null

      const rows = await sql<RawReportRow[]>`
        SELECT *
        FROM modkit.reports
        WHERE (${status}::text IS NULL OR status = ${status})
          AND (${targetType}::text IS NULL OR target_type = ${targetType})
          AND (${targetId}::text IS NULL OR target_id = ${targetId})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `

      return rows.map(mapReportRow)
    },

    async resolveReport(input: ResolveReportInput): Promise<ModKitReportRecord | null> {
      const reportId = input.reportId.trim()
      if (!reportId) return null

      const nowIso = (input.now ?? new Date()).toISOString()
      const resolvedBy = input.resolvedBy?.trim() || 'operator'
      const note =
        typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.trim() : null
      const nextStatus: ModKitReportStatus = input.action === 'dismiss' ? 'dismissed' : 'actioned'

      return await sql.begin(async (tx) => {
        const q = tx as unknown as Sql
        const existingRows = await q<RawReportRow[]>`
          SELECT * FROM modkit.reports WHERE id = ${reportId}::uuid FOR UPDATE
        `
        const report = existingRows[0]
        if (!report) {
          return null
        }

        const itemRows = await q<RawItemRow[]>`
          SELECT * FROM modkit.items
          WHERE target_type = ${report.target_type} AND target_id = ${report.target_id}
          FOR UPDATE
        `
        const existingItem = itemRows[0]
        const authorId = existingItem?.author_id ?? report.target_author_id

        if (input.action === 'ban' && !authorId) {
          throw new ModKitError(
            400,
            'missing_target_author',
            'Cannot ban author because report has no target_author_id and item is unknown.',
          )
        }

        const updatedRows = await q<RawReportRow[]>`
          UPDATE modkit.reports
          SET
            status = ${nextStatus},
            resolution_note = ${note},
            resolved_by = ${resolvedBy},
            resolved_at = ${nowIso}
          WHERE id = ${reportId}::uuid
          RETURNING *
        `

        const fallbackAuthorId = authorId ?? 'unknown'
        if (input.action === 'remove' || input.action === 'ban') {
          await q`
            INSERT INTO modkit.items (target_type, target_id, author_id, status, created_at, updated_at)
            VALUES (${report.target_type}, ${report.target_id}, ${fallbackAuthorId}, 'rejected', ${nowIso}, ${nowIso})
            ON CONFLICT (target_type, target_id)
            DO UPDATE SET
              status = 'rejected',
              updated_at = ${nowIso}
          `
        } else if (input.action === 'dismiss' && existingItem && existingItem.status === 'flagged') {
          await q`
            UPDATE modkit.items
            SET status = 'approved', updated_at = ${nowIso}
            WHERE target_type = ${report.target_type} AND target_id = ${report.target_id}
          `
        }

        if (input.action === 'ban' && authorId) {
          const banReason = note ?? `Banned via report ${report.id} (${report.reason})`
          await q`
            INSERT INTO modkit.bans (user_id, reason, banned_by, created_at, expires_at)
            VALUES (${authorId}, ${banReason}, ${resolvedBy}, ${nowIso}, NULL)
            ON CONFLICT (user_id)
            DO UPDATE SET
              reason = EXCLUDED.reason,
              banned_by = EXCLUDED.banned_by,
              created_at = EXCLUDED.created_at,
              expires_at = NULL
          `
        }

        return mapReportRow(updatedRows[0]!)
      })
    },

    async upsertItem(input: UpsertItemInput): Promise<ModKitItemRecord> {
      const targetType = input.targetType.trim()
      const targetId = input.targetId.trim()
      const authorId = input.authorId.trim()
      if (!targetType || !targetId || !authorId) {
        throw new ModKitError(
          400,
          'invalid_item',
          'targetType, targetId, and authorId must be non-empty strings.',
        )
      }
      if (!MODKIT_ITEM_STATUSES.includes(input.status)) {
        throw new ModKitError(
          400,
          'invalid_item_status',
          `status must be one of: ${MODKIT_ITEM_STATUSES.join(', ')}.`,
        )
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const provider = input.classifierProvider ?? null
      const categories = (input.classifierCategories ?? {}) as unknown as JSONValue
      const scores = (input.classifierScores ?? {}) as unknown as JSONValue

      const rows = await sql<RawItemRow[]>`
        INSERT INTO modkit.items (
          target_type,
          target_id,
          author_id,
          status,
          classifier_provider,
          classifier_categories,
          classifier_scores,
          created_at,
          updated_at
        )
        VALUES (
          ${targetType},
          ${targetId},
          ${authorId},
          ${input.status},
          ${provider},
          ${sql.json(categories)},
          ${sql.json(scores)},
          ${nowIso},
          ${nowIso}
        )
        ON CONFLICT (target_type, target_id)
        DO UPDATE SET
          author_id = EXCLUDED.author_id,
          status = EXCLUDED.status,
          classifier_provider = COALESCE(EXCLUDED.classifier_provider, modkit.items.classifier_provider),
          classifier_categories = CASE
            WHEN ${input.classifierCategories !== undefined} THEN EXCLUDED.classifier_categories
            ELSE modkit.items.classifier_categories
          END,
          classifier_scores = CASE
            WHEN ${input.classifierScores !== undefined} THEN EXCLUDED.classifier_scores
            ELSE modkit.items.classifier_scores
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `

      return mapItemRow(rows[0]!)
    },

    async getItem(targetType: string, targetId: string): Promise<ModKitItemRecord | null> {
      const rows = await sql<RawItemRow[]>`
        SELECT *
        FROM modkit.items
        WHERE target_type = ${targetType.trim()} AND target_id = ${targetId.trim()}
        LIMIT 1
      `
      return rows[0] ? mapItemRow(rows[0]) : null
    },

    async addBan(input: AddBanInput): Promise<ModKitBanRecord> {
      const userId = input.userId.trim()
      const reason = input.reason.trim()
      if (!userId || !reason) {
        throw new ModKitError(400, 'invalid_ban', 'userId and reason must be non-empty strings.')
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const bannedBy = input.bannedBy?.trim() || null
      const expiresAt =
        input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : typeof input.expiresAt === 'string' && input.expiresAt.trim().length > 0
            ? input.expiresAt.trim()
            : null

      const rows = await sql<
        {
          user_id: string
          reason: string
          banned_by: string | null
          created_at: Date | string
          expires_at: Date | string | null
        }[]
      >`
        INSERT INTO modkit.bans (user_id, reason, banned_by, created_at, expires_at)
        VALUES (${userId}, ${reason}, ${bannedBy}, ${nowIso}, ${expiresAt})
        ON CONFLICT (user_id)
        DO UPDATE SET
          reason = EXCLUDED.reason,
          banned_by = EXCLUDED.banned_by,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
        RETURNING user_id, reason, banned_by, created_at, expires_at
      `

      const row = rows[0]!
      return {
        user_id: String(row.user_id),
        reason: String(row.reason),
        banned_by: row.banned_by ?? null,
        created_at: toIsoString(row.created_at),
        expires_at: row.expires_at ? toIsoString(row.expires_at) : null,
      }
    },

    async removeBan(userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        DELETE FROM modkit.bans WHERE user_id = ${userId.trim()} RETURNING user_id
      `
      return rows.length > 0
    },

    async isBanned(userId: string, now?: Date): Promise<boolean> {
      const checkIso = (now ?? new Date()).toISOString()
      const rows = await sql<{ banned: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM modkit.bans b
          WHERE b.user_id = ${userId.trim()}
            AND (b.expires_at IS NULL OR b.expires_at > ${checkIso}::timestamptz)
        ) AS banned
      `
      return Boolean(rows[0]?.banned)
    },

    async listBans(): Promise<ModKitBanRecord[]> {
      const rows = await sql<
        {
          user_id: string
          reason: string
          banned_by: string | null
          created_at: Date | string
          expires_at: Date | string | null
        }[]
      >`
        SELECT user_id, reason, banned_by, created_at, expires_at
        FROM modkit.bans
        ORDER BY created_at DESC
      `
      return rows.map((row) => ({
        user_id: String(row.user_id),
        reason: String(row.reason),
        banned_by: row.banned_by ?? null,
        created_at: toIsoString(row.created_at),
        expires_at: row.expires_at ? toIsoString(row.expires_at) : null,
      }))
    },
  }
}
