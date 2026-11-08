import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as grpc from "@grpc/grpc-js";

const execFileAsync = promisify(execFile);
const methods = [
  "ReportRunStart",
  "ReportTestBegin",
  "ReportTestEnd",
  "ReportStepBegin",
  "ReportStepEnd",
  "ReportRunEnd",
] as const;
type Method = (typeof methods)[number];

function methodDefinition(method: Method): grpc.MethodDefinition<Buffer, Buffer> {
  return {
    path: `/testsystem.v1.observer.TestEventCollector/${method}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (message) => message,
    requestDeserialize: (message) => message,
    responseSerialize: (message) => message,
    responseDeserialize: (message) => message,
  };
}

async function runPlaywrightWithFailures(
  shouldFail: (method: Method, attempt: number) => boolean,
) {
  const calls: Method[] = [];
  const attempts = new Map<Method, number>();
  const server = new grpc.Server();
  const service = Object.fromEntries(
    methods.map((method) => [method, methodDefinition(method)]),
  );
  const handlers = Object.fromEntries(
    methods.map((method) => {
      const handler: grpc.handleUnaryCall<Buffer, Buffer> = (_call, callback) => {
        calls.push(method);
        const attempt = (attempts.get(method) ?? 0) + 1;
        attempts.set(method, attempt);
        if (shouldFail(method, attempt)) {
          callback({ code: grpc.status.UNAVAILABLE, details: "simulated outage" });
        } else {
          callback(null, Buffer.alloc(0));
        }
      };
      return [method, handler];
    }),
  );
  server.addService(service, handlers);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-shutdown-"));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("STANTERPRISE_")) delete env[key];
    }
    delete env.JEST_WORKER_ID;
    env.SHUTDOWN_TEST_GRPC_ADDRESS = `127.0.0.1:${port}`;
    env.SHUTDOWN_TEST_OUTPUT_DIR = outputDir;

    const result = await execFileAsync(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        path.join(__dirname, "fixtures/shutdown/playwright.config.js"),
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        env,
        timeout: 15000,
      },
    );
    return { calls, ...result };
  } finally {
    server.forceShutdown();
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

describe("reporter shutdown", () => {
  it(
    "keeps Playwright alive until a transient run-end failure is retried",
    async () => {
      const { calls, stdout, stderr } = await runPlaywrightWithFailures(
        (method, attempt) => method === "ReportRunEnd" && attempt === 1,
      );

      expect(calls[0]).toBe("ReportRunStart");
      expect(calls).toContain("ReportTestBegin");
      expect(calls).toContain("ReportStepBegin");
      expect(calls).toContain("ReportStepEnd");
      expect(calls).toContain("ReportTestEnd");
      expect(calls.filter((method) => method === "ReportRunEnd")).toHaveLength(2);
      expect(calls[calls.length - 1]).toBe("ReportRunEnd");
      expect(stdout).toContain("Stanterprise Reporter: Test run completed");
      expect(stderr).toBe("");
    },
    30000,
  );

  it(
    "logs exhausted retries and continues draining subsequent events",
    async () => {
      const { calls, stdout, stderr } = await runPlaywrightWithFailures(
        (method) => method === "ReportTestBegin",
      );

      expect(calls.filter((method) => method === "ReportTestBegin")).toHaveLength(2);
      expect(calls.indexOf("ReportTestEnd")).toBeGreaterThan(
        calls.lastIndexOf("ReportTestBegin"),
      );
      expect(calls[calls.length - 1]).toBe("ReportRunEnd");
      expect(stderr).toContain("Failed to report test begin");
      expect(stdout).toContain("Stanterprise Reporter: Test run completed");
    },
    30000,
  );

  it(
    "logs a run-end failure after its retries are exhausted",
    async () => {
      const { calls, stdout, stderr } = await runPlaywrightWithFailures(
        (method) => method === "ReportRunEnd",
      );

      expect(calls.filter((method) => method === "ReportRunEnd")).toHaveLength(2);
      expect(stderr).toContain("Failed to report end event");
      expect(stdout).toContain("Stanterprise Reporter: Test run completed");
    },
    30000,
  );
});
