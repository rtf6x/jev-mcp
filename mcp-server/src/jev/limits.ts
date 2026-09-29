// Ported from jkudish/jev-mcp src/lib.ts (MIT). See THIRD-PARTY-NOTICES.md.

/** Max candidates in one jev_find call. TypeSafe Choice supports up to 255 options. */
export const MAX_CANDIDATES = 250;

/** Default per-candidate text cap (characters) to keep request size bounded. */
export const MAX_CANDIDATE_CHARS = 2000;

// Float-safe tolerance for probability-sum checks: a mathematically exact
// 0.01 delta (e.g. a 0.99 sum) can compare greater than 0.01 in IEEE-754.
export const PROBABILITY_SUM_TOLERANCE = 0.01 + 1e-12;

/** Max classes per jev_classify call, bounded by the Choice option limit. */
export const MAX_CLASSES = 250;

/** Max items per jev_classify call; each becomes one Choice question in one request. */
export const MAX_ITEMS = 64;

/** Item text cap; classification works on bounded excerpts, not whole documents. */
export const MAX_ITEM_CHARS = 2000;

/** Max candidates per jev_decide call. */
export const MAX_CANDIDATES_DECIDE = 6;

/** Max requirements per jev_decide call. */
export const MAX_REQUIREMENTS = 3;

/** Max candidates for jev_rerank, bounded by the Choice option limit. */
export const MAX_RERANK_CANDIDATES = 250;

/** Aggregate candidate-text budget for jev_rerank (characters, across all candidates). */
export const MAX_RERANK_TOTAL_CHARS = 100_000;

/** Max propositions for jev_noul (independent Noul questions). */
export const MAX_PROPOSITIONS = 64;

/** Max characters per jev_noul proposition. */
export const MAX_PROPOSITION_CHARS = 2000;

/** Aggregate proposition plus context budget for jev_noul (characters). */
export const MAX_NOUL_TOTAL_CHARS = 150_000;

/** Max aspects for jev_compare (independent per-aspect Choices). */
export const MAX_COMPARE_ASPECTS = 10;

/** Max fields for jev_extract per call. */
export const MAX_EXTRACT_FIELDS = 32;

/** Max records per jev_audit call, so one request stays bounded. */
export const MAX_AUDIT_RECORDS = 32;

/** Per-record request cap (characters) in jev_audit; requests are instructions, not documents. */
export const MAX_AUDIT_REQUEST_CHARS = 500;

/** Per-record value cap (characters) in jev_audit; values are extracted atoms, not documents. */
export const MAX_AUDIT_VALUE_CHARS = 2_000;

/** Max regex candidates per field before the set is flagged truncated. */
export const MAX_EXTRACT_CANDIDATES = 20;

/** A single regex match longer than this is skipped and flagged, never silently truncated. */
export const MAX_EXTRACT_CANDIDATE_CHARS = 2_000;

/** Aggregate candidate-preview budget for jev_extract (characters, across all fields). */
export const MAX_EXTRACT_TOTAL_CHARS = 50_000;

/** Hard per-field deadline for caller-supplied regex execution in a worker. */
export const REGEX_TIMEOUT_MS = 1_000;

/** Max completion claims per jev_gate call; each claim adds one Choice question. */
export const MAX_GATE_CLAIMS = 16;

/** Max evidence items per jev_gate call, so one request stays bounded. */
export const MAX_GATE_EVIDENCE_ITEMS = 16;

/** Aggregate evidence budget (characters) per jev_gate call, before per-item truncation. */
export const MAX_GATE_EVIDENCE_CHARS = 200_000;

/** Per-document cap (characters) for request, diff, tests, and evidence texts. */
export const MAX_REVIEW_DOC_CHARS = 50_000;

/** Max files in one per-file review (jev_review / jev_gate files mode). */
export const MAX_REVIEW_FILES = 16;

/** Combined-state budget (characters): request + tests + all file diffs for one per-file review. */
export const MAX_REVIEW_FILES_TOTAL_CHARS = 200_000;

/** Per-file path cap (characters) in per-file review; paths are identifiers, not documents. */
export const MAX_REVIEW_FILE_PATH_CHARS = 500;

/** Per-claim cap (characters) in jev_gate; claims are bounded assertions. */
export const MAX_CLAIM_CHARS = 2_000;

/**
 * Tolerance for checking a score answer's reported score against its own
 * distribution's expected value: |score - sum(i * p_i)| must stay within
 * this for the answer to count. With two-decimal reporting, the score itself
 * can drift by 0.005 from the exact mean, and each of the three
 * distribution probabilities can drift by 0.005, contributing up to
 * 0.005 * (0 + 1 + 2) = 0.015 more, so 0.02 covers the full rounding
 * envelope (0.005 + 0.015); the 1e-12 mirrors PROBABILITY_SUM_TOLERANCE's
 * float guard. This is a validation choice of this package, not an upstream
 * guarantee: a conforming provider may report an exactly consistent score,
 * and any drift beyond this is treated as a contradictory answer.
 */
export const SCORE_MEAN_TOLERANCE = 0.02 + 1e-12;

/** Default composite floor: auto requires the weighted composite at or above this. */
export const DEFAULT_COMPOSITE_FLOOR = 0.7;

/**
 * Review rubric weights. Correctness and spec match contribute directly;
 * test gap and blast radius are inverted first, so a high gap or wide radius
 * lowers the composite.
 */
export const REVIEW_WEIGHTS = {
  correctness: 0.4,
  spec_match: 0.3,
  test_gap: 0.15,
  blast_radius: 0.15,
} as const;
