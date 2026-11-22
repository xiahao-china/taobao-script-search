import type { CliEnvelope, OperationMeta, TaobaoErrorCode } from '../types.js';

export class TaobaoError extends Error {
  readonly code: TaobaoErrorCode;
  readonly details: unknown;

  constructor(code: TaobaoErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'TaobaoError';
    this.code = code;
    this.details = details;
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
}

export function getErrorCode(error: unknown, fallback: TaobaoErrorCode = 'INTERNAL_ERROR'): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return fallback;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message ?? error);
  return String(error);
}

export function failure(
  operation: string,
  error: unknown,
  meta: OperationMeta | Record<string, never> = {},
): CliEnvelope<null, OperationMeta | Record<string, never>> {
  const details = error && typeof error === 'object' && 'details' in error
    ? (error as { details?: unknown }).details ?? null
    : null;
  return {
    ok: false,
    operation,
    data: null,
    error: {
      code: getErrorCode(error, 'INTERNAL_ERROR'),
      message: getErrorMessage(error).trim(),
      details,
    },
    meta,
  };
}

export function requireId(value: unknown, name = 'itemId'): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TaobaoError('INVALID_ARGUMENT', `${name} 必须为数字字符串。`);
  }
  return value;
}
