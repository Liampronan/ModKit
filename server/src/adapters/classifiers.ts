import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import { ModKitError } from '../errors.js'

export interface ModKitClassificationInput {
  targetType?: string | undefined
  targetId?: string | undefined
  authorId?: string | undefined
  text?: string | undefined
  imageUrls?: string[] | undefined
}

export interface ModKitClassificationResult {
  provider: string
  flagged: boolean
  categories: Record<string, boolean>
  scores: Record<string, number>
  partialErrors?: string[] | undefined
}

export interface ModKitClassifier {
  readonly name: string
  classify(input: ModKitClassificationInput): Promise<ModKitClassificationResult>
}

export interface OpenAIClassifierOptions {
  apiKey: string
  model?: string | undefined
  endpoint?: string | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
  /**
   * When true, fetches `http(s)://` image URLs in the server/edge function and sends
   * `data:<mime>;base64,...` URIs to OpenAI. Even when false (default), `openAIClassifier`
   * automatically falls back to fetching and inlining an image if OpenAI returns
   * `"Failed to download image"`.
   */
  inlineImages?: boolean | undefined
  /**
   * Maximum allowed image size in bytes when inlining images (defaults to 10 MiB).
   */
  maxImageBytes?: number | undefined
  /**
   * Number of retry attempts for transient failures (`429`, `5xx`, network errors, or
   * OpenAI `"Failed to download image"` errors). Defaults to `2`.
   */
  maxRetries?: number | undefined
  /**
   * Base backoff delay in milliseconds between retries. Defaults to `200`.
   */
  retryBaseDelayMs?: number | undefined
}

interface OpenAIModerationInputPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OpenAIModerationResult {
  flagged?: boolean
  categories?: Record<string, boolean>
  category_scores?: Record<string, number>
}

interface OpenAIModerationResponse {
  results?: OpenAIModerationResult[]
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 200

function inferImageMimeType(url: string, contentTypeHeader: string | null): string {
  if (contentTypeHeader) {
    const cleaned = contentTypeHeader.split(';')[0]?.trim().toLowerCase()
    if (cleaned && cleaned.startsWith('image/')) {
      return cleaned
    }
  }
  const lowerPath = url.split('?')[0]?.toLowerCase() ?? ''
  if (lowerPath.endsWith('.png')) return 'image/png'
  if (lowerPath.endsWith('.webp')) return 'image/webp'
  if (lowerPath.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

async function fetchImageAsDataUri(
  imageUrl: string,
  fetchFn: typeof globalThis.fetch,
  maxBytes: number,
): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    return imageUrl
  }

  let response: Response
  try {
    response = await fetchFn(imageUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error'
    throw new ModKitError(
      502,
      'classifier_image_fetch_error',
      `Failed to fetch image for OpenAI classification: ${reason}`,
    )
  }

  if (!response.ok) {
    throw new ModKitError(
      502,
      'classifier_image_fetch_error',
      `Failed to fetch image for OpenAI classification (status ${response.status}).`,
    )
  }

  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new ModKitError(
        413,
        'classifier_image_too_large',
        `Image size (${declaredBytes} bytes) exceeds maximum allowed size of ${maxBytes} bytes.`,
      )
    }
  }

  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > maxBytes) {
    throw new ModKitError(
      413,
      'classifier_image_too_large',
      `Image size (${arrayBuffer.byteLength} bytes) exceeds maximum allowed size of ${maxBytes} bytes.`,
    )
  }

  const mimeType = inferImageMimeType(imageUrl, response.headers.get('content-type'))
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return `data:${mimeType};base64,${base64}`
}

function isDownloadImageFailure(status: number, errorBody: string): boolean {
  if (status !== 400) return false
  const lower = errorBody.toLowerCase()
  return lower.includes('failed to download image') || lower.includes('could not download image')
}

