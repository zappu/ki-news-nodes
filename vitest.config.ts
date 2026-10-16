import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests mit Datenbank teilen sich eine Testdatenbank, deshalb nacheinander
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
