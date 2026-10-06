export class TaobaoError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaobaoError';
    this.code = code;
    this.details = details;
  }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
}

export function failure(operation, error, meta = {}) {
  return {
    ok: false, operation, data: null,
    error: {
      code: error.code || 'BROWSER_ERROR',
      message: String(error.message || error).split('Call log:')[0].trim(),
      details: error.details || null,
    },
    meta,
  };
}

export function requireId(value, name = 'itemId') {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TaobaoError('INVALID_ARGUMENT', `${name} 必须为数字字符串。`);
  }
  return value;
}
