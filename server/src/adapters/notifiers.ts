import { ModKitError } from '../errors.js'
import type { ModKitItemRecord, ModKitReportRecord } from '../store.js'

export interface ModKitReportAlertEvent {
  kind: 'report_submitted'
  report: ModKitReportRecord
}

export interface ModKitClassifierRejectedAlertEvent {
  kind: 'content_rejected'
  item: ModKitItemRecord
}

export type ModKitAlertEvent = ModKitReportAlertEvent | ModKitClassifierRejectedAlertEvent

export interface ModKitNotifier {
  readonly name: string
  notify(event: ModKitAlertEvent): Promise<void>
}

export interface SlackNotifierOptions {
  webhookUrl: string
  fetchImpl?: typeof globalThis.fetch | undefined
}

function formatAlertSummary(event: ModKitAlertEvent): {
  subject: string
  text: string
} {
  if (event.kind === 'report_submitted') {
    const r = event.report
    const lines = [
      `🚨 *[ModKit] User Content Report (${r.reason})*`,
      `• *Report ID:* \`${r.id}\``,
      `• *Target:* \`${r.target_type}/${r.target_id}\``,
      `• *Author:* \`${r.target_author_id ?? 'unknown'}\``,
      `• *Reporter:* \`${r.reporter_id}\``,
      ...(r.details ? [`• *Details:* ${r.details}`] : []),
      `• *Created At:* ${r.created_at}`,
      `• *Triage SLA:* Action required within 24 hours (\`npx modkit-server reports resolve ${r.id} --action remove|dismiss|ban\`)`,
    ]
    return {
      subject: `[ModKit] Content Report (${r.reason}): ${r.target_type}/${r.target_id}`,
      text: lines.join('\n'),
    }
  }

  const item = event.item
  const triggeredCategories = Object.entries(item.classifier_categories)
    .filter(([, flagged]) => flagged)
    .map(([cat]) => cat)
  const lines = [
    `🛑 *[ModKit] Automated Classifier Rejected Content*`,
    `• *Target:* \`${item.target_type}/${item.target_id}\``,
    `• *Author:* \`${item.author_id}\``,
    `• *Provider:* \`${item.classifier_provider ?? 'unknown'}\``,
    `• *Categories:* ${triggeredCategories.length > 0 ? triggeredCategories.join(', ') : 'flagged'}`,
    `• *Updated At:* ${item.updated_at}`,
  ]
  return {
    subject: `[ModKit] Classifier Rejected: ${item.target_type}/${item.target_id}`,
    text: lines.join('\n'),
  }
}

/**
 * Slack Incoming Webhook notification adapter for immediate report and moderation alerts.
 */
export function slackNotifier(options: SlackNotifierOptions): ModKitNotifier {
  const webhookUrl = options.webhookUrl.trim()
  if (!webhookUrl) {
    throw new Error('slackNotifier requires a non-empty webhookUrl.')
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch

  return {
    name: 'slack',
    async notify(event: ModKitAlertEvent): Promise<void> {
      const { text } = formatAlertSummary(event)

      let response: Response
      try {
        response = await fetchFn(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network error'
        throw new ModKitError(
          502,
          'notifier_error',
          `Slack webhook notification failed: ${reason}`,
        )
      }

      if (!response.ok) {
        throw new ModKitError(
          502,
          'notifier_error',
          `Slack webhook returned status ${response.status}.`,
        )
      }
    },
  }
}

export interface EmailNotifierOptions {
  apiKey: string
  from: string
  to: string | string[]
  endpoint?: string | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
}

/**
 * Resend-compatible HTTP email notification adapter for immediate report and moderation alerts.
 */
export function emailNotifier(options: EmailNotifierOptions): ModKitNotifier {
  const apiKey = options.apiKey.trim()
  const from = options.from.trim()
  const recipients = (Array.isArray(options.to) ? options.to : [options.to])
    .map((addr) => addr.trim())
    .filter(Boolean)

  if (!apiKey || !from || recipients.length === 0) {
    throw new Error('emailNotifier requires non-empty apiKey, from, and to recipient(s).')
  }

  const endpoint = options.endpoint ?? 'https://api.resend.com/emails'
  const fetchFn = options.fetchImpl ?? globalThis.fetch

  return {
    name: 'email',
    async notify(event: ModKitAlertEvent): Promise<void> {
      const { subject, text } = formatAlertSummary(event)

      let response: Response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: recipients,
            subject,
            text,
          }),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network error'
        throw new ModKitError(502, 'notifier_error', `Email notification request failed: ${reason}`)
      }

      if (!response.ok) {
        throw new ModKitError(
          502,
          'notifier_error',
          `Email notification API returned status ${response.status}.`,
        )
      }
    },
  }
}
