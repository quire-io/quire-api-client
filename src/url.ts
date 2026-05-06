/**
 * Parse a Quire browser URL into a structured descriptor.
 *
 * Quire's web URLs embed name-ids (slugs), not OIDs. The Quire API
 * exposes dedicated `/id/...` endpoints that take those slugs directly,
 * so parsing + one API call is enough to resolve any URL to an OID.
 *
 * Host is ignored — works for quire.io, test envs, or bare paths.
 */

export type ParsedQuireUrl =
  | { kind: "project"; projectId: string; orgId?: string }
  | { kind: "organization"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "task"; projectId: string; taskId: string; orgId?: string; commentOid?: string }
  | { kind: "chat"; projectId: string; chatId: string; commentOid?: string }
  | { kind: "document"; projectId: string; docId: string };

export function parseQuireUrl(input: string): ParsedQuireUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path: string;
  let query: URLSearchParams;
  let fragment: string;
  try {
    // Handle full URL
    const url = new URL(trimmed);
    path = url.pathname;
    query = url.searchParams;
    fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  } catch {
    // Fall back to bare-path parsing (e.g. "/w/my_project?chat=x#comment-y")
    const hashIdx = trimmed.indexOf("#");
    const beforeHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    fragment = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : "";
    const qIdx = beforeHash.indexOf("?");
    const pathPart = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
    const rawQuery = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : "";
    path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
    query = new URLSearchParams(rawQuery);
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const commentMatch = /^comment-(.+)$/.exec(fragment);
  const commentOid = commentMatch ? commentMatch[1] : undefined;

  const first = segments[0];

  if (first === "u") {
    const userId = segments[1];
    return userId ? { kind: "user", userId } : null;
  }

  let orgId: string | undefined;
  let projectId: string | undefined;
  let rest: string[] = [];

  if (first === "w") {
    projectId = segments[1];
    rest = segments.slice(2);
  } else if (first === "c") {
    orgId = segments[1];
    if (!orgId) return null;
    if (segments.length === 2) {
      return { kind: "organization", orgId };
    }
    projectId = segments[2];
    rest = segments.slice(3);
  } else {
    return null;
  }

  if (!projectId) return null;

  // Query overrides (chat/doc) take precedence — matches Quire's UI routing
  // where `?chat=` / `?doc=` is the active view regardless of the path.
  const chatId = query.get("chat");
  if (chatId) {
    return commentOid
      ? { kind: "chat", projectId, chatId, commentOid }
      : { kind: "chat", projectId, chatId };
  }
  const docId = query.get("doc");
  if (docId) {
    return { kind: "document", projectId, docId };
  }

  const taskId = rest[0];
  if (taskId) {
    const base: { kind: "task"; projectId: string; taskId: string; orgId?: string; commentOid?: string } = {
      kind: "task",
      projectId,
      taskId,
    };
    if (orgId) base.orgId = orgId;
    if (commentOid) base.commentOid = commentOid;
    return base;
  }

  return orgId
    ? { kind: "project", projectId, orgId }
    : { kind: "project", projectId };
}
