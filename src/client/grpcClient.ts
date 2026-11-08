import { StanterpriseReporterOptions } from "../types";
import * as grpc from "@grpc/grpc-js";
import { writeDebugEntry } from "../utils/debugLogger";
import { MessageQueue } from "./messageQueue";

export default function getClient(
  options: StanterpriseReporterOptions,
): grpc.Client | null {
  try {
    const maxMessageSize = options.grpcMaxMessageSize || 104857600; // 100MB default

    const credentials = options.tls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    return new grpc.Client(options.grpcAddress!, credentials, {
      "grpc.max_send_message_length": maxMessageSize,
      "grpc.max_receive_message_length": maxMessageSize,
    });
  } catch (e) {
    console.error("Failed to create gRPC client", e);
  }

  return null;
}

/**
 * Determines if a gRPC error code represents a transient failure worth retrying
 */
function shouldAttemptRetryForCode(errorCode: grpc.status): boolean {
  const transientCodes = new Set([
    grpc.status.UNAVAILABLE,
    grpc.status.DEADLINE_EXCEEDED,
    grpc.status.INTERNAL,
    grpc.status.UNKNOWN,
  ]);

  return transientCodes.has(errorCode);
}

/**
 * Calculates wait time using power-of-two exponential backoff
 */
function calculateWaitDuration(
  baseDelayMs: number,
  attemptsSoFar: number,
): number {
  return baseDelayMs * Math.pow(2, attemptsSoFar);
}

/**
 * Performs a single gRPC unary request attempt
 */
function executeSingleAttempt(
  grpcClient: grpc.Client,
  path: string,
  message: {
    serialize?: (w?: any) => Uint8Array;
    serializeBinary?: () => Uint8Array;
  },
  deadlineMs: number,
): Promise<Buffer> {
  const reqSerialize = (arg: unknown): Buffer => {
    const m = arg as
      | {
          serializeBinary?: () => Uint8Array;
          serialize?: (w?: any) => Uint8Array;
        }
      | undefined;
    const bytes = m?.serializeBinary
      ? m.serializeBinary()
      : m?.serialize
        ? m.serialize()
        : new Uint8Array(0);
    return Buffer.from(bytes);
  };

  const resDeserialize = (bytes: Buffer): Buffer => bytes;

  const metadata = new grpc.Metadata();
  const ingestionAuthKey = process.env.STANTERPRISE_INGESTION_AUTH_KEY;
  if (ingestionAuthKey) {
    metadata.set("authorization", `Bearer ${ingestionAuthKey}`);
  }
  const callOptions: grpc.CallOptions = {
    deadline: new Date(Date.now() + deadlineMs),
  };

  return new Promise<Buffer>((resolve, reject) => {
    try {
      (
        grpcClient as unknown as {
          makeUnaryRequest: (
            path: string,
            serialize: (arg: unknown) => Buffer,
            deserialize: (arg: Buffer) => Buffer,
            arg: unknown,
            metadata: grpc.Metadata,
            options: grpc.CallOptions,
            callback: (err: grpc.ServiceError | null, res: Buffer) => void,
          ) => void;
        }
      ).makeUnaryRequest(
        path,
        reqSerialize,
        resDeserialize,
        message,
        metadata,
        callOptions,
        (err, response) => {
          if (err) return reject(err);
          resolve(response);
        },
      );
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Keep the timer referenced so Node cannot exit before pending retries finish.
 */
function pauseExecution(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * Attempts gRPC call with exponential backoff retry logic using iterative approach
 */
async function attemptWithRetries(
  options: StanterpriseReporterOptions,
  grpcClient: grpc.Client,
  path: string,
  message: {
    serialize?: (w?: any) => Uint8Array;
    serializeBinary?: () => Uint8Array;
  },
  deadlineMs: number,
  maxRetries: number,
): Promise<Buffer> {
  let attemptNumber = 0;
  let lastError: Error | null = null;

  // Try initial attempt + retries
  for (
    let retriesRemaining = maxRetries;
    retriesRemaining >= 0;
    retriesRemaining--
  ) {
    try {
      return await executeSingleAttempt(
        grpcClient,
        path,
        message,
        deadlineMs,
      );
    } catch (err) {
      lastError = err as Error;
      const grpcErr = err as grpc.ServiceError;
      const statusCode = grpcErr?.code ?? grpc.status.UNKNOWN;

      // Check if we should retry this error
      const isRetryable = shouldAttemptRetryForCode(statusCode);
      const hasRetriesLeft = retriesRemaining > 0;

      if (!isRetryable || !hasRetriesLeft) {
        if (statusCode === grpc.status.UNAUTHENTICATED) {
          throw new Error(
            "Observer rejected ingestion authentication (UNAUTHENTICATED); " +
              "verify STANTERPRISE_INGESTION_AUTH_KEY",
          );
        }
        throw err;
      }

      // Log retry attempt if verbose
      if (options.verbose) {
        console.log(
          `gRPC call failed (code: ${statusCode}), retrying... ` +
            `(attempt ${attemptNumber + 1}, ${retriesRemaining} retries left)`,
        );
      }

      // Calculate and wait for backoff duration
      const baseDelay = options.grpcRetryDelay ?? 100;
      const waitTime = calculateWaitDuration(baseDelay, attemptNumber);
      await pauseExecution(waitTime);

      attemptNumber++;
    }
  }

  // This should never be reached due to the throw in the loop, but TypeScript needs it
  throw lastError || new Error("Retry loop exhausted without result");
}

/**
 * Helper: generic unary call using raw method path with retry support.
 *
 * When a `queue` is provided the call is enqueued and executed only after all
 * previously enqueued calls have completed, guaranteeing sequential delivery to
 * the server. Without a queue the call is executed immediately (legacy / test
 * behaviour).
 */
export async function reportUnary(
  options: StanterpriseReporterOptions,
  grpcClient: grpc.Client,
  grpcPath: string,
  message: {
    serialize?: (w?: any) => Uint8Array;
    serializeBinary?: () => Uint8Array;
  },
  deadlineMs: number = 1000,
  queue?: MessageQueue,
): Promise<Buffer> {
  if (!options.grpcEnabled || !grpcClient) {
    return Buffer.alloc(0);
  }

  const execute = async (): Promise<Buffer> => {
    await writeDebugEntry(options, grpcPath, message);

    const maxRetries = options.grpcMaxRetries ?? 3;

    return attemptWithRetries(
      options,
      grpcClient,
      grpcPath,
      message,
      deadlineMs,
      maxRetries,
    );
  };

  if (queue) {
    return queue.enqueue(execute);
  }

  return execute();
}
