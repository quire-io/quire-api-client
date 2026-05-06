// Public API surface for @quire/api-client.

export { QuireClient } from "./client.js";
export type {
  QuireClientOptions,
  QuireLogger,
  RefreshTokensFn,
  OnTokenRefresh,
  OnAuthRevoked,
} from "./client.js";
export type { QuireTaskSearchParams } from "./client.js";

export {
  exchangeCode,
  refreshTokens,
} from "./oauth.js";
export type {
  ExchangeCodeOptions,
  RefreshTokensOptions,
} from "./oauth.js";

export {
  QuireAuthRevokedError,
  QuireTokenRefreshError,
  formatQuireError,
} from "./errors.js";

export { looksLikeOid } from "./id-shape.js";
export { parseQuireUrl } from "./url.js";
export type { ParsedQuireUrl } from "./url.js";

export { COLOR_TABLE, NAMED_COLORS, resolveColor } from "./colors.js";

export type {
  QuireApproval,
  QuireApprovalCategory,
  QuireAttachment,
  QuireChat,
  QuireComment,
  QuireDocument,
  QuireEnumValue,
  QuireFieldDefinition,
  QuireInsight,
  QuireOrganization,
  QuirePartner,
  QuireProject,
  QuireRateLimit,
  QuireRateLimitBucket,
  QuireRecurrence,
  QuireStatus,
  QuireSublist,
  QuireTag,
  QuireTask,
  QuireTaskNode,
  QuireTimelog,
  QuireTokens,
  QuireUser,
} from "./types.js";
