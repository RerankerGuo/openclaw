import fs from "node:fs/promises";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { resolveSandboxContext } from "./sandbox.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

export type WorkspaceSandboxParams = Pick<
  EmbeddedRunAttemptParams,
  | "agentId"
  | "config"
  | "cwd"
  | "execOverrides"
  | "permissionMode"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sessionId"
  | "sessionKey"
  | "sessionRoot"
  | "skillsSnapshot"
  | "requireWritableSandbox"
  | "requireWorkspaceOnly"
  | "workspaceDir"
> & {
  /**
   * Where the workspace physically lives. `"node"` means the workspace is
   * owned by a paired node and the gateway must not touch its filesystem
   * (no `mkdir`, no `realpath`) — the path is treated as an opaque string for
   * permission policy only. `"local"` (default) preserves the original
   * behaviour.
   */
  execHost?: "local" | "node";
};

/** Resolves the shared workspace and sandbox policy used by native and plugin harnesses. */
export async function resolveAttemptWorkspaceSandbox(params: WorkspaceSandboxParams) {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceLivesOnNode = params.execHost === "node";
  // Only the gateway-local case creates the workspace. A node-placed session
  // owns its workspace on the node; the gateway must not mkdir the node's
  // home (which can be a Linux path like `/home/<user>` running on a macOS
  // gateway, see #161028).
  if (!workspaceLivesOnNode) {
    await fs.mkdir(resolvedWorkspace, { recursive: true });
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandboxSessionKey = params.sandboxSessionKey?.trim() || sessionKey;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    // Independent policy sessions keep their own owner; unscoped execution retains its prepared one.
    agentId:
      params.sandboxAgentId ?? (sandboxSessionKey === sessionKey ? sessionAgentId : undefined),
    execOverrides: params.execOverrides,
    sessionKey: sandboxSessionKey,
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace =
    sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? sandbox.workspaceDir : resolvedWorkspace;
  if (params.requireWritableSandbox && sandbox?.enabled && sandbox.workspaceAccess !== "rw") {
    throw new Error("sandbox workspace is not read-write; collection review skipped");
  }
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  // Recorded roots pin worktree/explicit-cwd boundaries; rootless sessions use
  // the agent's canonical workspace as their permission boundary. The
  // realpath fallback for node-placed sessions keeps the permission root
  // distinct from the local on-disk path the gateway would otherwise resolve.
  const sessionPermissionRoot =
    params.sessionRoot ??
    (workspaceLivesOnNode
      ? resolvedWorkspace
      : await fs.realpath(resolvedWorkspace));
  const sessionPermissionPolicy = params.permissionMode
    ? {
        root: sessionPermissionRoot,
        mode: params.permissionMode,
      }
    : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
  if (!workspaceLivesOnNode) {
    await fs.mkdir(effectiveWorkspace, { recursive: true });
  }
  return {
    effectiveCwd: sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace),
    effectiveFsWorkspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: sessionAgentId,
      }),
    effectiveWorkspace,
    resolvedWorkspace,
    sessionPermissionRoot,
    sessionPermissionPolicy,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  };
}
