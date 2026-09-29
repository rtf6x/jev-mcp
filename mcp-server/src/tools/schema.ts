// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import { z } from "zod";
import { MAX_CANDIDATES, MAX_CANDIDATE_CHARS } from "../jev/limits.ts";

// Tool inputs are strict: unknown top-level keys are rejected instead of
// silently stripped, so a client typos-as-error rather than typos-as-default.
// Nested fixed-shape objects are strict for the same reason; `context`
// deliberately stays an open record.
export const strictShape = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const evidenceSchema = z.union([
  z.string().describe("A single evidence document."),
  z
    .object({
      id: z.string().optional().describe("Short identifier for this evidence item."),
      text: z.string().describe("The evidence text."),
    })
    .strict()
    .describe("A single evidence item."),
  z
    .array(
      z
        .object({
          id: z
            .string()
            .optional()
            .describe("Short identifier for this evidence item (e.g. 'site-html', 'rfc-4.1.3')."),
          text: z.string().describe("The evidence text."),
        })
        .strict(),
    )
    .min(1)
    .describe("Multiple evidence items; each claim is also matched to the item it rests on."),
]);

export const candidatesSchema = z
  .array(
    z
      .object({
        id: z
          .string()
          .optional()
          .describe("Short identifier for this candidate (e.g. a file path, note name, or line id)."),
        text: z.string().describe("The candidate's text."),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_CANDIDATES)
  .describe(
    `Candidates to search. Up to ${MAX_CANDIDATES} in one call; texts are truncated at ${MAX_CANDIDATE_CHARS} chars.`,
  );
