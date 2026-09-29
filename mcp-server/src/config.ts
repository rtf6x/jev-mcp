import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Spelling of a yes/no question the configured endpoint expects. */
export type QuestionType = "noul" | "boolean";

export type Config = {
  /** Upstream Jev endpoint, used verbatim. */
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly questionType: QuestionType;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly timeoutMs: number;
  /** Path of the `.env` file that was read (or would have been). */
  readonly envPath: string;
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULTS = {
  model: "jev-latest",
  questionType: "noul",
  httpHost: "127.0.0.1",
  httpPort: 18791,
  timeoutMs: 60_000,
} as const;

const ENV_FILE_VAR = "JEV_MCP_ENV";

/**
 * Parse a `.env` body: `KEY=VALUE` lines, `#` comments, optional `export` prefix and
 * optional single or double quotes around the value. Unknown lines are skipped.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    const value = raw.trim();
    const first = value[0];
    const quoted = value.length >= 2 && (first === '"' || first === "'") && value[value.length - 1] === first;
    values[key] = quoted ? value.slice(1, -1) : value;
  }
  return values;
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function envFilePath(env: NodeJS.ProcessEnv, cwd: string): string {
  const override = env[ENV_FILE_VAR];
  return resolve(cwd, override === undefined || override === "" ? ".env" : override);
}

/**
 * Load configuration. Real environment variables win over `.env` entries; the file is only
 * consulted for keys the environment does not carry. Missing or malformed settings are a
 * startup error, never a silent default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const envPath = envFilePath(env, cwd);
  const file = readEnvFile(envPath);
  const read = (key: string): string | undefined => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv.trim();
    const fromFile = file[key];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
    return undefined;
  };
  const required = (key: string, hint: string): string => {
    const value = read(key);
    if (value === undefined) throw new ConfigError(`${key} is not set — ${hint} (${envPath})`);
    return value;
  };

  const url = required("JEV_URL", "the endpoint that receives the request, used verbatim");
  assertHttpUrl(url, envPath);

  const apiKey = required("JEV_API_KEY", "the bearer key for that endpoint");

  const questionType = read("JEV_QUESTION_TYPE") ?? DEFAULTS.questionType;
  if (questionType !== "noul" && questionType !== "boolean") {
    throw new ConfigError(`JEV_QUESTION_TYPE must be "noul" or "boolean", got "${questionType}" (${envPath})`);
  }

  return {
    url,
    apiKey,
    model: read("JEV_MODEL") ?? DEFAULTS.model,
    questionType,
    httpHost: read("MCP_HOST") ?? DEFAULTS.httpHost,
    httpPort: readInt(read("MCP_HTTP_PORT"), "MCP_HTTP_PORT", DEFAULTS.httpPort, 1, 65_535, envPath),
    timeoutMs: readInt(read("JEV_TIMEOUT_MS"), "JEV_TIMEOUT_MS", DEFAULTS.timeoutMs, 1, 600_000, envPath),
    envPath,
  };
}

function assertHttpUrl(value: string, envPath: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`JEV_URL must be an absolute URL, got "${value}" (${envPath})`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`JEV_URL must be http or https, got "${parsed.protocol}" (${envPath})`);
  }
}

function readInt(
  value: string | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
  envPath: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be an integer in ${min}..${max}, got "${value}" (${envPath})`);
  }
  return parsed;
}
