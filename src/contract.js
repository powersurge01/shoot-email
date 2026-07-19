export const CONTRACT_VERSION = '2.0';

export const MESSAGE_BATCH_DEFAULTS = Object.freeze({
  limit: 50,
  maxChars: 100_000,
  maxMessageChars: 16_000,
});

export const MESSAGE_BATCH_MAXIMUMS = Object.freeze({
  limit: 200,
  maxChars: 500_000,
  maxMessageChars: 100_000,
});

export const OUTBOUND_CONSTRAINTS = Object.freeze({
  recipientsPerMessage: 1,
  subjectMaxChars: 200,
  textMaxChars: 20_000,
});

export function withContract(result) {
  const value = result && typeof result === 'object' ? result : { data: result };
  return {
    contractVersion: CONTRACT_VERSION,
    ok: value.ok ?? true,
    ...value,
    error: value.error ?? null,
  };
}

export function contractError(error) {
  return withContract({
    ok: false,
    error: {
      code: error.code || 'request_error',
      message: error.message,
      retryable: error.retryable === true,
      ...(error.retryAt || error.retryAfter
        ? { retryAt: error.retryAt || error.retryAfter }
        : {}),
    },
  });
}
