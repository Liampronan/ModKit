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

  return {
    name: 'openai',
    async classify(input: ModKitClassificationInput): Promise<ModKitClassificationResult> {
      const parts: OpenAIModerationInputPart[] = []
      const text = input.text?.trim() ?? ''
      if (text.length > 0) {
        parts.push({ type: 'text', text })
      }
      for (const rawUrl of input.imageUrls ?? []) {
        const url = rawUrl.trim()
        if (url.length > 0) {
          parts.push({ type: 'image_url', image_url: { url } })
        }
      }

      if (parts.length === 0) {
        return {
          provider: 'openai',
          flagged: false,
          categories: {},
          scores: {},
        }
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
        throw new ModKitError(
          502,
          'classifier_error',
          `OpenAI moderation request failed: ${reason}`,
        )
      }

      if (!response.ok) {
        throw new ModKitError(
          502,
          'classifier_error',
          `OpenAI moderation API failed with status ${response.status}.`,
        )
      }

      let payload: OpenAIModerationResponse
      try {
        payload = (await response.json()) as OpenAIModerationResponse
      } catch {
        throw new ModKitError(
          502,
          'classifier_error',
          'OpenAI moderation API returned invalid JSON.',
        )
      }

      const results = Array.isArray(payload.results) ? payload.results : []
      let flagged = false
      const categories: Record<string, boolean> = {}
      const scores: Record<string, number> = {}

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
