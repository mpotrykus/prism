import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    /* .claude/worktrees holds git worktrees for in-progress branches, each a full copy of
       this repo. Without this they get collected as extra suites, so `npm test` reports a
       green run over stale code from a branch that may never land. */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