function isRetryableStatus(status: number, errorBody: string): boolean {
  return status === 429 || status >= 500 || isDownloadImageFailure(status, errorBody)
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Multimodal content moderation classifier backed by OpenAI's `/v1/moderations` endpoint
 * (`omni-moderation-latest`), supporting both text and image URLs/data-URIs.
 */
export function openAIClassifier(options: OpenAIClassifierOptions): ModKitClassifier {
  const apiKey = options.apiKey.trim()
  if (!apiKey) {
    throw new Error('openAIClassifier requires a non-empty apiKey.')
  }
  const model = options.model ?? 'omni-moderation-latest'
  const endpoint = options.endpoint ?? 'https://api.openai.com/v1/moderations'
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const inlineImages = options.inlineImages ?? false
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS)

  async function sendBatchWithRetry(
    initialParts: OpenAIModerationInputPart[],
  ): Promise<OpenAIModerationResponse> {
    let parts: OpenAIModerationInputPart[] = initialParts.map((part) =>
      part.type === 'image_url' && part.image_url
        ? { type: 'image_url', image_url: { url: part.image_url.url } }
        : { ...part },
    )

    if (inlineImages) {
      parts = await Promise.all(
        parts.map(async (part): Promise<OpenAIModerationInputPart> => {
          if (part.type === 'image_url' && part.image_url && !part.image_url.url.startsWith('data:')) {
            const dataUri = await fetchImageAsDataUri(part.image_url.url, fetchFn, maxImageBytes)
            return { type: 'image_url', image_url: { url: dataUri } }
          }
          return part
        }),
      )
    }

    let lastError: ModKitError | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleepMs(retryBaseDelayMs * 2 ** (attempt - 1))
      }

      let response: Response
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: parts,
          }),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network error'
        lastError = new ModKitError(
          502,
          'classifier_error',
          `OpenAI moderation request failed: ${reason}`,
        )
        if (attempt < maxRetries) {
          continue
        }
        throw lastError
      }

      if (!response.ok) {
        let errorBody = ''
        try {
          errorBody = (await response.text()).trim()
        } catch {
          // Ignore failure reading error body
        }
        const detailSuffix = errorBody ? `: ${errorBody}` : '.'
        lastError = new ModKitError(
          502,
          'classifier_error',
          `OpenAI moderation API failed with status ${response.status}${detailSuffix}`,
        )

        if (attempt < maxRetries && isRetryableStatus(response.status, errorBody)) {
          if (isDownloadImageFailure(response.status, errorBody)) {
            parts = await Promise.all(
              parts.map(async (part): Promise<OpenAIModerationInputPart> => {
                if (
                  part.type === 'image_url' &&
                  part.image_url &&
                  !part.image_url.url.startsWith('data:')
                ) {
                  const dataUri = await fetchImageAsDataUri(
                    part.image_url.url,
                    fetchFn,
                    maxImageBytes,
                  )
                  return { type: 'image_url', image_url: { url: dataUri } }
                }
                return part
              }),
            )
          }
          continue
        }

        throw lastError
      }

      try {
        return (await response.json()) as OpenAIModerationResponse
      } catch {
        lastError = new ModKitError(
          502,
          'classifier_error',
          'OpenAI moderation API returned invalid JSON.',
        )
        if (attempt < maxRetries) {
          continue
        }
        throw lastError
      }
    }

    throw (
      lastError ??
      new ModKitError(502, 'classifier_error', 'OpenAI moderation classification failed.')
    )
  }

  return {
    name: 'openai',
    async classify(input: ModKitClassificationInput): Promise<ModKitClassificationResult> {
      const text = input.text?.trim() ?? ''
      const imageUrls = (input.imageUrls ?? []).map((u) => u.trim()).filter((u) => u.length > 0)

      const batches: OpenAIModerationInputPart[][] = []
      if (imageUrls.length === 0) {
        if (text.length > 0) {
          batches.push([{ type: 'text', text }])
        }
      } else {
        for (let i = 0; i < imageUrls.length; i++) {
          const imagePart: OpenAIModerationInputPart = {
            type: 'image_url',
            image_url: { url: imageUrls[i]! },
          }
          if (i === 0 && text.length > 0) {
            batches.push([{ type: 'text', text }, imagePart])
          } else {
            batches.push([imagePart])
          }
        }
      }

      if (batches.length === 0) {
        return {
          provider: 'openai',
          flagged: false,
          categories: {},
          scores: {},
        }
      }

      const settled = await Promise.allSettled(batches.map((parts) => sendBatchWithRetry(parts)))

      let flagged = false
      const categories: Record<string, boolean> = {}
      const scores: Record<string, number> = {}
      const partialErrors: string[] = []
      let firstError: unknown = null

      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          if (!firstError) {
            firstError = outcome.reason
          }
          const msg =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          partialErrors.push(msg)
          continue
        }

        const payload = outcome.value
        const results = Array.isArray(payload.results) ? payload.results : []
        for (const result of results) {
          if (result.flagged) {
            flagged = true
          }
          if (result.categories && typeof result.categories === 'object') {
            for (const [key, val] of Object.entries(result.categories)) {
              const isTrue = Boolean(val)
              categories[key] = Boolean(categories[key] || isTrue)
              if (isTrue) {
                flagged = true
              }
            }
          }
          if (result.category_scores && typeof result.category_scores === 'object') {
            for (const [key, val] of Object.entries(result.category_scores)) {
              const numericScore = typeof val === 'number' && Number.isFinite(val) ? val : 0
              scores[key] = Math.max(scores[key] ?? 0, numericScore)
            }
          }
        }
      }

      if (partialErrors.length > 0) {
        if (flagged) {
          categories.classification_error = true
          return {
            provider: 'openai',
            flagged: true,
            categories,
            scores,
            partialErrors,
          }
        }
        throw firstError instanceof Error
          ? firstError
          : new ModKitError(502, 'classifier_error', partialErrors.join('; '))
      }

      return {
        provider: 'openai',
        flagged,
        categories,
        scores,
      }
    },
  }
}

