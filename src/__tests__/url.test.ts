import { describe, it, expect } from "vitest";
import { parseQuireUrl } from "../url.js";

describe("parseQuireUrl", () => {
  it("parses a project URL", () => {
    expect(parseQuireUrl("https://quire.io/w/Test_sync_Calendar")).toEqual({
      kind: "project",
      projectId: "Test_sync_Calendar",
    });
  });

  it("parses a project URL with a trailing slash", () => {
    expect(parseQuireUrl("https://quire.io/w/my_project/")).toEqual({
      kind: "project",
      projectId: "my_project",
    });
  });

  it("parses a bare path", () => {
    expect(parseQuireUrl("/w/my_project")).toEqual({
      kind: "project",
      projectId: "my_project",
    });
  });

  it("parses an organization URL", () => {
    expect(parseQuireUrl("https://quire.io/c/my_org")).toEqual({
      kind: "organization",
      orgId: "my_org",
    });
  });

  it("parses an org-scoped project URL", () => {
    expect(parseQuireUrl("https://quire.io/c/my_org/my_project")).toEqual({
      kind: "project",
      projectId: "my_project",
      orgId: "my_org",
    });
  });

  it("parses a user URL", () => {
    expect(parseQuireUrl("https://quire.io/u/alice")).toEqual({
      kind: "user",
      userId: "alice",
    });
  });

  it("parses a task URL", () => {
    expect(parseQuireUrl("https://quire.io/w/my_project/42")).toEqual({
      kind: "task",
      projectId: "my_project",
      taskId: "42",
    });
  });

  it("parses an org-scoped task URL", () => {
    expect(parseQuireUrl("https://quire.io/c/my_org/my_project/42")).toEqual({
      kind: "task",
      projectId: "my_project",
      taskId: "42",
      orgId: "my_org",
    });
  });

  it("parses a task comment URL", () => {
    expect(
      parseQuireUrl("https://quire.io/w/my_project/42#comment-oid_Abc123"),
    ).toEqual({
      kind: "task",
      projectId: "my_project",
      taskId: "42",
      commentOid: "oid_Abc123",
    });
  });

  it("parses a chat URL", () => {
    expect(
      parseQuireUrl("https://quire.io/w/my_project?chat=Highlight101"),
    ).toEqual({
      kind: "chat",
      projectId: "my_project",
      chatId: "Highlight101",
    });
  });

  it("parses a chat comment URL", () => {
    expect(
      parseQuireUrl(
        "https://quire.io/w/my_project?chat=Highlight101#comment-oid_Xyz789",
      ),
    ).toEqual({
      kind: "chat",
      projectId: "my_project",
      chatId: "Highlight101",
      commentOid: "oid_Xyz789",
    });
  });

  it("parses a doc URL", () => {
    expect(parseQuireUrl("https://quire.io/w/my_project?doc=spec")).toEqual({
      kind: "document",
      projectId: "my_project",
      docId: "spec",
    });
  });

  it("prefers chat query over task path segment", () => {
    expect(
      parseQuireUrl("https://quire.io/w/my_project/42?chat=general"),
    ).toEqual({
      kind: "chat",
      projectId: "my_project",
      chatId: "general",
    });
  });

  it("returns null for unrecognized URLs", () => {
    expect(parseQuireUrl("https://quire.io/")).toBeNull();
    expect(parseQuireUrl("https://quire.io/dev/api/")).toBeNull();
    expect(parseQuireUrl("https://example.com/w/foo")).toEqual({
      kind: "project",
      projectId: "foo",
    }); // host-agnostic by design
  });

  it("returns null for empty / malformed input", () => {
    expect(parseQuireUrl("")).toBeNull();
    expect(parseQuireUrl("   ")).toBeNull();
    expect(parseQuireUrl("/w/")).toBeNull();
    expect(parseQuireUrl("/c/")).toBeNull();
  });
});
