import { createHash } from "node:crypto";
import serverPackage from "../../package.json" with { type: "json" };

/** Stable identities for helper conversations, scoped without exposing file paths. */
export function goHelperSessionId(
  projectId: string,
  kind: "latex-assist" | "methods-draft" | "next-experiments",
  ...scope: string[]
): string {
  return `kady-${createHash("sha256").update(JSON.stringify([projectId, kind, ...scope])).digest("hex")}`;
}

/**
 * Native Pi sessions already send Go attribution (including child sessions).
 * Direct ModelRuntime/summary calls bypass that SDK layer, so supply the same
 * session contract explicitly: https://opencode.ai/docs/go/#where-can-i-use-it.
 * Compaction passes the original Pi session id; one-shots use scoped helper ids.
 */
export function goRequestOptions(
  model: { provider: string },
  sessionId: string,
  headers?: Record<string, string>,
): { sessionId?: string; headers?: Record<string, string> } {
  if (model.provider !== "opencode-go") return headers ? { headers } : {};
  // Normalize header casing so an existing auth/header override cannot create
  // duplicate session or User-Agent fields. All unrelated auth headers survive.
  const merged = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    sessionId,
    headers: {
      ...merged,
      "user-agent": `kady/${serverPackage.version}`,
      "x-opencode-client": "kady",
      "x-opencode-session": sessionId,
    },
  };
}