export interface RekognitionClassifierOptions {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  minConfidence?: number | undefined
  endpoint?: string | undefined
  fetchImpl?: typeof globalThis.fetch | undefined
  now?: (() => Date) | undefined
}

interface RekognitionModerationLabel {
  Name?: string
  ParentName?: string
  Confidence?: number
}

interface RekognitionDetectModerationLabelsResponse {
  ModerationLabels?: RekognitionModerationLabel[]
}

/**
 * Image moderation classifier backed by AWS Rekognition `DetectModerationLabels`.
 * Downloads each image URL (or decodes `data:` URIs), signs the AWS SigV4 request,
 * and aggregates moderation labels and confidence scores.
 */
export function rekognitionClassifier(options: RekognitionClassifierOptions): ModKitClassifier {
  const region = options.region.trim()
  const accessKeyId = options.accessKeyId.trim()
  const secretAccessKey = options.secretAccessKey.trim()
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'rekognitionClassifier requires non-empty region, accessKeyId, and secretAccessKey.',
    )
  }

  const minConfidence = options.minConfidence ?? 60
  const endpoint = options.endpoint ?? `https://rekognition.${region}.amazonaws.com/`
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const nowFn = options.now ?? (() => new Date())

  return {
    name: 'rekognition',
    async classify(input: ModKitClassificationInput): Promise<ModKitClassificationResult> {
      const imageUrls = (input.imageUrls ?? []).map((u) => u.trim()).filter(Boolean)
      if (imageUrls.length === 0) {
        return {
          provider: 'rekognition',
          flagged: false,
          categories: {},
          scores: {},
        }
      }

      let flagged = false
      const categories: Record<string, boolean> = {}
      const scores: Record<string, number> = {}

      for (const imageUrl of imageUrls) {
        const base64Bytes = await fetchImageAsBase64(imageUrl, fetchFn)
        const requestBody = JSON.stringify({
          Image: { Bytes: base64Bytes },
          MinConfidence: minConfidence,
        })

        const signedHeaders = signAwsSigV4({
          method: 'POST',
          url: endpoint,
          region,
          service: 'rekognition',
          accessKeyId,
          secretAccessKey,
          sessionToken: options.sessionToken,
          target: 'RekognitionService.DetectModerationLabels',
          contentType: 'application/x-amz-json-1.1',
          body: requestBody,
          now: nowFn(),
        })

        let response: Response
        try {
          response = await fetchFn(endpoint, {
            method: 'POST',
            headers: signedHeaders,
            body: requestBody,
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'network error'
          throw new ModKitError(
            502,
            'classifier_error',
            `AWS Rekognition request failed: ${reason}`,
          )
        }

        if (!response.ok) {
          throw new ModKitError(
            502,
            'classifier_error',
            `AWS Rekognition DetectModerationLabels failed with status ${response.status}.`,
          )
        }

        let payload: RekognitionDetectModerationLabelsResponse
        try {
          payload = (await response.json()) as RekognitionDetectModerationLabelsResponse
        } catch {
          throw new ModKitError(
            502,
            'classifier_error',
            'AWS Rekognition returned invalid JSON.',
          )
        }

        const labels = Array.isArray(payload.ModerationLabels) ? payload.ModerationLabels : []
        for (const label of labels) {
          const rawName = label.Name?.trim()
          if (!rawName) continue
          const confidence =
            typeof label.Confidence === 'number' && Number.isFinite(label.Confidence)
              ? label.Confidence
              : 0
          const normalizedKey = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
          const normalizedScore = Number((confidence / 100).toFixed(4))
          scores[normalizedKey] = Math.max(scores[normalizedKey] ?? 0, normalizedScore)
          if (confidence >= minConfidence) {
            categories[normalizedKey] = true
            flagged = true
          } else if (!(normalizedKey in categories)) {
            categories[normalizedKey] = false
          }
        }
      }

      return {
        provider: 'rekognition',
        flagged,
        categories,
        scores,
      }
    },
  }
}

async function fetchImageAsBase64(
  imageUrl: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    const commaIdx = imageUrl.indexOf(',')
    if (commaIdx === -1) {
      throw new ModKitError(400, 'invalid_image_url', 'Invalid data URI provided to classifier.')
    }
    return imageUrl.slice(commaIdx + 1)
  }

  let response: Response
  try {
    response = await fetchFn(imageUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error'
    throw new ModKitError(
      502,
      'classifier_image_fetch_error',
      `Failed to fetch image for Rekognition classification: ${reason}`,
    )
  }

  if (!response.ok) {
    throw new ModKitError(
      502,
      'classifier_image_fetch_error',
      `Failed to fetch image for Rekognition classification (status ${response.status}).`,
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer).toString('base64')
}

interface AwsSigV4Input {
  method: string
  url: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  target: string
  contentType: string
  body: string
  now: Date
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function signAwsSigV4(input: AwsSigV4Input): Record<string, string> {
  const parsedUrl = new URL(input.url)
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(input.body)

  const headerMap: Record<string, string> = {
    'content-type': input.contentType,
    host: parsedUrl.host,
    'x-amz-date': amzDate,
    'x-amz-target': input.target,
  }
  if (input.sessionToken) {
    headerMap['x-amz-security-token'] = input.sessionToken
  }

  const sortedHeaderKeys = Object.keys(headerMap).sort()
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headerMap[k]}\n`).join('')
  const signedHeaders = sortedHeaderKeys.join(';')

  const canonicalRequest = [
    input.method,
    parsedUrl.pathname || '/',
    parsedUrl.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, input.region)
  const kService = hmacSha256(kRegion, input.service)
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    ...headerMap,
    authorization,
  }
}
