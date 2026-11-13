/**
 * Message-processing error classification:
 * - PermanentMessageError: the message can never succeed (invalid, not allowed) → DLQ, no retry.
 * - TransientMessageError: infrastructure trouble → delayed retry, then DLQ.
 * Business rejections are NOT errors: the handler commits a `rejected` reply and returns normally.
 * Any other thrown error is treated as transient until the retry budget is exhausted.
 */
export class PermanentMessageError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentMessageError';
    this.reasonCode = reasonCode;
  }
}

export class TransientMessageError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientMessageError';
    this.reasonCode = reasonCode;
  }
}
