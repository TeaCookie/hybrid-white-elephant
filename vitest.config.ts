import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "engine",
          include: ["src/engine/**/*.test.ts", "src/adapters/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "http",
          include: ["src/server/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./tests/global-setup.ts"],
        },
      },
    ],
    // HTTP tests share one throwaway database, so test files run one at a time.
    fileParallelism: false,
  },
});
