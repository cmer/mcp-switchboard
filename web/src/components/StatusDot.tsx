import { cn } from "@/lib/utils";
import type { ReceivedShare, ServerInfo } from "@/lib/types";

export function statusInfo(server: ServerInfo): { tone: "ok" | "warn" | "err" | "off"; text: string } {
  if (!server.enabled) return { tone: "off", text: "Off" };
  // "pending" only means an authorize flow was started at some point — until
  // tokens exist the actionable truth is the same: it needs authorization.
  if (server.authType === "oauth" && server.oauthStatus !== "ok") {
    return { tone: "warn", text: "Needs auth" };
  }
  switch (server.state) {
    case "connected":
      return { tone: "ok", text: server.type === "stdio" ? "Running" : "Connected" };
    case "connecting":
      return { tone: "warn", text: "Connecting…" };
    case "needs_auth":
      return { tone: "warn", text: "Needs auth" };
    case "backoff":
      return { tone: "err", text: "Unreachable" };
    default:
      return { tone: "off", text: "Stopped" };
  }
}

/** A received share's state in the recipient's terms, never the owner's connection details. */
export function receivedStatus(share: ReceivedShare): { tone: "ok" | "warn" | "err" | "off"; text: string; sub: string } {
  const owner = share.ownerUsername;
  if (!share.enabled) return { tone: "off", text: "Off", sub: "not offered to any of your agents" };
  switch (share.status) {
    case "connected":
      return { tone: "ok", text: "Connected", sub: `${share.toolCount} tools` };
    case "waiting_for_owner":
      return { tone: "warn", text: `Waiting for ${owner}`, sub: `${owner} needs to re-authorize` };
    default:
      return { tone: "off", text: "Unavailable", sub: `${owner}'s connection isn't available right now` };
  }
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "err" | "off" }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-ok shadow-[0_0_0_3px_var(--ok-bg)]",
        tone === "warn" && "bg-warn shadow-[0_0_0_3px_var(--warn-bg)]",
        tone === "err" && "bg-err shadow-[0_0_0_3px_var(--err-bg)]",
        tone === "off" && "bg-off",
      )}
    />
  );
}
