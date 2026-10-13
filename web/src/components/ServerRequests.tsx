import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApiMutation, useServerRequests } from "@/lib/hooks";
import type { ServerRequest } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Badge, Button, Input } from "@/components/ui";

/** My own local-command request, filed for the Admin because I may not run local commands myself. */
export function isWaitingForAdmin(req: ServerRequest): boolean {
  return req.status === "pending" && req.escalated && req.requestedByUsername === null;
}

/** Pending, and mine (or the Admin's, for someone else's) to approve or deny. */
export function needsMyAction(req: ServerRequest): boolean {
  return req.status === "pending" && !isWaitingForAdmin(req);
}

/** Who asked: an agent, a person in the web UI, and (in the Admin's queue) which user. */
function Requester({ req }: { req: ServerRequest }) {
  return (
    <>
      {req.requestedByUsername && (
        <Badge className="border-primary/40 text-primary" title="This request was escalated to you by another user">
          from {req.requestedByUsername}
        </Badge>
      )}
      {req.requestedByAgentSlug ? (
        <code className="font-mono text-[13px] font-semibold">{req.requestedByAgentSlug}</code>
      ) : (
        // Filed from the web UI: the "from <user>" badge already says who.
        !req.requestedByUsername && <span className="text-[13px] font-semibold">You</span>
      )}
    </>
  );
}

/** One-line description of what the request would create. */
function configSummary(req: ServerRequest): string {
  const s = req.server;
  if (!s) return "no config — freeform ask";
  if (s.type === "stdio") return [s.command, ...s.args].join(" ");
  return s.url ?? "";
}

/**
 * Approving an stdio request authorizes command execution on the host, so the exact
 * command line and env keys get the loudest block in the app — never a summary.
 */
