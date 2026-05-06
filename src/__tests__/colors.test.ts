import { describe, it, expect } from "vitest";
import { COLOR_TABLE, NAMED_COLORS, resolveColor } from "../colors.js";

describe("resolveColor", () => {
  it("passes through valid 2-digit palette codes", () => {
    expect(resolveColor("00")).toBe("00");
    expect(resolveColor("34")).toBe("34");
    expect(resolveColor("57")).toBe("57");
  });

  it("resolves friendly color names case-insensitively", () => {
    expect(resolveColor("red")).toBe("06");
    expect(resolveColor("BLUE")).toBe("34");
    expect(resolveColor(" Green ")).toBe("42");
    expect(resolveColor("grey")).toBe("52");
  });

  it("returns undefined for unrecognised input", () => {
    expect(resolveColor("")).toBeUndefined();
    expect(resolveColor(undefined)).toBeUndefined();
    expect(resolveColor("#FF0000")).toBeUndefined();
    expect(resolveColor("99")).toBeUndefined();    // workspace-only, invalid for tags
    expect(resolveColor("99red")).toBeUndefined();
    expect(resolveColor("68")).toBeUndefined();    // row 6 out of range
    expect(resolveColor("58")).toBeUndefined();    // col 8 out of range
  });

  it("every NAMED_COLORS code is in the valid tag palette (00-57)", () => {
    for (const [name, code] of Object.entries(NAMED_COLORS)) {
      expect(code, `${name} -> ${code}`).toMatch(/^[0-5][0-7]$/);
      expect(COLOR_TABLE[code], `${name} -> ${code} missing hex`).toBeDefined();
    }
  });
});
