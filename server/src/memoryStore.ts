import { randomUUID } from 'node:crypto'
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
  type ModKitReportRecord,
  type ModKitStore,
  type ModKitTermsAcceptanceRecord,
  type ModKitUserState,
  type ResolveReportInput,
  type UnblockUserInput,
  type UpsertItemInput,
} from './store.js'

/**
 * Creates an in-memory `ModKitStore` implementation for unit tests, local previews, and conformance runs.
 */
export function memoryStore(): ModKitStore {
  const termsByUser = new Map<string, Map<string, ModKitTermsAcceptanceRecord>>()
  const blocksByUser = new Map<string, Map<string, ModKitBlockRecord>>()
  const bansByUser = new Map<string, ModKitBanRecord>()
  const itemsByKey = new Map<string, ModKitItemRecord>()
  const reportsById = new Map<string, ModKitReportRecord>()

  function itemKey(targetType: string, targetId: string): string {
    return `${targetType}\u0000${targetId}`
  }

  return {
    async getUserState(userId: string): Promise<ModKitUserState> {
      const normalizedUserId = userId.trim()
      if (!normalizedUserId) {
        throw new ModKitError(400, 'invalid_user_id', 'userId must be a non-empty string.')
      }

      const acceptedTerms = Array.from(termsByUser.get(normalizedUserId)?.values() ?? [])
        .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at))
        .map((row) => row.terms_version)

      const blockedUsers = Array.from(blocksByUser.get(normalizedUserId)?.values() ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((row) => row.blocked_user_id)

      const seenHidden = new Set<string>()
      const hiddenItems: ModKitHiddenItem[] = []
      for (const report of reportsById.values()) {
        if (report.reporter_id === normalizedUserId) {
          const key = itemKey(report.target_type, report.target_id)
          if (!seenHidden.has(key)) {
            seenHidden.add(key)
            hiddenItems.push({
              target_type: report.target_type,
              target_id: report.target_id,
            })
          }
        }
      }

      return {
        user_id: normalizedUserId,
        accepted_terms_versions: acceptedTerms,
        blocked_user_ids: blockedUsers,
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

      let userMap = termsByUser.get(userId)
      if (!userMap) {
        userMap = new Map()
        termsByUser.set(userId, userMap)
      }

      const existing = userMap.get(termsVersion)
      if (existing) {
        return { ...existing }
      }

      const record: ModKitTermsAcceptanceRecord = {
        user_id: userId,
        terms_version: termsVersion,
        accepted_at: (input.now ?? new Date()).toISOString(),
      }
      userMap.set(termsVersion, record)
      return { ...record }
    },

    async blockUser(input: BlockUserInput): Promise<ModKitBlockRecord> {
      const blockerId = input.blockerId.trim()
      const blockedUserId = input.blockedUserId.trim()
      if (!blockerId || !blockedUserId) {
        throw new ModKitError(400, 'invalid_block', 'blockerId and blockedUserId must be non-empty strings.')
      }
      if (blockerId === blockedUserId) {
        throw new ModKitError(400, 'self_block_forbidden', 'Users cannot block themselves.')
      }

      let userBlocks = blocksByUser.get(blockerId)
      if (!userBlocks) {
        userBlocks = new Map()
        blocksByUser.set(blockerId, userBlocks)
      }

      const existing = userBlocks.get(blockedUserId)
      if (existing) {
        return { ...existing }
      }

      const record: ModKitBlockRecord = {
        blocker_id: blockerId,
        blocked_user_id: blockedUserId,
        created_at: (input.now ?? new Date()).toISOString(),
      }
      userBlocks.set(blockedUserId, record)
      return { ...record }
    },

    async unblockUser(input: UnblockUserInput): Promise<void> {
      const blockerId = input.blockerId.trim()
      const blockedUserId = input.blockedUserId.trim()
      if (!blockerId || !blockedUserId) {
        throw new ModKitError(400, 'invalid_unblock', 'blockerId and blockedUserId must be non-empty strings.')
      }
      blocksByUser.get(blockerId)?.delete(blockedUserId)
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

      const nowIso = (input.now ?? new Date()).toISOString()
      const id = input.id?.trim() || randomUUID()
      const details =
        typeof input.details === 'string' && input.details.trim().length > 0
          ? input.details.trim()
          : null

      const report: ModKitReportRecord = {
        id,
        reporter_id: reporterId,
        target_type: targetType,
        target_id: targetId,
        target_author_id: targetAuthorId,
        reason: input.reason,
        details,
        status: 'open',
        resolution_note: null,
        resolved_by: null,
        created_at: nowIso,
        resolved_at: null,
      }
      reportsById.set(id, report)

      if (input.autoFlagItem ?? true) {
        const key = itemKey(targetType, targetId)
        const existingItem = itemsByKey.get(key)
        if (existingItem) {
          if (existingItem.status !== 'rejected') {
            itemsByKey.set(key, {
              ...existingItem,
              status: 'flagged',
              updated_at: nowIso,
            })
          }
        } else if (targetAuthorId) {
          itemsByKey.set(key, {
            target_type: targetType,
            target_id: targetId,
            author_id: targetAuthorId,
            status: 'flagged',
            classifier_provider: null,
            classifier_categories: {},
            classifier_scores: {},
            created_at: nowIso,
            updated_at: nowIso,
          })
        }
      }

      return { ...report }
    },

    async getReportById(reportId: string): Promise<ModKitReportRecord | null> {
      const row = reportsById.get(reportId.trim())
      return row ? { ...row } : null
    },

    async listReports(filter?: ListReportsFilter): Promise<ModKitReportRecord[]> {
      let rows = Array.from(reportsById.values())
      if (filter?.status) {
        rows = rows.filter((r) => r.status === filter.status)
      }
      if (filter?.targetType) {
        rows = rows.filter((r) => r.target_type === filter.targetType)
      }
      if (filter?.targetId) {
        rows = rows.filter((r) => r.target_id === filter.targetId)
      }
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
      if (filter?.limit !== undefined && filter.limit > 0) {
        rows = rows.slice(0, filter.limit)
      }
      return rows.map((r) => ({ ...r }))
    },

    async resolveReport(input: ResolveReportInput): Promise<ModKitReportRecord | null> {
      const report = reportsById.get(input.reportId.trim())
      if (!report) {
        return null
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const resolvedBy = input.resolvedBy?.trim() || 'operator'
      const note =
        typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.trim() : null

      const nextStatus = input.action === 'dismiss' ? 'dismissed' : 'actioned'
      const updatedReport: ModKitReportRecord = {
        ...report,
        status: nextStatus,
        resolution_note: note,
        resolved_by: resolvedBy,
        resolved_at: nowIso,
      }
      reportsById.set(report.id, updatedReport)

      const key = itemKey(report.target_type, report.target_id)
      const existingItem = itemsByKey.get(key)
      const authorId = existingItem?.author_id ?? report.target_author_id ?? 'unknown'

      if (input.action === 'remove' || input.action === 'ban') {
        itemsByKey.set(key, {
          target_type: report.target_type,
          target_id: report.target_id,
          author_id: authorId,
          status: 'rejected',
          classifier_provider: existingItem?.classifier_provider ?? null,
          classifier_categories: existingItem?.classifier_categories ?? {},
          classifier_scores: existingItem?.classifier_scores ?? {},
          created_at: existingItem?.created_at ?? nowIso,
          updated_at: nowIso,
        })
      } else if (input.action === 'dismiss' && existingItem && existingItem.status === 'flagged') {
        itemsByKey.set(key, {
          ...existingItem,
          status: 'approved',
          updated_at: nowIso,
        })
      }

      if (input.action === 'ban') {
        const targetUser = report.target_author_id ?? existingItem?.author_id
        if (!targetUser) {
          throw new ModKitError(
            400,
            'missing_target_author',
            'Cannot ban author because report has no target_author_id and item is unknown.',
          )
        }
        bansByUser.set(targetUser, {
          user_id: targetUser,
          reason: note ?? `Banned via report ${report.id} (${report.reason})`,
          banned_by: resolvedBy,
          created_at: nowIso,
          expires_at: null,
        })
      }

      return { ...updatedReport }
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
      const key = itemKey(targetType, targetId)
      const existing = itemsByKey.get(key)
      const record: ModKitItemRecord = {
        target_type: targetType,
        target_id: targetId,
        author_id: authorId,
        status: input.status,
        classifier_provider:
          input.classifierProvider !== undefined
            ? input.classifierProvider
            : (existing?.classifier_provider ?? null),
        classifier_categories: input.classifierCategories
          ? { ...input.classifierCategories }
          : (existing?.classifier_categories ?? {}),
        classifier_scores: input.classifierScores
          ? { ...input.classifierScores }
          : (existing?.classifier_scores ?? {}),
        created_at: existing?.created_at ?? nowIso,
        updated_at: nowIso,
      }
      itemsByKey.set(key, record)
      return {
        ...record,
        classifier_categories: { ...record.classifier_categories },
        classifier_scores: { ...record.classifier_scores },
      }
    },

    async getItem(targetType: string, targetId: string): Promise<ModKitItemRecord | null> {
      const row = itemsByKey.get(itemKey(targetType.trim(), targetId.trim()))
      if (!row) return null
      return {
        ...row,
        classifier_categories: { ...row.classifier_categories },
        classifier_scores: { ...row.classifier_scores },
      }
    },

    async addBan(input: AddBanInput): Promise<ModKitBanRecord> {
      const userId = input.userId.trim()
      const reason = input.reason.trim()
      if (!userId || !reason) {
        throw new ModKitError(400, 'invalid_ban', 'userId and reason must be non-empty strings.')
      }

      const nowIso = (input.now ?? new Date()).toISOString()
      const expiresAt =
        input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : typeof input.expiresAt === 'string' && input.expiresAt.trim().length > 0
            ? input.expiresAt.trim()
            : null

      const record: ModKitBanRecord = {
        user_id: userId,
        reason,
        banned_by: input.bannedBy?.trim() || null,
        created_at: nowIso,
        expires_at: expiresAt,
      }
      bansByUser.set(userId, record)
      return { ...record }
    },

    async removeBan(userId: string): Promise<boolean> {
      return bansByUser.delete(userId.trim())
    },

    async isBanned(userId: string, now?: Date): Promise<boolean> {
      const record = bansByUser.get(userId.trim())
      if (!record) return false
      if (!record.expires_at) return true
      const checkTime = (now ?? new Date()).getTime()
      return new Date(record.expires_at).getTime() > checkTime
    },

    async listBans(): Promise<ModKitBanRecord[]> {
      return Array.from(bansByUser.values())
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((b) => ({ ...b }))
    },
  }
}
