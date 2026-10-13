import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";

const CLAUDE_CLI_AUTH_METHODS = [
  "claude.ai",
  "api_key",
  "api_key_helper",
  "oauth_token",
  "third_party",
  "none",
] as const;

/**
 * Reason the CLI auth probe could not establish availability.
 *
 * - `timeout`: `claude auth status --json` exceeded the probe budget.
 * - `spawn`: the CLI process could not be started (missing on PATH, wrapper
 *   resolution failed, or spawn-time error).
 * - `output`: the process produced output we could not interpret (truncated,
 *   malformed JSON, or unparsable status payload).
 * - `unknown`: any other unreadable failure.
 *
 * Distinguishing `timeout` lets the caller tell the user "your CLI is
 * probably fine; the probe was too short" instead of "run `claude auth
 * login`" — see #170503.
 */
export type ClaudeCliAuthUnavailableReason = "timeout" | "spawn" | "output" | "unknown";

export type ClaudeCliAuthStatus =
  | {
      status: "available";
      authMethod?: (typeof CLAUDE_CLI_AUTH_METHODS)[number];
      email?: string;
    }
  | { status: "missing" }
  | { status: "unreadable"; reason: ClaudeCliAuthUnavailableReason };

/** Probe budget. The reporter's `claude auth status --json` takes ~3.6s on
 *  WSL2/NativeLinux; the previous 3s budget produced false-unauthenticated
 *  reports. 10s accommodates the observed cold-start latency while still
 *  failing fast on a real hang. (Closes #170503.) */
const CLAUDE_CLI_AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Ask Claude CLI whether its own login is usable without reading token material. */
export async function probeClaudeCliAuthStatus(params?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ClaudeCliAuthStatus> {
  const env = { ...(params?.env ?? process.env) };
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  try {
    const program = resolveWindowsSpawnProgram({
      command: params?.command ?? "claude",
      env,
      packageName: "@anthropic-ai/claude-code",
    });
    const invocation = materializeWindowsSpawnProgram(program, ["auth", "status", "--json"]);
    const result = await runUtf8CommandWithTimeout([invocation.command, ...invocation.argv], {
      baseEnv: env,
      maxOutputBytes: 64 * 1024,
      maxCombinedOutputBytes: 64 * 1024,
      terminateOnOutputLimit: true,
      timeoutMs: CLAUDE_CLI_AUTH_PROBE_TIMEOUT_MS,
      signal: params?.signal,
      killProcessTree: true,
    });
    params?.signal?.throwIfAborted();
    if (result.termination !== "exit" || result.code === null) {
      // Distinguish a wall-time timeout from other unreadable causes so callers
      // can tell the user "your CLI is probably fine; the probe was too short"
      // instead of "run `claude auth login`". (#170503)
      const reason: ClaudeCliAuthUnavailableReason =
        result.termination === "no-output-timeout" || result.noOutputTimedOut === true
          ? "timeout"
          : result.termination === "timeout"
            ? "timeout"
            : "unknown";
      return { status: "unreadable", reason };
    }
    if (result.code !== 0) {
      return { status: "missing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { status: "unreadable", reason: "output" };
    }
    if (!isRecord(parsed) || parsed.loggedIn !== true) {
      return { status: "missing" };
    }
    const authMethod = CLAUDE_CLI_AUTH_METHODS.find((method) => method === parsed.authMethod);
    const email = authMethod === "claude.ai" ? normalizeOptionalString(parsed.email) : undefined;
    return {
      status: "available",
      ...(authMethod ? { authMethod } : {}),
      ...(email && email.length <= 320 && !/[\r\n]/u.test(email) ? { email } : {}),
    };
  } catch {
    params?.signal?.throwIfAborted();
    return { status: "unreadable", reason: "spawn" };
  }
}
