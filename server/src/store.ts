export type ModKitReportReason =
  | 'objectionable'
  | 'spam'
  | 'harassment'
  | 'unsafe'
  | 'other'

export const MODKIT_REPORT_REASONS: ReadonlyArray<ModKitReportReason> = [
  'objectionable',
  'spam',
  'harassment',
  'unsafe',
  'other',
]

export type ModKitReportStatus = 'open' | 'actioned' | 'dismissed'
export const MODKIT_REPORT_STATUSES: ReadonlyArray<ModKitReportStatus> = [
  'open',
  'actioned',
  'dismissed',
]

export type ModKitItemStatus = 'pending' | 'approved' | 'rejected' | 'flagged'
export const MODKIT_ITEM_STATUSES: ReadonlyArray<ModKitItemStatus> = [
  'pending',
  'approved',
  'rejected',
  'flagged',
]

export type ModKitResolutionAction = 'remove' | 'dismiss' | 'ban'

export interface ModKitHiddenItem {
  target_type: string
  target_id: string
}

export interface ModKitUserState {
  user_id: string
  accepted_terms_versions: string[]
  blocked_user_ids: string[]
  hidden_items: ModKitHiddenItem[]
}

export interface ModKitTermsAcceptanceRecord {
  user_id: string
  terms_version: string
  accepted_at: string
}

export interface ModKitBlockRecord {
  blocker_id: string
  blocked_user_id: string
  created_at: string
}

export interface ModKitBanRecord {
  user_id: string
  reason: string
  banned_by: string | null
  created_at: string
  expires_at: string | null
}

export interface ModKitItemRecord {
  target_type: string
  target_id: string
  author_id: string
  status: ModKitItemStatus
  classifier_provider: string | null
  classifier_categories: Record<string, boolean>
  classifier_scores: Record<string, number>
  created_at: string
  updated_at: string
}

export interface ModKitReportRecord {
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
  created_at: string
  resolved_at: string | null
}

export interface AcceptTermsInput {
  userId: string
  termsVersion: string
  now?: Date | undefined
}

export interface BlockUserInput {
  blockerId: string
  blockedUserId: string
  now?: Date | undefined
}

export interface UnblockUserInput {
  blockerId: string
  blockedUserId: string
}

export interface CreateReportInput {
  id?: string | undefined
  reporterId: string
  targetType: string
  targetId: string
  targetAuthorId?: string | null | undefined
  reason: ModKitReportReason
  details?: string | null | undefined
  autoFlagItem?: boolean | undefined
  now?: Date | undefined
}

export interface ListReportsFilter {
  status?: ModKitReportStatus | undefined
  targetType?: string | undefined
  targetId?: string | undefined
  limit?: number | undefined
}

export interface ResolveReportInput {
  reportId: string
  action: ModKitResolutionAction
  note?: string | null | undefined
  resolvedBy?: string | null | undefined
  now?: Date | undefined
}

export interface UpsertItemInput {
  targetType: string
  targetId: string
  authorId: string
  status: ModKitItemStatus
  classifierProvider?: string | null | undefined
  classifierCategories?: Record<string, boolean> | undefined
  classifierScores?: Record<string, number> | undefined
  now?: Date | undefined
}

export interface AddBanInput {
  userId: string
  reason: string
  bannedBy?: string | null | undefined
  expiresAt?: string | Date | null | undefined
  now?: Date | undefined
}

export interface ModKitStore {
  getUserState(userId: string): Promise<ModKitUserState>
  acceptTerms(input: AcceptTermsInput): Promise<ModKitTermsAcceptanceRecord>
  blockUser(input: BlockUserInput): Promise<ModKitBlockRecord>
  unblockUser(input: UnblockUserInput): Promise<void>
  createReport(input: CreateReportInput): Promise<ModKitReportRecord>
  getReportById(reportId: string): Promise<ModKitReportRecord | null>
  listReports(filter?: ListReportsFilter): Promise<ModKitReportRecord[]>
  resolveReport(input: ResolveReportInput): Promise<ModKitReportRecord | null>
  upsertItem(input: UpsertItemInput): Promise<ModKitItemRecord>
  getItem(targetType: string, targetId: string): Promise<ModKitItemRecord | null>
  addBan(input: AddBanInput): Promise<ModKitBanRecord>
  removeBan(userId: string): Promise<boolean>
  isBanned(userId: string, now?: Date): Promise<boolean>
  listBans(): Promise<ModKitBanRecord[]>
}
