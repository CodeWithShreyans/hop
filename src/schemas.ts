import { z } from "zod";

/** Throw a readable error instead of returning a Result. Used across every JSON read. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${context}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const toolSchema = z.enum(["claude", "codex"]);
export type Tool = z.infer<typeof toolSchema>;

export const kindSchema = z.enum(["sub", "api"]);
export type Kind = z.infer<typeof kindSchema>;

/* ── Codex: ~/.codex/auth.json ───────────────────────────────────────────── */

export const codexTokensSchema = z.looseObject({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  account_id: z.string().optional(),
});

export const codexAuthSchema = z.looseObject({
  auth_mode: z.string().nullish(),
  OPENAI_API_KEY: z.string().nullish(),
  tokens: codexTokensSchema.nullish(),
  last_refresh: z.string().nullish(),
});
export type CodexAuth = z.infer<typeof codexAuthSchema>;

const codexAuthClaimSchema = z.looseObject({
  chatgpt_plan_type: z.string().nullish(),
  chatgpt_account_id: z.string().nullish(),
});

export const codexJwtClaimsSchema = z.looseObject({
  email: z.string().nullish(),
  name: z.string().nullish(),
  exp: z.number().nullish(),
  "https://api.openai.com/auth": codexAuthClaimSchema.nullish(),
});

/* ── Claude: keychain payload + ~/.claude.json identity ──────────────────── */

export const claudeAiOauthSchema = z.looseObject({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().nullish(),
  scopes: z.array(z.string()).nullish(),
  subscriptionType: z.string().nullish(),
  rateLimitTier: z.string().nullish(),
});
export type ClaudeAiOauth = z.infer<typeof claudeAiOauthSchema>;

/** The `Claude Code-credentials` keychain blob. Loose so `mcpOAuth` and future keys survive a swap. */
export const claudeKeychainSchema = z.looseObject({
  claudeAiOauth: claudeAiOauthSchema.nullish(),
});
export type ClaudeKeychain = z.infer<typeof claudeKeychainSchema>;

export const claudeOauthAccountSchema = z.looseObject({
  accountUuid: z.string().nullish(),
  emailAddress: z.string().nullish(),
  organizationUuid: z.string().nullish(),
  organizationName: z.string().nullish(),
  organizationRole: z.string().nullish(),
  workspaceRole: z.string().nullish(),
  billingType: z.string().nullish(),
  displayName: z.string().nullish(),
});
export type ClaudeOauthAccount = z.infer<typeof claudeOauthAccountSchema>;

/* ── hop's own stores ────────────────────────────────────────────────────── */

export const profileMetaSchema = z.object({
  name: z.string(),
  tool: toolSchema,
  kind: kindSchema,
  email: z.string().nullish(),
  plan: z.string().nullish(),
  accountId: z.string().nullish(),
  orgId: z.string().nullish(),
  savedAt: z.string(),
});
export type ProfileMeta = z.infer<typeof profileMetaSchema>;

export const registrySchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileMetaSchema),
  active: z.object({ claude: z.string().nullish(), codex: z.string().nullish() }),
  previous: z.object({ claude: z.string().nullish(), codex: z.string().nullish() }),
});
export type Registry = z.infer<typeof registrySchema>;

/** Claude profile secret file at $HOP_HOME/claude/<name>.json (0600). Codex profiles are raw auth.json files. */
export const claudeProfileSchema = z.object({
  name: z.string(),
  kind: kindSchema,
  claudeAiOauth: claudeAiOauthSchema.nullish(),
  apiKey: z.string().nullish(),
  oauthAccount: claudeOauthAccountSchema.nullish(),
  savedAt: z.string(),
});
export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;

/* ── OAuth refresh + usage responses ─────────────────────────────────────── */

export const oauthRefreshResponseSchema = z.looseObject({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  id_token: z.string().nullish(),
  expires_in: z.number().nullish(),
});

const codexWindowSchema = z.looseObject({
  used_percent: z.number(),
  reset_at: z.number().nullish(),
  limit_window_seconds: z.number().nullish(),
});
export const codexUsageSchema = z.looseObject({
  plan_type: z.string().nullish(),
  rate_limit: z
    .looseObject({
      primary_window: codexWindowSchema.nullish(),
      secondary_window: codexWindowSchema.nullish(),
    })
    .nullish(),
});
export type CodexUsage = z.infer<typeof codexUsageSchema>;

/** GET /wham/rate-limit-reset-credits — on-demand usage-limit reset credits (subscription feature). */
export const codexResetCreditsSchema = z.looseObject({
  credits: z
    .array(
      z.looseObject({
        id: z.string().nullish(),
        reset_type: z.string().nullish(),
        status: z.string().nullish(),
        expires_at: z.string().nullish(),
      }),
    )
    .nullish(),
  available_count: z.number().nullish(),
});

const claudeWindowSchema = z.looseObject({
  utilization: z.number().nullish(),
  resets_at: z.string().nullish(),
});
export const claudeUsageSchema = z.looseObject({
  five_hour: claudeWindowSchema.nullish(),
  seven_day: claudeWindowSchema.nullish(),
  seven_day_opus: claudeWindowSchema.nullish(),
  seven_day_sonnet: claudeWindowSchema.nullish(),
});
export type ClaudeUsage = z.infer<typeof claudeUsageSchema>;
