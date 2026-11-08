import { Buffer } from 'node:buffer'
import type { ModKitClassifier } from './adapters/classifiers.js'
import type { ModKitNotifier } from './adapters/notifiers.js'
import {
  extractBearerToken,
  verifySecretConstantTime,
  type ModKitAuthPrincipal,
  type ModKitAuthenticator,
} from './auth.js'
import { ModKitError, errorResponse } from './errors.js'
import {
  MODKIT_REPORT_REASONS,
  type ModKitReportReason,
  type ModKitStore,
} from './store.js'

export interface DatabaseWebhookPayload {
  type?: string | undefined
  table?: string | undefined
  schema?: string | undefined
  record: Record<string, unknown>
  old_record?: Record<string, unknown> | null | undefined
}

export interface ExtractedContentItem {
  targetType: string
  targetId: string
  authorId: string
  text?: string | undefined
  imageUrls?: string[] | undefined
}

export type ModKitContentExtractor = (
  payload: DatabaseWebhookPayload,
) => Promise<ExtractedContentItem | null> | ExtractedContentItem | null

export interface ModKitServerOptions {
  store: ModKitStore
  authenticate: ModKitAuthenticator | ModKitAuthenticator[]
  classifier?: ModKitClassifier | undefined
  notifier?: ModKitNotifier | ModKitNotifier[] | undefined
  webhookSecret?: string | undefined
  contentExtractor?: ModKitContentExtractor | undefined
  autoHideOnReport?: boolean | undefined
  notifyOnRejectedContent?: boolean | undefined
  maxBodyBytes?: number | undefined
  now?: (() => Date) | undefined
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, x-modkit-webhook-secret, apikey, x-client-info',
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v)
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function normalizePath(pathname: string): string {
  const cleaned = pathname.replace(/\/+$/, '') || '/'
  const v1Idx = cleaned.lastIndexOf('/v1/')
  if (v1Idx !== -1) {
    return cleaned.slice(v1Idx)
  }
  if (cleaned.endsWith('/v1')) {
    return '/v1'
  }
  return cleaned
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const rawText = await request.text()
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    throw new ModKitError(
      413,
      'payload_too_large',
      `Request body exceeds maximum size of ${maxBytes} bytes.`,
    )
  }
  if (!rawText.trim()) {
    throw new ModKitError(400, 'invalid_json', 'Request body must be a non-empty JSON object.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new ModKitError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModKitError(400, 'invalid_json', 'Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function defaultContentExtractor(payload: DatabaseWebhookPayload): ExtractedContentItem {
  const record = payload.record
  const targetType =
    (typeof record.target_type === 'string' && record.target_type.trim()) ||
    (typeof payload.table === 'string' && payload.table.trim()) ||
    'item'
  const rawId = record.target_id ?? record.id
  const rawAuthorId = record.author_id ?? record.user_id
  const targetId = rawId !== undefined && rawId !== null ? String(rawId).trim() : ''
  const authorId =
    rawAuthorId !== undefined && rawAuthorId !== null ? String(rawAuthorId).trim() : ''

  if (!targetId || !authorId) {
    throw new ModKitError(
      400,
      'invalid_webhook_payload',
      'Webhook record must include id/target_id and user_id/author_id.',
    )
  }

  const text =
    typeof record.text === 'string'
      ? record.text
      : typeof record.description === 'string'
        ? record.description
        : typeof record.content === 'string'
          ? record.content
          : ''

  const imageUrls = Array.isArray(record.image_urls)
    ? record.image_urls.filter((u): u is string => typeof u === 'string')
    : Array.isArray(record.imageUrls)
      ? record.imageUrls.filter((u): u is string => typeof u === 'string')
      : []

  return {
    targetType,
    targetId,
    authorId,
    text,
    imageUrls,
  }
}

/**
 * Creates a standard Web `Request` -> `Response` HTTP handler implementing the ModKit `/v1` wire spec.
 * Runs identically on Supabase Edge Functions (`Deno.serve`) and Node.js 22+.
 */
export function createModKitServer(
  options: ModKitServerOptions,
): (request: Request) => Promise<Response> {
  const authenticators = Array.isArray(options.authenticate)
    ? options.authenticate
    : [options.authenticate]
  const notifiers = options.notifier
    ? Array.isArray(options.notifier)
      ? options.notifier
      : [options.notifier]
    : []
  const autoHideOnReport = options.autoHideOnReport ?? true
  const notifyOnRejectedContent = options.notifyOnRejectedContent ?? true
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const nowFn = options.now ?? (() => new Date())
  const extractContent = options.contentExtractor ?? defaultContentExtractor

  async function authenticateRequest(request: Request): Promise<ModKitAuthPrincipal> {
    for (const auth of authenticators) {
      const principal = await auth(request)
      if (principal && principal.userId.trim().length > 0) {
        return {
          userId: principal.userId.trim(),
          email: principal.email ?? null,
        }
      }
    }
    throw new ModKitError(401, 'unauthorized', 'Missing or invalid authentication token.')
  }

  function verifyWebhookAuth(request: Request): void {
    const expectedSecret = options.webhookSecret?.trim()
    if (!expectedSecret) {
      throw new ModKitError(
        401,
        'webhook_secret_not_configured',
        'Webhook endpoint requires webhookSecret to be configured.',
      )
    }

    const headerSecret = request.headers.get('x-modkit-webhook-secret')?.trim()
    const bearerSecret = extractBearerToken(request)
    const candidate = headerSecret || bearerSecret
    if (!candidate || !verifySecretConstantTime(candidate, expectedSecret)) {
      throw new ModKitError(401, 'unauthorized', 'Invalid or missing webhook secret.')
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      const url = new URL(request.url)
      const path = normalizePath(url.pathname)
      const method = request.method.toUpperCase()

      // 2.1 GET /v1/state
      if (method === 'GET' && path === '/v1/state') {
        const principal = await authenticateRequest(request)
        const state = await options.store.getUserState(principal.userId)
        return withCors(Response.json(state, { status: 200 }))
      }

      // 2.2 POST /v1/terms/accept
      if (method === 'POST' && path === '/v1/terms/accept') {
        const principal = await authenticateRequest(request)
        const body = await readJsonBody(request, maxBodyBytes)
        const termsVersion =
          typeof body.terms_version === 'string' ? body.terms_version.trim() : ''
        if (!termsVersion) {
          throw new ModKitError(
            400,
            'invalid_terms_version',
            'terms_version must be a non-empty string.',
          )
        }
        const record = await options.store.acceptTerms({
          userId: principal.userId,
          termsVersion,
          now: nowFn(),
        })
        return withCors(Response.json(record, { status: 200 }))
      }

      // 2.3 POST /v1/reports
      if (method === 'POST' && path === '/v1/reports') {
        const principal = await authenticateRequest(request)
        const body = await readJsonBody(request, maxBodyBytes)
        const targetType = typeof body.target_type === 'string' ? body.target_type.trim() : ''
        const targetId = typeof body.target_id === 'string' ? body.target_id.trim() : ''
        const targetAuthorId =
          typeof body.target_author_id === 'string' && body.target_author_id.trim().length > 0
            ? body.target_author_id.trim()
            : null
        const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
        const details =
          typeof body.details === 'string' && body.details.trim().length > 0
            ? body.details.trim()
            : null

        if (!targetType || !targetId) {
          throw new ModKitError(
            400,
            'invalid_report',
            'target_type and target_id must be non-empty strings.',
          )
        }
        if (!MODKIT_REPORT_REASONS.includes(reason as ModKitReportReason)) {
          throw new ModKitError(
            400,
            'invalid_reason',
            `reason must be one of: ${MODKIT_REPORT_REASONS.join(', ')}.`,
          )
        }

        const report = await options.store.createReport({
          reporterId: principal.userId,
          targetType,
          targetId,
          targetAuthorId,
          reason: reason as ModKitReportReason,
          details,
          autoFlagItem: autoHideOnReport,
          now: nowFn(),
        })

        for (const notifier of notifiers) {
          try {
            await notifier.notify({
              kind: 'report_submitted',
              report,
            })
          } catch (notifyErr) {
            console.error(`[modkit] notifier "${notifier.name}" failed on report ${report.id}:`, notifyErr)
          }
        }

        return withCors(
          Response.json(
            {
              id: report.id,
              status: report.status,
              created_at: report.created_at,
            },
            { status: 201 },
          ),
        )
      }

      // 2.4 POST /v1/blocks
      if (method === 'POST' && path === '/v1/blocks') {
        const principal = await authenticateRequest(request)
        const body = await readJsonBody(request, maxBodyBytes)
        const blockedUserId =
          typeof body.blocked_user_id === 'string' ? body.blocked_user_id.trim() : ''
        if (!blockedUserId) {
          throw new ModKitError(
            400,
            'invalid_block',
            'blocked_user_id must be a non-empty string.',
          )
        }

        const block = await options.store.blockUser({
          blockerId: principal.userId,
          blockedUserId,
          now: nowFn(),
        })

        return withCors(
          Response.json(
            {
              blocker_id: block.blocker_id,
              blocked_user_id: block.blocked_user_id,
              created_at: block.created_at,
            },
            { status: 200 },
          ),
        )
      }

      // 2.5 DELETE /v1/blocks/:blockedUserId
      if (method === 'DELETE' && path.startsWith('/v1/blocks/')) {
        const principal = await authenticateRequest(request)
        const rawBlockedId = path.slice('/v1/blocks/'.length)
        let blockedUserId = ''
        try {
          blockedUserId = decodeURIComponent(rawBlockedId).trim()
        } catch {
          throw new ModKitError(400, 'invalid_unblock', 'Malformed blockedUserId path parameter.')
        }
        if (!blockedUserId || blockedUserId.includes('/')) {
          throw new ModKitError(
            400,
            'invalid_unblock',
            'blockedUserId must be a non-empty string.',
          )
        }

        await options.store.unblockUser({
          blockerId: principal.userId,
          blockedUserId,
        })

        return withCors(
          Response.json(
            {
              unblocked_user_id: blockedUserId,
            },
            { status: 200 },
          ),
        )
      }

      // 2.6 POST /v1/webhooks/content
      if (method === 'POST' && path === '/v1/webhooks/content') {
        verifyWebhookAuth(request)
        const body = await readJsonBody(request, maxBodyBytes)
        const recordObj =
          body.record && typeof body.record === 'object' && !Array.isArray(body.record)
            ? (body.record as Record<string, unknown>)
            : body

        const webhookPayload: DatabaseWebhookPayload = {
          type: typeof body.type === 'string' ? body.type : 'INSERT',
          table: typeof body.table === 'string' ? body.table : undefined,
          schema: typeof body.schema === 'string' ? body.schema : undefined,
          record: recordObj,
          old_record:
            body.old_record && typeof body.old_record === 'object' && !Array.isArray(body.old_record)
              ? (body.old_record as Record<string, unknown>)
              : null,
        }

        const extracted = await extractContent(webhookPayload)
        if (!extracted) {
          return withCors(
            Response.json(
              {
                skipped: true,
              },
              { status: 200 },
            ),
          )
        }

        let flagged = false
        let provider: string | null = null
        let categories: Record<string, boolean> = {}
        let scores: Record<string, number> = {}

        if (options.classifier) {
          const result = await options.classifier.classify({
            targetType: extracted.targetType,
            targetId: extracted.targetId,
            authorId: extracted.authorId,
            text: extracted.text,
            imageUrls: extracted.imageUrls,
          })
          flagged = result.flagged
          provider = result.provider
          categories = result.categories
          scores = result.scores
        }

        const status = flagged ? 'rejected' : 'approved'
        const item = await options.store.upsertItem({
          targetType: extracted.targetType,
          targetId: extracted.targetId,
          authorId: extracted.authorId,
          status,
          classifierProvider: provider,
          classifierCategories: categories,
          classifierScores: scores,
          now: nowFn(),
        })

        if (flagged && notifyOnRejectedContent) {
          for (const notifier of notifiers) {
            try {
              await notifier.notify({
                kind: 'content_rejected',
                item,
              })
            } catch (notifyErr) {
              console.error(
                `[modkit] notifier "${notifier.name}" failed on rejected item ${item.target_type}/${item.target_id}:`,
                notifyErr,
              )
            }
          }
        }

        return withCors(
          Response.json(
            {
              target_type: item.target_type,
              target_id: item.target_id,
              status: item.status,
              flagged,
            },
            { status: 200 },
          ),
        )
      }

      throw new ModKitError(404, 'not_found', `Route not found: ${method} ${path}`)
    } catch (error) {
      return withCors(errorResponse(error))
    }
  }
}
