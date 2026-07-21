import { cn } from "@/lib/utils";
import type { ServerInfo } from "@/lib/types";

export function statusInfo(server: ServerInfo): { tone: "ok" | "warn" | "err" | "off"; text: string } {
  if (!server.enabled) return { tone: "off", text: "Off" };
  if (server.authType === "oauth" && server.oauthStatus !== "ok") {
    return { tone: "warn", text: server.oauthStatus === "pending" ? "Authorizing…" : "Needs auth" };
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
