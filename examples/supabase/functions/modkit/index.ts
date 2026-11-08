import {
  createModKitServer,
  openAIClassifier,
  postgresStore,
  slackNotifier,
  supabaseJwt,
  supabaseStorage,
} from 'npm:modkit-server@1.0.0-beta.1'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const store = postgresStore({
  url: Deno.env.get('MODKIT_DB_POOLER_URL')!,
  max: 2,
  prepare: false,
  fetchTypes: false,
})

const storage = supabaseStorage({
  url: supabaseUrl,
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  bucket: Deno.env.get('MODKIT_STORAGE_BUCKET') ?? 'trash-pickup-images',
})

Deno.serve(
  createModKitServer({
    store,
    authenticate: [
      supabaseJwt({
        jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
        secret: Deno.env.get('MODKIT_JWT_SECRET'),
      }),
    ],
    webhookSecret: Deno.env.get('MODKIT_WEBHOOK_SECRET'),
    classifier: openAIClassifier({
      apiKey: Deno.env.get('OPENAI_API_KEY')!,
    }),
    notifier: slackNotifier({
      webhookUrl: Deno.env.get('SLACK_WEBHOOK_URL')!,
    }),
    contentExtractor: async (payload) => {
      const row = payload.record
      const keys = [row.before_photo_key, row.after_photo_key].filter(Boolean) as string[]
      const imageUrls = await Promise.all(keys.map((key) => storage.createSignedReadUrl(key, 300)))
      return {
        targetType: 'trash_pickup',
        targetId: String(row.id),
        authorId: String(row.user_id),
        text: typeof row.description === 'string' ? row.description : '',
        imageUrls,
      }
    },
  }),
)
