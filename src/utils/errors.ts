export class BridgeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export function toErrorPayload(error: BridgeError): {
  code: string;
  message: string;
  details?: unknown;
} {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export function isJsonRpcErrorLike(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "number" &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}
