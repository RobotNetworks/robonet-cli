/**
 * Operator-side typed errors that translate cleanly to JSON error
 * envelopes on the wire.
 *
 * Every public error code surfaced over the wire is defined here as a
 * subclass with the matching `status` and `code`. The route layer's error
 * boundary maps any thrown {@link OperatorError} into a 4xx/5xx response;
 * non-`OperatorError` throws produce a generic 500 with code
 * `INTERNAL_ERROR` and a redacted message.
 */

export class OperatorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OperatorError";
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends OperatorError {
  constructor(message: string, code = "BAD_REQUEST") {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends OperatorError {
  constructor(message = "missing or invalid bearer token") {
    super(401, "UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends OperatorError {
  constructor(message: string) {
    super(403, "FORBIDDEN", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends OperatorError {
  constructor(message: string) {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends OperatorError {
  constructor(message: string, code = "CONFLICT") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

export class MethodNotAllowedError extends OperatorError {
  constructor(method: string, path: string) {
    super(405, "METHOD_NOT_ALLOWED", `${method} ${path} is not allowed`);
    this.name = "MethodNotAllowedError";
  }
}
