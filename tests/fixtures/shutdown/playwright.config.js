const path = require("path");
const { defineConfig } = require("@playwright/test");

if (!process.env.SHUTDOWN_TEST_GRPC_ADDRESS || !process.env.SHUTDOWN_TEST_OUTPUT_DIR) {
  throw new Error("Shutdown test requires a gRPC address and output directory");
}

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "shutdown.spec.js",
  outputDir: process.env.SHUTDOWN_TEST_OUTPUT_DIR,
  workers: 1,
  retries: 0,
  reporter: [
    [
      path.resolve(__dirname, "../../../src/reporter.ts"),
      {
        grpcAddress: process.env.SHUTDOWN_TEST_GRPC_ADDRESS,
        grpcTimeout: 2000,
        grpcMaxRetries: 1,
        grpcRetryDelay: 200,
        tls: false,
        debug: false,
      },
    ],
  ],
});
