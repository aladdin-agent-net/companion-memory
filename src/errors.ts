export type MemoryErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'limit_reached'
  | 'unknown_place'
  | 'unknown_object'
  | 'speaker_not_identified'
  | 'permission_denied';

/** All errors thrown by this library for caller mistakes carry a stable `code`. */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export function assertInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MemoryError('invalid_input', message);
}

export function assertId(value: unknown, field: string): asserts value is string {
  assertInput(typeof value === 'string' && value.trim().length > 0 && value.length <= 200, `${field} must be a non-empty string (max 200 chars)`);
}

export function assertUnitInterval(value: unknown, field: string): asserts value is number {
  assertInput(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `${field} must be a number in [0, 1]`);
}

export function assertTimestamp(value: unknown, field: string): asserts value is number {
  assertInput(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${field} must be a unix timestamp in seconds`);
}
