export class StepRollbackError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StepRollbackError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function ensureCondition(condition, code, message, details = undefined) {
  if (!condition) {
    throw new StepRollbackError(code, message, details);
  }
}

export function toStepRollbackError(error, fallbackCode, details = undefined) {
  if (error instanceof StepRollbackError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new StepRollbackError(fallbackCode, message, details);
}
