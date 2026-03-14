export class ConduitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConduitTimeoutError";
  }
}

export class ConduitRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConduitRequestError";
  }
}

export class ConduitResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConduitResponseError";
  }
}

export class ConduitApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConduitApiError";
  }
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}
