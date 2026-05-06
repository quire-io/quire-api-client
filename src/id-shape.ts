/**
 * Shape heuristics for distinguishing Quire opaque OIDs from user-facing
 * friendly ids (project/org slugs, numeric task ids, user emails).
 *
 * Quire OIDs are fixed-length 24-char strings over `[A-Za-z0-9._~-]`
 * (real examples: `0eqPPj7yzoHx89_KLFlbQ4XL`, `0evB~8cL8MESzFmf4KnYk9B6`).
 * Authoritative definition lives in the main Quire codebase at
 * `entity/oid.dart` — `oidLength = 24`, `oidCharPattern = [-0-9a-zA-Z._~]`.
 *
 * When a slug happens to exactly match the OID shape (24 chars, all valid
 * OID chars), the caller can disambiguate by passing the full Quire URL
 * through `resolve_quire_url` instead.
 */
const OID_PATTERN = /^[A-Za-z0-9._~-]{24}$/;

export function looksLikeOid(s: string): boolean {
  return OID_PATTERN.test(s);
}
