#!/usr/bin/env node
/**
 * Model comparison: one shared typed question, answered by every configured evaluation model
 * through this server's own upstream path and validated by the same fail-closed readers the tools
 * use.
 *
 * Not part of the server or the offline test suite: it needs the network and a real key.
 *
 *   npm run bench
 *   npm run bench -- --n=300 --datasets=ag_news,emotion:200,sst2
 *   npm run bench -- --models=typesafe-ai/jev,convaiinnovations/laya,liquid/d1
 *
 * `--datasets` takes `name` or `name:count` entries (`--n` is the count for bare entries). Every
 * task is a realistic decision — a closed label set of a handful of options, or a yes/no question —
 * never a large catalogue used as a stress test.
 *
 * The question reaches the endpoint through `postToEndpoint` (the one boundary `callJev` wraps),
 * and every answer passes the tools' own validator (`validateChoiceAnswer`, `validateNoulAnswer`)
 * before it counts — so a model whose wire shape does not satisfy the readers shows up here as
 * `invalid`, not as a silently accepted verdict.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, parseEnvFile, type Config } from "../src/config.ts";
import { postToEndpoint } from "../src/forward.ts";
import { isRecord } from "../src/guards.ts";
import { validateChoiceAnswer, validateNoulAnswer } from "../src/jev/answers.ts";
import { choiceQuestion, yesNoQuestion, type JevQuestion } from "../src/jev/questions.ts";

type Kind = "choice" | "boolean";

type DatasetSpec = {
  readonly kind: Kind;
  readonly dataset: string;
  readonly config: string;
  readonly split: string;
  readonly textField: string;
  readonly labelField: string;
  readonly instructions: string;
  /** Boolean only: the label that means "yes". */
  readonly positiveLabel?: string;
};

/** Labelled tasks fetched as JSON from the Hugging Face datasets server. Small, closed label sets. */
const DATASETS: Record<string, DatasetSpec> = {
  ag_news: {
    kind: "choice",
    dataset: "fancyzhx/ag_news",
    config: "default",
    split: "test",
    textField: "text",
    labelField: "label",
    instructions: "Which news topic is this headline and lead about?",
  },
  emotion: {
    kind: "choice",
    dataset: "dair-ai/emotion",
    config: "split",
    split: "test",
    textField: "text",
    labelField: "label",
    instructions: "Which emotion does this text most express?",
  },
  sst2: {
    kind: "boolean",
    dataset: "SetFit/sst2",
    config: "default",
    split: "test",
    textField: "text",
    labelField: "label",
    instructions: "Does this text express a positive sentiment?",
    positiveLabel: "positive",
  },
};

const DEFAULT_MODELS = ["typesafe-ai/jev", "convaiinnovations/laya", "liquid/d1"];
const DEFAULT_DATASETS = ["ag_news", "emotion", "sst2"];
const HF_ROWS = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;
const QUESTION_ID = "label";

type Sample = { readonly text: string; readonly gold: string };

