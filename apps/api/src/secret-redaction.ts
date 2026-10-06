const sensitiveFieldName = /password|passphrase|secret|private.?key|seed.?phrase|mnemonic|api.?key|(?:access|refresh|auth|session).?token|authorization|cookie|credential/i;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function containsSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  if (!value || typeof value !== 'object' || !isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => sensitiveFieldName.test(key) || containsSensitiveField(nested));
}

export function redactSensitiveFields(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (value && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined).map(([key, nested]) => [
      key,
      sensitiveFieldName.test(key) ? '[REDACTED]' : redactSensitiveFields(nested),
    ]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
