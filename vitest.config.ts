import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // katex.css is imported with ?raw (inlined into SVG foreignObjects); keep its text in tests.
    css: { include: [/katex.min.css/] },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
