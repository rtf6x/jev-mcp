/**
 * Canonical structural guard for this package. Fields stay `unknown`: this proves an object,
 * and nothing more. Every call site imports it from here instead of defining its own.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
