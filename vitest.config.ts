import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.live.test.ts"],
          // Live API is slower than mocked unit tests, and the 429 retry
          // budget in tests/live/helpers.ts can stretch a single request.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // Quire rate-limits aggressively; concurrent files burst it.
          fileParallelism: false,
        },
      },
    ],
  },
});