type Observation = {
  readonly model: string;
  readonly dataset: string;
  correct: boolean;
  invalid: boolean;
  error: string | null;
  latencyMs: number;
  confidence: number | null;
  inputTokens: number | null;
  costUsd: number | null;
};

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number, got "${raw}"`);
  return Math.floor(value);
}

function listFlag(name: string, fallback: readonly string[]): string[] {
  const raw = flag(name);
  const source = raw === undefined || raw === "" ? fallback : raw.split(",");
  return source.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * Base configuration: the shell's environment, or — when `--env=<file>` names one — that file
 * alone, so a poisoned `JEV_API_KEY` exported into the shell cannot shadow the key under test.
 */
function baseConfig(envPath: string | undefined): Config {
  if (envPath === undefined || envPath === "") return loadConfig();
  return loadConfig(parseEnvFile(readFileSync(envPath, "utf8")), process.cwd());
}

/** Class names carried by a `ClassLabel` feature, or `null` when the label is a plain index. */
function classNames(body: Record<string, unknown>, labelField: string): string[] | null {
  const features = Array.isArray(body["features"]) ? body["features"] : [];
  for (const feature of features) {
    if (!isRecord(feature) || feature["name"] !== labelField || !isRecord(feature["type"])) continue;
    const names = feature["type"]["names"];
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names as string[];
  }
  return null;
}

async function loadSamples(spec: DatasetSpec, limit: number): Promise<{ labels: string[]; samples: Sample[] }> {
  const samples: Sample[] = [];
  let classLabel: string[] | null = null;
  const textLabels: (string | undefined)[] = [];
  let resolved = false;
  for (let offset = 0; offset < limit; offset += PAGE) {
    const length = Math.min(PAGE, limit - offset);
    const url = `${HF_ROWS}?dataset=${encodeURIComponent(spec.dataset)}&config=${encodeURIComponent(spec.config)}&split=${encodeURIComponent(spec.split)}&offset=${offset}&length=${length}`;
    const response = await fetch(url);
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || typeof body["error"] === "string") {
      const detail = isRecord(body) && typeof body["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
      throw new Error(`datasets-server ${spec.dataset}: ${detail}`);
    }
    if (!resolved) {
      classLabel = classNames(body, spec.labelField);
      resolved = true;
    }
    const rawRows = Array.isArray(body["rows"]) ? body["rows"] : [];
    if (rawRows.length === 0) break;
    for (const entry of rawRows) {
      if (!isRecord(entry) || !isRecord(entry["row"])) continue;
      const row = entry["row"];
      const text = row[spec.textField];
      const label = row[spec.labelField];
      if (typeof text !== "string" || typeof label !== "number") continue;
      let gold = classLabel?.[label];
      if (gold === undefined && classLabel === null) {
        const textLabel = row[`${spec.labelField}_text`];
        if (typeof textLabel !== "string") continue;
        textLabels[label] = textLabel;
        gold = textLabel;
      }
      if (gold === undefined) continue;
      samples.push({ text, gold });
    }
  }
  const labels = classLabel ?? textLabels.filter((name): name is string => name !== undefined);
  if (labels.length === 0) throw new Error(`datasets-server ${spec.dataset}: no label names for "${spec.labelField}"`);
  return { labels, samples };
}

type Task = {
  readonly id: string;
  readonly kind: Kind;
  readonly question: JevQuestion;
  /** Choice only: the criteria keys the answer distribution must cover. */
  readonly keys: string[];
  /** Boolean only: the gold label that means "yes". */
  readonly positiveLabel: string;
};

function buildTask(id: string, spec: DatasetSpec, labels: string[], base: Config): Task {
  if (spec.kind === "choice") {
    const criteria: Record<string, string> = {};
    for (const name of labels) criteria[name] = name.replace(/_/g, " ");
    return { id, kind: "choice", question: choiceQuestion(spec.instructions, criteria), keys: Object.keys(criteria), positiveLabel: "" };
  }
  const positive = spec.positiveLabel ?? labels[1] ?? labels[0] ?? "yes";
  const criteria = { true: `the text is ${positive}`, false: `the text is not ${positive}` };
  return { id, kind: "boolean", question: yesNoQuestion(base, spec.instructions, criteria), keys: [], positiveLabel: positive };
}

function readUsageTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const value = usage["inputTokens"] ?? usage["input_tokens"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readGatewayCost(providerMetadata: unknown): number | null {
  if (!isRecord(providerMetadata) || !isRecord(providerMetadata["gateway"])) return null;
  const raw = providerMetadata["gateway"]["cost"];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

async function observe(base: Config, model: string, task: Task, sample: Sample): Promise<Observation> {
  const observation: Observation = {
    model,
    dataset: task.id,
    correct: false,
    invalid: false,
    error: null,
    latencyMs: 0,
    confidence: null,
    inputTokens: null,
    costUsd: null,
  };
  const started = Date.now();
  let response;
  try {
    response = await postToEndpoint({ ...base, model }, { model, state: sample.text, questions: { [QUESTION_ID]: task.question } });
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error);
    observation.latencyMs = Date.now() - started;
    return observation;
  }
  observation.latencyMs = Date.now() - started;
  if (!response.ok) {
    observation.error = `HTTP ${response.status}`;
    return observation;
  }
  const body = isRecord(response.body) ? response.body : {};
  const answers = isRecord(body["answers"]) ? body["answers"] : {};
  const answer = answers[QUESTION_ID];
  if (task.kind === "choice") {
    const validated = validateChoiceAnswer(answer, task.keys);
    if (validated === null) observation.invalid = true;
    else {
      observation.correct = validated.choice === sample.gold;
      observation.confidence = validated.confidence;
    }
  } else {
    const probability = validateNoulAnswer(answer);
    if (probability === null) observation.invalid = true;
    else {
      observation.correct = (probability >= 0.5) === (sample.gold === task.positiveLabel);
      observation.confidence = Math.max(probability, 1 - probability);
    }
  }
  observation.inputTokens = readUsageTokens(body["usage"]);
  observation.costUsd = readGatewayCost(body["providerMetadata"]);
  return observation;
}

async function runPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await run(item);
    }
  });
  await Promise.all(workers);
}

type Aggregate = {
  n: number;
  correct: number;
  invalid: number;
  errors: number;
  codes: Record<string, number>;
  confidenceSum: number;
  confidenceN: number;
  latencySum: number;
  tokens: number;
  cost: number;
};

function accumulate(into: Aggregate, observation: Observation): void {
  into.n += 1;
  if (observation.correct) into.correct += 1;
  if (observation.invalid) into.invalid += 1;
  if (observation.error !== null) {
    into.errors += 1;
    into.codes[observation.error] = (into.codes[observation.error] ?? 0) + 1;
  }
  if (observation.confidence !== null) {
    into.confidenceSum += observation.confidence;
    into.confidenceN += 1;
  }
  into.latencySum += observation.latencyMs;
  if (observation.inputTokens !== null) into.tokens += observation.inputTokens;
  if (observation.costUsd !== null) into.cost += observation.costUsd;
}

function ratio(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`;
}

