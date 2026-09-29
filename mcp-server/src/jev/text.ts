// Ported from jkudish/jev-mcp src/lib.ts (MIT). See THIRD-PARTY-NOTICES.md.

/** Truncate long text with an explicit marker so the model knows it is partial. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + " […truncated]";
}

/**
 * Sanitize a caller-supplied id into a safe Choice option key.
 * Keeps alphanumerics, underscore, dash and dot; collapses the rest.
 */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "";
}

export type Identifiable = { id?: string; [key: string]: unknown };

/** Ensure ids exist, are safe, and are unique; returns the id actually used per candidate. */
export function ensureUniqueIds<T extends Identifiable>(
  items: T[],
  fallbackPrefix: string,
): { items: Array<T & { id: string }>; renamed: Map<string, string> } {
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const out = items.map((item, i) => {
    const raw = item.id ?? "";
    const base = sanitizeId(raw) || `${fallbackPrefix}${i}`;
    let id = base;
    let n = 1;
    while (used.has(id)) {
      id = `${base}_${n++}`;
    }
    used.add(id);
    if (raw && raw !== id) renamed.set(raw, id);
    return { ...item, id } as T & { id: string };
  });
  return { items: out, renamed };
}
