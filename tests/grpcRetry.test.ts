/**
 * Tests for gRPC retry functionality
 */
import { reportUnary } from "../src/client/grpcClient";
import { MessageQueue } from "../src/client/messageQueue";
import type { StanterpriseReporterOptions } from "../src/types";
import * as grpc from "@grpc/grpc-js";

describe("gRPC Retry Functionality", () => {
  let mockClient: any;
  let testConfig: StanterpriseReporterOptions;
  let mockMessage: { serializeBinary: () => Uint8Array };
  const testPath = "/test.service/TestMethod";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    delete process.env.STANTERPRISE_INGESTION_AUTH_KEY;
    
    testConfig = {
      grpcEnabled: true,
      grpcMaxRetries: 3,
      grpcRetryDelay: 100,
      grpcTimeout: 1000,
      verbose: false,
    };

    mockMessage = {
      serializeBinary: () => new Uint8Array([1, 2, 3]),
    };

    mockClient = {
      makeUnaryRequest: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("successful requests", () => {
    it("should complete without retries on first success", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          cb(null, Buffer.from("success"));
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      const response = await responsePromise;
      
      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
      expect(response.toString()).toBe("success");
      expect(mockClient.makeUnaryRequest.mock.calls[0][4].get("authorization")).toEqual([]);
    });

    it("should return empty buffer when grpcEnabled is false", async () => {
      testConfig.grpcEnabled = false;

      const response = await reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      expect(mockClient.makeUnaryRequest).not.toHaveBeenCalled();
      expect(response).toEqual(Buffer.alloc(0));
    });
  });

  describe("transient error retries", () => {
    it("should send the bearer key on every attempt", async () => {
      process.env.STANTERPRISE_INGESTION_AUTH_KEY = "test-ingestion-key";
      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (
          _path: string,
          _ser: any,
          _des: any,
          _msg: any,
          _metadata: grpc.Metadata,
          _opts: any,
          cb: any,
        ) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Service unavailable") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("success"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
      );
      await jest.advanceTimersByTimeAsync(100);
      await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
      for (const call of mockClient.makeUnaryRequest.mock.calls) {
        expect(call[4].get("authorization")).toEqual(["Bearer test-ingestion-key"]);
      }
    });

    it("should retry UNAVAILABLE errors with exponential backoff", async () => {
      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount < 3) {
            const err = new Error("Service unavailable") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("recovered"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      // Fast-forward through first retry delay (100ms)
      await jest.advanceTimersByTimeAsync(100);
      // Fast-forward through second retry delay (200ms)
      await jest.advanceTimersByTimeAsync(200);

      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(3);
      expect(response.toString()).toBe("recovered");
    });

    it("should retry DEADLINE_EXCEEDED errors", async () => {
      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Deadline exceeded") as grpc.ServiceError;
            err.code = grpc.status.DEADLINE_EXCEEDED;
            cb(err, null);
          } else {
            cb(null, Buffer.from("success after timeout"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      await jest.advanceTimersByTimeAsync(100);
      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
      expect(response.toString()).toBe("success after timeout");
    });

    it("should retry INTERNAL errors", async () => {
      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Internal error") as grpc.ServiceError;
            err.code = grpc.status.INTERNAL;
            cb(err, null);
          } else {
            cb(null, Buffer.from("recovered from internal"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      await jest.advanceTimersByTimeAsync(100);
      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
      expect(response.toString()).toBe("recovered from internal");
    });

    it("should retry UNKNOWN errors", async () => {
      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Unknown error") as grpc.ServiceError;
            err.code = grpc.status.UNKNOWN;
            cb(err, null);
          } else {
            cb(null, Buffer.from("recovered from unknown"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      await jest.advanceTimersByTimeAsync(100);
      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
      expect(response.toString()).toBe("recovered from unknown");
    });
  });

  describe("non-retryable errors", () => {
    it("should report authentication rejection without exposing the key", async () => {
      process.env.STANTERPRISE_INGESTION_AUTH_KEY = "test-ingestion-key";
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("server error") as grpc.ServiceError;
          err.code = grpc.status.UNAUTHENTICATED;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage),
      ).rejects.toThrow(
        "Observer rejected ingestion authentication (UNAUTHENTICATED); " +
          "verify STANTERPRISE_INGESTION_AUTH_KEY",
      );

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry INVALID_ARGUMENT errors", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Invalid argument") as grpc.ServiceError;
          err.code = grpc.status.INVALID_ARGUMENT;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("Invalid argument");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry NOT_FOUND errors", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Not found") as grpc.ServiceError;
          err.code = grpc.status.NOT_FOUND;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("Not found");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry PERMISSION_DENIED errors", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Permission denied") as grpc.ServiceError;
          err.code = grpc.status.PERMISSION_DENIED;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("Permission denied");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry UNAUTHENTICATED errors", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Unauthenticated") as grpc.ServiceError;
          err.code = grpc.status.UNAUTHENTICATED;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("UNAUTHENTICATED");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry ALREADY_EXISTS errors", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Already exists") as grpc.ServiceError;
          err.code = grpc.status.ALREADY_EXISTS;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("Already exists");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry limits", () => {
    it("should stop after maxRetries attempts", async () => {
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Always fails") as grpc.ServiceError;
          err.code = grpc.status.UNAVAILABLE;
          cb(err, null);
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      ).catch((err) => err); // Catch to prevent unhandled rejection

      // Advance through all retry delays sequentially: 100ms, 200ms, 400ms
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(400);

      // Wait for the response and check error
      const error = await responsePromise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Always fails");

      // Initial attempt + 3 retries = 4 total
      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(4);
    });

    it("should respect custom maxRetries setting", async () => {
      testConfig.grpcMaxRetries = 1;

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Fails") as grpc.ServiceError;
          err.code = grpc.status.UNAVAILABLE;
          cb(err, null);
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      ).catch((err) => err); // Catch to prevent unhandled rejection

      await jest.advanceTimersByTimeAsync(100);

      // Wait for the response and check error
      const error = await responsePromise;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Fails");

      // Initial attempt + 1 retry = 2 total
      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
    });

    it("should not retry when maxRetries is 0", async () => {
      testConfig.grpcMaxRetries = 0;

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const err = new Error("Fails immediately") as grpc.ServiceError;
          err.code = grpc.status.UNAVAILABLE;
          cb(err, null);
        }
      );

      await expect(
        reportUnary(testConfig, mockClient, testPath, mockMessage, 1000)
      ).rejects.toThrow("Fails immediately");

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("exponential backoff timing", () => {
    it("should use correct exponential backoff delays", async () => {
      testConfig.grpcRetryDelay = 50;
      let callCount = 0;

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount < 4) {
            const err = new Error("Retry me") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("finally"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      // First retry: 50 * 2^0 = 50ms
      await jest.advanceTimersByTimeAsync(50);
      // Second retry: 50 * 2^1 = 100ms
      await jest.advanceTimersByTimeAsync(100);
      // Third retry: 50 * 2^2 = 200ms
      await jest.advanceTimersByTimeAsync(200);

      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(4);
      expect(response.toString()).toBe("finally");
    });

    it("should use custom retryDelay base value", async () => {
      testConfig.grpcRetryDelay = 250;
      let callCount = 0;

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Once") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("done"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      // First retry: 250 * 2^0 = 250ms
      await jest.advanceTimersByTimeAsync(250);

      const response = await responsePromise;

      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(2);
      expect(response.toString()).toBe("done");
    });
  });

  describe("verbose logging", () => {
    it("should log retry attempts when verbose is true", async () => {
      testConfig.verbose = true;
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("First fail") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("ok"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      await jest.advanceTimersByTimeAsync(100);
      await responsePromise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("gRPC call failed")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("retrying")
      );

      consoleSpy.mockRestore();
    });

    it("should not log when verbose is false", async () => {
      testConfig.verbose = false;
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      let callCount = 0;
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const err = new Error("First fail") as grpc.ServiceError;
            err.code = grpc.status.UNAVAILABLE;
            cb(err, null);
          } else {
            cb(null, Buffer.from("ok"));
          }
        }
      );

      const responsePromise = reportUnary(
        testConfig,
        mockClient,
        testPath,
        mockMessage,
        1000
      );

      await jest.advanceTimersByTimeAsync(100);
      await responsePromise;

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("message serialization", () => {
    it("should work with serializeBinary method", async () => {
      const customMessage = {
        serializeBinary: jest.fn(() => new Uint8Array([4, 5, 6])),
      };

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, ser: any, _des: any, msg: any, _meta: any, _opts: any, cb: any) => {
          // Call the serializer to trigger serializeBinary
          ser(msg);
          cb(null, Buffer.from("ok"));
        }
      );

      await reportUnary(testConfig, mockClient, testPath, customMessage, 1000);

      expect(customMessage.serializeBinary).toHaveBeenCalled();
    });

    it("should work with serialize method", async () => {
      const customMessage = {
        serialize: jest.fn(() => new Uint8Array([7, 8, 9])),
      };

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, ser: any, _des: any, msg: any, _meta: any, _opts: any, cb: any) => {
          // Call the serializer to trigger serialize
          ser(msg);
          cb(null, Buffer.from("ok"));
        }
      );

      await reportUnary(testConfig, mockClient, testPath, customMessage, 1000);

      expect(customMessage.serialize).toHaveBeenCalled();
    });
  });

  describe("queue integration", () => {
    // These tests use real timers so that async operations in MessageQueue
    // (which relies on Promise micro-tasks, not setTimeout) resolve naturally.
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      // Re-enable fake timers so the outer afterEach (jest.useRealTimers) is a no-op
      jest.useRealTimers();
    });

    it("should execute calls strictly in order when a queue is provided", async () => {
      const queue = new MessageQueue();
      const callOrder: number[] = [];
      let callIndex = 0;

      // Each invocation records the index at which it was called
      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          const myIndex = callIndex++;
          // Resolve asynchronously to give concurrent calls a chance to interleave
          Promise.resolve().then(() => {
            callOrder.push(myIndex);
            cb(null, Buffer.from(`response-${myIndex}`));
          });
        }
      );

      // Fire all three calls without awaiting individually - they must still execute in order
      const p1 = reportUnary(testConfig, mockClient, "/path/Method1", mockMessage, 1000, queue);
      const p2 = reportUnary(testConfig, mockClient, "/path/Method2", mockMessage, 1000, queue);
      const p3 = reportUnary(testConfig, mockClient, "/path/Method3", mockMessage, 1000, queue);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1.toString()).toBe("response-0");
      expect(r2.toString()).toBe("response-1");
      expect(r3.toString()).toBe("response-2");
      expect(callOrder).toEqual([0, 1, 2]);
      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(3);
    });

    it("should never execute two calls concurrently when a queue is provided", async () => {
      const queue = new MessageQueue();
      let inFlight = 0;
      let maxInFlight = 0;

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Resolve asynchronously
          Promise.resolve().then(() => {
            inFlight--;
            cb(null, Buffer.from("ok"));
          });
        }
      );

      await Promise.all([
        reportUnary(testConfig, mockClient, "/path/M1", mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/M2", mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/M3", mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/M4", mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/M5", mockMessage, 1000, queue),
      ]);

      // The queue must hold back subsequent calls until the previous one completes
      expect(maxInFlight).toBe(1);
    });

    it("should remain unaffected by a failing call - subsequent calls still execute in order", async () => {
      const queue = new MessageQueue();
      const completedPaths: string[] = [];
      let callCount = 0;

      mockClient.makeUnaryRequest.mockImplementation(
        (path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          callCount++;
          Promise.resolve().then(() => {
            if (callCount === 2) {
              const err = new Error("middle call failed") as grpc.ServiceError;
              // Use a non-retryable code so we don't trigger backoff timers
              err.code = grpc.status.INVALID_ARGUMENT;
              cb(err, null);
            } else {
              completedPaths.push(path);
              cb(null, Buffer.from("ok"));
            }
          });
        }
      );

      const results = await Promise.allSettled([
        reportUnary(testConfig, mockClient, "/path/First",  mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/Second", mockMessage, 1000, queue),
        reportUnary(testConfig, mockClient, "/path/Third",  mockMessage, 1000, queue),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");
      // First and Third must have completed, in order
      expect(completedPaths).toEqual(["/path/First", "/path/Third"]);
    });

    it("should behave identically to the no-queue path for a single call", async () => {
      const queue = new MessageQueue();

      mockClient.makeUnaryRequest.mockImplementation(
        (_path: string, _ser: any, _des: any, _msg: any, _meta: any, _opts: any, cb: any) => {
          cb(null, Buffer.from("single-response"));
        }
      );

      const response = await reportUnary(
        testConfig, mockClient, testPath, mockMessage, 1000, queue
      );

      expect(response.toString()).toBe("single-response");
      expect(mockClient.makeUnaryRequest).toHaveBeenCalledTimes(1);
    });
  });
});
