export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