function mean(sum: number, n: number): number | null {
  return n === 0 ? null : sum / n;
}

function aggregateRow(label: string, dataset: string, aggregate: Aggregate): string {
  const confidence = mean(aggregate.confidenceSum, aggregate.confidenceN);
  const latency = mean(aggregate.latencySum, aggregate.n);
  return `| ${[
    label,
    dataset,
    String(aggregate.n),
    ratio(aggregate.correct, aggregate.n),
    ratio(aggregate.invalid, aggregate.n),
    ratio(aggregate.errors, aggregate.n),
    confidence === null ? "—" : confidence.toFixed(3),
    latency === null ? "—" : `${Math.round(latency)} ms`,
    String(aggregate.tokens),
    aggregate.cost === 0 ? "$0" : `$${aggregate.cost.toFixed(4)}`,
  ].join(" | ")} |`;
}

const HEADER = "| Model | Dataset | N | Accuracy | Invalid | Errors | Mean confidence | Mean latency | Input tokens | Cost |";
const RULE = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

function render(
  observations: readonly Observation[],
  models: readonly string[],
  taskIds: readonly string[],
  labelCounts: Record<string, number>,
  counts: Record<string, number>,
  base: Config,
): { markdown: string; summary: string } {
  const byModelDataset = new Map<string, Aggregate>();
  const byModel = new Map<string, Aggregate>();
  for (const observation of observations) {
    const key = `${observation.model}\u0000${observation.dataset}`;
    let cell = byModelDataset.get(key);
    if (cell === undefined) {
      cell = { n: 0, correct: 0, invalid: 0, errors: 0, codes: {}, confidenceSum: 0, confidenceN: 0, latencySum: 0, tokens: 0, cost: 0 };
      byModelDataset.set(key, cell);
    }
    accumulate(cell, observation);
    let modelCell = byModel.get(observation.model);
    if (modelCell === undefined) {
      modelCell = { n: 0, correct: 0, invalid: 0, errors: 0, codes: {}, confidenceSum: 0, confidenceN: 0, latencySum: 0, tokens: 0, cost: 0 };
      byModel.set(observation.model, modelCell);
    }
    accumulate(modelCell, observation);
  }

  const lines: string[] = [];
  for (const dataset of taskIds) {
    lines.push(HEADER, RULE);
    const failures: string[] = [];
    for (const model of models) {
      const cell = byModelDataset.get(`${model}\u0000${dataset}`);
      if (cell === undefined) continue;
      lines.push(aggregateRow(model, dataset, cell));
      if (cell.errors > 0) {
        const codes = Object.entries(cell.codes)
          .map(([code, count]) => `${code} ×${count}`)
          .join(", ");
        failures.push(`${model}: ${codes}`);
      }
    }
    if (failures.length > 0) lines.push("", `Errors — ${failures.join("; ")}`);
    lines.push("");
  }
  lines.push("Overall:", "", HEADER, RULE);
  for (const model of models) {
    const cell = byModel.get(model);
    if (cell !== undefined) lines.push(aggregateRow(model, "all", cell));
  }

  const host = new URL(base.url).host;
  const datasets = taskIds.map((id) => `${id} (${labelCounts[id] ?? 0} labels, up to ${counts[id] ?? 0} samples)`).join(", ");
  const markdown = [
    "# Evaluation models compared",
    "",
    "Generated by `npm run bench` (`mcp-server/scripts/bench-models.ts`). Do not hand-edit.",
    "",
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Endpoint: \`${host}\` (verbatim \`JEV_URL\`, yes/no spelling \`${base.questionType}\`)`,
    `- Models: ${models.map((model) => `\`${model}\``).join(", ")}`,
    `- Datasets: ${datasets}`,
    "",
    "## Method",
    "",
    "Each task is a realistic decision: a closed label set of a handful of options (Choice) or one",
    "yes/no question (Boolean). The same state and the same question go to every model, so only the",
    "model id differs. A request goes through `postToEndpoint` — the single upstream boundary",
    "`callJev` wraps — and the reply is read by the tools' own validators (`validateChoiceAnswer`,",
    "`validateNoulAnswer`): a Choice counts when the validated `choice` matches the gold label, a",
    "Boolean when the answer's side of 0.5 matches it, and a reply the readers reject is `invalid`,",
    "never a verdict.",
    "",
    "`Invalid` is the compatibility signal: a non-zero column means that model's wire shape does not",
    "satisfy this server's fail-closed answer readers. Cost is read from",
    "`providerMetadata.gateway.cost` (Vercel AI Gateway reports it there; top-level `usage.cost` is",
    "null there). `Mean confidence` is the reader's `confidence` field — not the same quantity across",
    "models, so treat it as a per-model diagnostic, not a ranking.",
    "",
    "## Results",
    "",
    ...lines,
  ].join("\n");

  const summaryLines: string[] = [];
  for (const dataset of taskIds) {
    summaryLines.push(`${dataset}:`);
    for (const model of models) {
      const cell = byModelDataset.get(`${model}\u0000${dataset}`);
      if (cell !== undefined) summaryLines.push(`  ${model.padEnd(26)} acc ${ratio(cell.correct, cell.n)}  invalid ${ratio(cell.invalid, cell.n)}  ${Math.round(mean(cell.latencySum, cell.n) ?? 0)} ms  ${cell.cost === 0 ? "$0" : `$${cell.cost.toFixed(4)}`}`);
    }
  }
  return { markdown: markdown + "\n", summary: summaryLines.join("\n") };
}

async function main(): Promise<void> {
  const limit = numberFlag("n", 300);
  const concurrency = numberFlag("concurrency", 6);
  const models = listFlag("models", DEFAULT_MODELS);
  const datasets = listFlag("datasets", DEFAULT_DATASETS).map((entry) => {
    const [id = "", rawCount = ""] = entry.split(":");
    const count = rawCount === "" ? limit : Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`bad sample count in --datasets entry "${entry}"`);
    return { id, count: Math.floor(count) };
  });
  const out = flag("out") ?? "docs/bench/model-comparison.md";
  const base = baseConfig(flag("env"));

  if (models.length === 0) throw new Error("--models selected no models");
  if (datasets.length === 0) throw new Error("--datasets selected no datasets");

  const observations: Observation[] = [];
  const labelCounts: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const { id, count } of datasets) {
    const spec = DATASETS[id];
    if (spec === undefined) throw new Error(`unknown dataset "${id}" — known: ${Object.keys(DATASETS).join(", ")}`);
    const { labels, samples } = await loadSamples(spec, count);
    labelCounts[id] = labels.length;
    counts[id] = count;
    const task = buildTask(id, spec, labels, base);
    const jobs = models.flatMap((model) => samples.map((sample) => ({ model, sample })));
    process.stderr.write(`# ${id} (${spec.kind}): ${samples.length} samples × ${models.length} models, ${jobs.length} calls\n`);
    let done = 0;
    await runPool(jobs, concurrency, async ({ model, sample }) => {
      observations.push(await observe(base, model, task, sample));
      done += 1;
      if (done % 100 === 0) process.stderr.write(`  ${done}/${jobs.length}\n`);
    });
  }

  const report = render(observations, models, datasets.map((entry) => entry.id), labelCounts, counts, base);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report.markdown);
  process.stdout.write(report.summary + "\n");
  process.stderr.write(`\nwrote ${out}\n`);
}

await main();
