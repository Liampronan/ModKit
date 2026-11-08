export interface ConformanceStepResult {
  name: string
  ok: boolean
  detail?: string | undefined
}

export interface ConformanceSuiteResult {
  ok: boolean
  steps: ConformanceStepResult[]
}

export interface RunConformanceSuiteOptions {
  baseUrl: string
  userAToken: string
  userBToken?: string | undefined
  webhookSecret?: string | undefined
  fetch?: typeof globalThis.fetch | undefined
}

/**
 * Runs an end-to-end HTTP `/v1` conformance suite against a ModKit server URL or handler.
 */
export async function runConformanceSuite(
  options: RunConformanceSuiteOptions,
): Promise<ConformanceSuiteResult> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const steps: ConformanceStepResult[] = []

  async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
      steps.push({ name, ok: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      steps.push({ name, ok: false, detail })
    }
  }

  function authHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }
  }

  // 1. Unauthenticated GET /v1/state returns 401
  await runStep('GET /v1/state rejects unauthenticated requests with 401', async () => {
    const res = await fetchFn(`${baseUrl}/v1/state`, { method: 'GET' })
    if (res.status !== 401) {
      throw new Error(`Expected 401, got ${res.status}`)
    }
  })

  // 2. Authenticated GET /v1/state returns initial state structure
  let userAId = ''
  await runStep('GET /v1/state returns user moderation state', async () => {
    const res = await fetchFn(`${baseUrl}/v1/state`, {
      method: 'GET',
      headers: authHeaders(options.userAToken),
    })
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }
    const body = (await res.json()) as {
      user_id?: string
      accepted_terms_versions?: string[]
      blocked_user_ids?: string[]
      hidden_items?: unknown[]
    }
    if (!body.user_id || !Array.isArray(body.accepted_terms_versions)) {
      throw new Error('Malformed /v1/state payload')
    }
    userAId = body.user_id
  })

  // 3. POST /v1/terms/accept records EULA version
  await runStep('POST /v1/terms/accept records terms version', async () => {
    const res = await fetchFn(`${baseUrl}/v1/terms/accept`, {
      method: 'POST',
      headers: authHeaders(options.userAToken),
      body: JSON.stringify({ terms_version: '2026-11-01' }),
    })
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }
    const body = (await res.json()) as { terms_version?: string; accepted_at?: string }
    if (body.terms_version !== '2026-11-01' || !body.accepted_at) {
      throw new Error('Invalid /v1/terms/accept response')
    }
  })

  // 4. POST /v1/blocks blocks another user and rejects self-block
  const blockedId = '99999999-0000-0000-0000-000000000002'
  await runStep('POST /v1/blocks blocks target user and rejects self-block', async () => {
    if (userAId) {
      const selfRes = await fetchFn(`${baseUrl}/v1/blocks`, {
        method: 'POST',
        headers: authHeaders(options.userAToken),
        body: JSON.stringify({ blocked_user_id: userAId }),
      })
      if (selfRes.status !== 400) {
        throw new Error(`Expected 400 on self-block, got ${selfRes.status}`)
      }
    }

    const res = await fetchFn(`${baseUrl}/v1/blocks`, {
      method: 'POST',
      headers: authHeaders(options.userAToken),
      body: JSON.stringify({ blocked_user_id: blockedId }),
    })
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }
    const body = (await res.json()) as { blocked_user_id?: string }
    if (body.blocked_user_id !== blockedId) {
      throw new Error('Invalid /v1/blocks response')
    }
  })

  // 5. POST /v1/reports submits report and adds target to hidden_items
  const reportedTargetId = 'df039bb9-4651-4cfa-9039-5667513802b6'
  await runStep('POST /v1/reports creates report and updates hidden_items in /v1/state', async () => {
    const res = await fetchFn(`${baseUrl}/v1/reports`, {
      method: 'POST',
      headers: authHeaders(options.userAToken),
      body: JSON.stringify({
        target_type: 'trash_pickup',
        target_id: reportedTargetId,
        target_author_id: blockedId,
        reason: 'objectionable',
        details: 'Inappropriate photo',
      }),
    })
    if (res.status !== 201) {
      throw new Error(`Expected 201, got ${res.status}`)
    }
    const body = (await res.json()) as { id?: string; status?: string }
    if (!body.id || body.status !== 'open') {
      throw new Error('Invalid /v1/reports response')
    }

    const stateRes = await fetchFn(`${baseUrl}/v1/state`, {
      method: 'GET',
      headers: authHeaders(options.userAToken),
    })
    const state = (await stateRes.json()) as {
      accepted_terms_versions: string[]
      blocked_user_ids: string[]
      hidden_items: { target_type: string; target_id: string }[]
    }
    if (!state.accepted_terms_versions.includes('2026-11-01')) {
      throw new Error('accepted_terms_versions missing 2026-11-01')
    }
    if (!state.blocked_user_ids.includes(blockedId)) {
      throw new Error('blocked_user_ids missing blocked user')
    }
    if (
      !state.hidden_items.some(
        (i) => i.target_type === 'trash_pickup' && i.target_id === reportedTargetId,
      )
    ) {
      throw new Error('hidden_items missing reported item')
    }
  })

  // 6. DELETE /v1/blocks/:blockedUserId unblocks user
  await runStep('DELETE /v1/blocks/:blockedUserId removes block', async () => {
    const res = await fetchFn(`${baseUrl}/v1/blocks/${encodeURIComponent(blockedId)}`, {
      method: 'DELETE',
      headers: authHeaders(options.userAToken),
    })
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`)
    }
    const body = (await res.json()) as { unblocked_user_id?: string }
    if (body.unblocked_user_id !== blockedId) {
      throw new Error('Invalid unblock response')
    }

    const stateRes = await fetchFn(`${baseUrl}/v1/state`, {
      method: 'GET',
      headers: authHeaders(options.userAToken),
    })
    const state = (await stateRes.json()) as { blocked_user_ids: string[] }
    if (state.blocked_user_ids.includes(blockedId)) {
      throw new Error('User still present in blocked_user_ids after DELETE')
    }
  })

  // 7. POST /v1/webhooks/content processes Database Webhook payload when webhookSecret is provided
  if (options.webhookSecret) {
    await runStep('POST /v1/webhooks/content verifies secret and classifies content', async () => {
      const unauthRes = await fetchFn(`${baseUrl}/v1/webhooks/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record: { id: 'item-1', user_id: blockedId } }),
      })
      if (unauthRes.status !== 401) {
        throw new Error(`Expected 401 without webhook secret, got ${unauthRes.status}`)
      }

      const res = await fetchFn(`${baseUrl}/v1/webhooks/content`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-modkit-webhook-secret': options.webhookSecret!,
        },
        body: JSON.stringify({
          type: 'INSERT',
          table: 'trash_pickup',
          schema: 'public',
          record: {
            id: 'clean-item-1',
            user_id: blockedId,
            description: 'Cleaned up 2 bags of litter at the park!',
          },
        }),
      })
      if (res.status !== 200) {
        throw new Error(`Expected 200 from webhook, got ${res.status}`)
      }
      const body = (await res.json()) as {
        target_type?: string
        target_id?: string
        status?: string
        flagged?: boolean
      }
      if (body.target_id !== 'clean-item-1' || body.status !== 'approved' || body.flagged !== false) {
        throw new Error(`Unexpected webhook classification response: ${JSON.stringify(body)}`)
      }
    })
  }

  return {
    ok: steps.every((s) => s.ok),
    steps,
  }
}