function StdioWarning({ req }: { req: ServerRequest }) {
  const s = req.server!;
  const asked = req.requestedByUsername ? `${req.requestedByUsername} asked for` : "This asks for";
  return (
    <div className="mt-3 rounded-[10px] border border-err/40 bg-err-bg px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-err">
        <AlertTriangle size={14} />
        This will execute on your machine
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-border-soft bg-code-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed">
        {[s.command, ...s.args].join(" ")}
      </pre>
      {s.cwd && <p className="mt-2 font-mono text-[11px] text-muted-fg">cwd: {s.cwd}</p>}
      {s.envKeys.length > 0 && (
        <p className="mt-2 font-mono text-[11px] text-muted-fg">
          env: {s.envKeys.join(", ")}
          <span className="ml-1.5 font-sans text-faint">(names only; values are stored encrypted)</span>
        </p>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-fg">
        {req.requestedByUsername
          ? `${asked} a command that runs on this machine under the switchboard's account, with no sandbox. If you approve it, it becomes ${req.requestedByUsername}'s server. Approve only if you recognise the package and trust ${req.requestedByUsername}.`
          : "The switchboard spawns this process with your user account. Approve only if you recognise the package and trust where the agent found it."}
      </p>
    </div>
  );
}

function PendingCard({ req }: { req: ServerRequest }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");

  const approve = useApiMutation(
    () => api(`/api/requests/${req.id}/approve`, { method: "POST" }),
    ["requests", "servers", "agents"],
    () =>
      toast.success(
        req.requestedByUsername
          ? `Approved — ${req.server?.slug ?? "the server"} now belongs to ${req.requestedByUsername}`
          : `Approved — ${req.server?.slug ?? "the server"} is live for the requesting agent`,
      ),
  );
  const deny = useApiMutation(
    () => api(`/api/requests/${req.id}/deny`, { method: "POST", json: { note: note.trim() || undefined } }),
    ["requests"],
    () => {
      setDenying(false);
      setNote("");
      toast.success(req.requestedByUsername ? "Request denied — they can read your note" : "Request denied — the agent can read your note");
    },
  );

  const s = req.server;
  const busy = approve.isPending || deny.isPending;

  return (
    <div className="border-b border-border-soft px-4 py-3.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Requester req={req} />
        <span className="text-xs text-faint">
          {req.kind === "add_server" ? "wants to add a server" : "is asking for a server"}
        </span>
        <Badge className="font-mono">#{req.id}</Badge>
        <span className="ml-auto text-[11px] text-faint">{timeAgo(req.createdAt)}</span>
      </div>

      {req.reason && <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-fg">{req.reason}</p>}

      {s && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[10px] border border-border-soft bg-panel-2/40 px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-xs font-semibold">{s.slug}</span>
            <span className="block truncate font-mono text-[11px] text-faint" title={configSummary(req)}>
              {configSummary(req)}
            </span>
          </span>
          <Badge>
            {s.type === "stdio" ? "Local · stdio" : `Remote · ${s.authType === "none" ? s.type.toUpperCase() : s.authType}`}
          </Badge>
        </div>
      )}

      {s?.type === "stdio" && <StdioWarning req={req} />}

      {!s && (
        <p className="mt-2.5 rounded-[10px] bg-panel-2 px-3 py-2 text-xs leading-relaxed text-muted-fg">
          No config came with this ask, so there's nothing to approve. Add the server yourself, or deny with a note
          telling the agent to re-request with a config.
        </p>
      )}

      {denying ? (
        <div className="mt-3 flex items-center gap-2">
          <Input
            className="font-sans"
            autoFocus
            value={note}
            placeholder="Optional note the agent can read back"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") deny.mutate(undefined);
              if (e.key === "Escape") setDenying(false);
            }}
          />
          <Button size="sm" variant="danger" disabled={busy} onClick={() => deny.mutate(undefined)}>
            Confirm deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          {s && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => approve.mutate(undefined)}>
              {s.type === "stdio" ? "Approve & run" : "Approve"}
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setDenying(true)}>
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

/** The requester's side of an escalated request: nothing to approve, only a way to withdraw it. */
function WaitingCard({ req }: { req: ServerRequest }) {
  const cancel = useApiMutation(
    () => api(`/api/requests/${req.id}/cancel`, { method: "POST" }),
    ["requests"],
    () => toast.success("Request cancelled"),
  );
  const s = req.server;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-soft px-4 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">{s?.slug ?? "server"}</span>
          <Badge className="border-transparent bg-warn-bg font-semibold text-warn">waiting for Admin</Badge>
          <span className="text-[11px] text-faint">{timeAgo(req.createdAt)}</span>
        </span>
        <span className="block truncate font-mono text-[11px] text-faint">{s ? configSummary(req) : req.reason}</span>
        <span className="mt-0.5 block text-[11.5px] text-faint">
          Local commands need the Admin's approval. You'll see the result here.
        </span>
      </span>
      <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
        Cancel
      </Button>
    </div>
  );
}

function ResolvedRow({ req }: { req: ServerRequest }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border-soft px-4 py-2 last:border-0">
      <Badge
        className={cn(
          "border-transparent font-semibold",
          req.status === "approved" ? "bg-ok-bg text-ok" : "bg-panel-2 text-muted-fg",
        )}
      >
        {req.status}
      </Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">
          {req.requestedByUsername && <span className="text-primary">from {req.requestedByUsername} · </span>}
          <code className="font-mono font-semibold">{req.requestedByAgentSlug ?? req.requestedByUsername ?? "you"}</code>
          {" · "}
          {req.server ? req.server.slug : (req.reason ?? "freeform request")}
        </span>
        {req.resolutionNote && <span className="block truncate text-[11px] text-faint">note: {req.resolutionNote}</span>}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{timeAgo(req.resolvedAt ?? req.createdAt)}</span>
    </div>
  );
}

/**
 * Review panel for agent-filed server requests. Renders nothing at all when no agent has
 * ever asked, so the Servers page is unchanged for people who never turn the feature on.
 */
export function ServerRequestsPanel() {
  const { data } = useServerRequests();
  const [showResolved, setShowResolved] = useState(false);

  const requests = data ?? [];
  const pending = requests.filter(needsMyAction);
  const waiting = requests.filter(isWaitingForAdmin);
  const resolved = requests.filter((r) => r.status !== "pending");
  if (pending.length === 0 && waiting.length === 0 && resolved.length === 0) return null;

  return (
    <div className="mb-4">
      {pending.length > 0 && (
        <div className="overflow-hidden rounded-[14px] border border-warn/40 bg-panel">
          <div className="flex items-center gap-2 border-b border-border-soft bg-warn-bg px-4 py-2.5">
            <AlertTriangle size={14} className="text-warn" />
            <span className="text-[13px] font-semibold tracking-tight">
              {pending.length} pending request{pending.length === 1 ? "" : "s"}
            </span>
            <span className="text-xs text-faint">
              {pending.some((r) => r.requestedByUsername) ? "agents and users are waiting on you" : "agents are waiting on you"}
            </span>
          </div>
          {pending.map((req) => (
            <PendingCard key={req.id} req={req} />
          ))}
        </div>
      )}

      {waiting.length > 0 && (
        <div className={cn("overflow-hidden rounded-[14px] border border-border bg-panel", pending.length > 0 && "mt-2")}>
          {waiting.map((req) => (
            <WaitingCard key={req.id} req={req} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="mt-2">
          <button
            className="flex cursor-pointer items-center gap-1.5 px-1 py-1 text-xs font-medium text-muted-fg hover:text-foreground"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Resolved requests ({resolved.length})
          </button>
          {showResolved && (
            <div className="mt-1 overflow-hidden rounded-[14px] border border-border bg-panel">
              {resolved.map((req) => (
                <ResolvedRow key={req.id} req={req} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
