// Ported from jkudish/jev-mcp src/lib.ts (MIT). See THIRD-PARTY-NOTICES.md.

import { Worker } from "node:worker_threads";
import { MAX_EXTRACT_CANDIDATE_CHARS, MAX_EXTRACT_CANDIDATES, REGEX_TIMEOUT_MS } from "./limits.ts";

// The worker is a string, not a file, so the bundle stays one artifact. `eval` workers run as
// CommonJS unless the source carries ESM syntax, which is why this uses `require`.
const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { document, pattern, flags, maxCandidates, maxCandidateChars } = workerData;
try {
  const re = new RegExp(pattern, flags);
  const seen = new Set();
  const candidates = [];
  let truncated = false;
  let tooLong = 0;
  for (const match of document.matchAll(re)) {
    const value = match[0];
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    if (value.length > maxCandidateChars) { tooLong += 1; continue; }
    if (candidates.length >= maxCandidates) { truncated = true; break; }
    candidates.push(value);
  }
  parentPort.postMessage({ candidates, truncated, tooLong });
} catch (error) {
  parentPort.postMessage({ candidates: [], truncated: false, tooLong: 0, error: String(error && error.message ? error.message : error) });
}
`;

/** Regex result shape: candidate substrings plus how the universe was capped. */
export interface RegexResult {
  candidates: string[];
  truncated: boolean;
  tooLong: number;
  error: string | null;
}

/**
 * Run a regex in an isolated worker so hostile patterns cannot hang the server.
 * An abort signal (the MCP request's cancellation) terminates the worker and
 * settles immediately instead of burning CPU on a request nobody awaits.
 */
export function runRegex(
  document: string,
  pattern: string,
  flags: string,
  signal?: AbortSignal,
): Promise<RegexResult> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        document,
        pattern,
        flags,
        maxCandidates: MAX_EXTRACT_CANDIDATES,
        maxCandidateChars: MAX_EXTRACT_CANDIDATE_CHARS,
      },
    });
    const finish = (value: RegexResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          candidates: [],
          truncated: false,
          tooLong: 0,
          error: `regex timed out after ${REGEX_TIMEOUT_MS}ms; simplify the pattern`,
        }),
      REGEX_TIMEOUT_MS,
    );
    const onAbort = () => finish({ candidates: [], truncated: false, tooLong: 0, error: "request aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.on("message", (message: Omit<RegexResult, "error"> & { error?: string }) =>
      finish({ ...message, error: message.error ?? null }),
    );
    worker.on("error", (error) =>
      finish({ candidates: [], truncated: false, tooLong: 0, error: error.message }),
    );
  });
}
