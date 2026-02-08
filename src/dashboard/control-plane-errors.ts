export class ControlPlaneHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ControlPlaneHttpError";
    this.status = status;
    this.code = code;
  }
}

export function isControlPlaneHttpError(error: unknown): error is ControlPlaneHttpError {
  return error instanceof ControlPlaneHttpError;
}
