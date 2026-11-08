export class ModKitError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ModKitError'
    this.status = status
    this.code = code
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ModKitError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status },
    )
  }

  console.error('[modkit] unexpected handler error', error)

  return Response.json(
    { ok: false, error: { code: 'internal_error', message: 'Unexpected server error.' } },
    { status: 500 },
  )
}
