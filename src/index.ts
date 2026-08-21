// Public API surface for @quire-io/api-client.

export { QuireClient } from "./client.js";
export type {
  QuireClientOptions,
  QuireLogger,
  RefreshTokensFn,
  OnTokenRefresh,
  OnAuthRevoked,
} from "./client.js";
export type {
  QuireMyTasksFilter,
  QuireMyTasksScope,
  QuireTaskSearchParams,
} from "./client.js";

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

export {
  evaluateFormula,
  evaluateTaskFormulaFields,
  flattenTaskTree,
  parseExportJson,
  QureDuration,
} from "./formula.js";
export type { FormulaContext, FormulaValue } from "./formula.js";

export { loadProjectTasksForFormula } from "./formula-loader.js";
export type { FormulaTasksResult } from "./formula-loader.js";

export type {
  QuireApproval,
  QuireApprovalCategory,
  QuireAttachment,
  QuireChat,
  QuireComment,
  QuireCompactRef,
  QuireDashboard,
  QuireDashboardOwnerType,
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
