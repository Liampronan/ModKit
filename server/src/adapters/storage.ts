import { ModKitError } from '../errors.js'

export interface SupabaseStorageOptions {
  url: string
  serviceRoleKey: string
  bucket: string
  fetchImpl?: typeof globalThis.fetch | undefined
}

export interface SupabaseStorageHelper {
  createSignedReadUrl(key: string, expiresInSeconds?: number): Promise<string>
}

/**
 * Helper for generating short-lived signed read URLs from a private Supabase Storage bucket
 * so moderation classifiers (OpenAI / Rekognition) can inspect newly uploaded images.
 */
export function supabaseStorage(options: SupabaseStorageOptions): SupabaseStorageHelper {
  const baseUrl = options.url.trim().replace(/\/+$/, '')
  const serviceRoleKey = options.serviceRoleKey.trim()
  const bucket = options.bucket.trim()
  if (!baseUrl || !serviceRoleKey || !bucket) {
    throw new Error('supabaseStorage requires non-empty url, serviceRoleKey, and bucket.')
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch

  return {
    async createSignedReadUrl(key: string, expiresInSeconds = 300): Promise<string> {
      const encodedKey = encodeStorageKey(key)
      const endpoint = `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedKey}`

      let response: Response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network error'
        throw new ModKitError(
          502,
          'storage_error',
          `Supabase storage sign request failed: ${reason}`,
        )
      }

      if (!response.ok) {
        throw new ModKitError(
          502,
          'storage_error',
          `Supabase storage sign failed with status ${response.status}.`,
        )
      }

      let payload: {
        signedURL?: string
        signedUrl?: string
        url?: string
      }
      try {
        payload = (await response.json()) as {
          signedURL?: string
          signedUrl?: string
          url?: string
        }
      } catch {
        throw new ModKitError(
          502,
          'storage_error',
          'Supabase storage sign returned invalid JSON.',
        )
      }

      const rawUrl = payload.signedURL ?? payload.signedUrl ?? payload.url
      if (!rawUrl || typeof rawUrl !== 'string') {
        throw new ModKitError(
          502,
          'storage_error',
          'Supabase storage sign response did not include signedURL.',
        )
      }

      return normalizeSupabaseSignedUrl(baseUrl, rawUrl)
    },
  }
}

function normalizeSupabaseSignedUrl(baseUrl: string, rawUrl: string): string {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl
  }
  if (rawUrl.startsWith('/storage/v1/')) {
    return `${baseUrl}${rawUrl}`
  }
  if (rawUrl.startsWith('/object/')) {
    return `${baseUrl}/storage/v1${rawUrl}`
  }
  return `${baseUrl}/${rawUrl.replace(/^\/+/, '')}`
}

function encodeStorageKey(key: string): string {
  const normalizedKey = key.replace(/^\/+/, '')
  if (!normalizedKey || normalizedKey.endsWith('/')) {
    throw new ModKitError(400, 'invalid_storage_key', 'Storage key must be a non-empty object path.')
  }
  const segments = normalizedKey.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new ModKitError(
        400,
        'invalid_storage_key',
        'Storage key must not contain empty or dot path segments.',
      )
    }
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}
