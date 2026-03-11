export class ArcNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = "ArcNotFoundError";
    }
}
export class ArcTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "ArcTimeoutError";
    }
}
export class ArcExecutionError extends Error {
    constructor(message) {
        super(message);
        this.name = "ArcExecutionError";
    }
}
export class ConduitResponseError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConduitResponseError";
    }
}
export class ConduitApiError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConduitApiError";
    }
}
export class InputValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "InputValidationError";
    }
}
//# sourceMappingURL=errors.js.map