import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  SLOW_MS,
  LOGS_LIMIT,
  useAgents,
  useApiMutation,
  useLogDetail,
  useLogStats,
  useLogs,
  useServers,
} from "@/lib/hooks";
import type { LogFilters, LogSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBar } from "@/components/Layout";
import { Badge, Button, CopyButton, Select } from "@/components/ui";

/** Every method the switchboard answers on the agent-facing endpoint. */
const METHODS = [
  "initialize",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/read",
  "notifications/initialized",
];

const EMPTY_FILTERS: LogFilters = { agent: "", server: "", method: "", status: "", q: "" };

/* ---------- formatting ---------- */

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDay(ts: number): string {
  const day = new Date(ts).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Stored frames are compact, as they went over the wire. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // truncated payloads no longer parse
  }
}

/* ---------- pieces ---------- */

function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: "err" }) {
  return (
    <div className="min-w-[132px] flex-1 rounded-xl border border-border bg-panel px-3.5 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div className={cn("mt-0.5 text-[19px] font-semibold tabular-nums tracking-tight", tone === "err" && "text-err")}>
        {value}
        {unit && <span className="ml-1 text-xs font-medium tracking-tight text-faint">{unit}</span>}
      </div>
    </div>
  );
}

function StatusDot({ status, slow }: { status: LogSummary["status"]; slow: boolean }) {
  if (status === "pending") {
    return <span className="ml-0.5 size-[7px] animate-pulse rounded-full border-[1.5px] border-primary" />;
  }
  return (
    <span
      className={cn(
        "ml-0.5 size-[7px] rounded-full",
        status === "error" ? "bg-err" : slow ? "bg-warn" : "bg-ok",
      )}
    />
  );
}

function Pane({ title, size, body }: { title: string; size: string; body: string | null }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-fg">{title}</span>
        <span className="flex items-center gap-2 text-[11px] tabular-nums text-faint">
          {size}
          {body && <CopyButton text={body} />}
        </span>
      </div>
      {body === null ? (
        <div className="rounded-[10px] border border-dashed border-border bg-code-bg px-3.5 py-3 text-xs text-faint">
          Payload capture is off — turn it on in Settings to record frames.
        </div>
      ) : (
        <pre className="overflow-x-auto rounded-[10px] border border-border-soft bg-code-bg px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
          {prettyJson(body)}
        </pre>
      )}
    </div>
  );
}

function LogDetailPanel({ id }: { id: number }) {
  const { data, isLoading } = useLogDetail(id);
  if (isLoading || !data) return <div className="px-4 py-4 text-xs text-faint">Loading frames…</div>;

  const meta = [
    ["id", String(data.id)],
    ["session", data.sessionId ? `${data.sessionId.slice(0, 8)}…` : "—"],
    ["jsonrpc id", data.rpcId ?? "notification"],
    ["received", new Date(data.ts).toLocaleString()],
  ];

  return (
    <div className="bg-panel-2 px-4 pb-4 pt-1">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 sm:pl-[106px]">
        {meta.map(([k, v]) => (
          <div key={k} className="text-[11px] text-faint">
            {k} <span className="font-mono text-muted-fg">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2.5 sm:pl-[106px]">
        <Pane title="↓ Request from agent" size={formatBytes(data.requestBytes)} body={data.requestJson} />
        {data.status === "pending" ? (
          <div className="rounded-[10px] border border-dashed border-border px-3.5 py-3 text-xs text-faint">
            Still in flight — no response has been sent yet.
          </div>
        ) : (
          <Pane title="↑ Response sent" size={formatBytes(data.responseBytes)} body={data.responseJson} />
        )}
        {data.truncated && (
          <p className="text-[11px] text-faint">
            Payload clipped to the configured size cap — the byte counts above are the full sizes.
          </p>
        )}
      </div>
    </div>
  );
}

function LogRow({ row }: { row: LogSummary }) {
  const [open, setOpen] = useState(false);
  const slow = row.durationMs !== null && row.durationMs > SLOW_MS;
  const prefix = row.target?.includes("__") ? `${row.target.slice(0, row.target.indexOf("__") + 2)}` : null;

  return (
    <div className={cn("border-b border-border-soft last:border-b-0", open && "bg-panel-2")}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[80px_14px_minmax(0,1fr)_60px_14px] items-center gap-2.5 px-4 py-2 text-left hover:bg-panel-2 sm:grid-cols-[92px_14px_104px_96px_minmax(0,1fr)_64px_14px]"
      >
        <span className="font-mono text-[11.5px] tabular-nums text-faint">{formatTime(row.ts)}</span>
        <StatusDot status={row.status} slow={slow} />
        <span className="hidden truncate rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary sm:block">
          {row.agentSlug}
        </span>
        <span
          className={cn(
            "hidden truncate rounded-full border px-2 py-0.5 text-[11px] font-medium sm:block",
            row.serverSlug
              ? "border-border-soft bg-panel-2 text-muted-fg"
              : "border-dashed border-border text-faint",
          )}
        >
          {row.serverSlug ?? "all"}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn("whitespace-nowrap font-mono text-[12.5px]", !row.target && "text-muted-fg")}>
            {row.target ? (
              <>
                <span className="text-faint">{prefix}</span>
                {row.target.slice(prefix?.length ?? 0)}
              </>
            ) : (
              row.method
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[11.5px]",
              row.status === "error" ? "text-err" : "text-faint",
            )}
          >
            {row.status === "error"
              ? [row.errorCode, row.errorMessage].filter((v) => v !== null).join(" ")
              : (row.summary ?? "")}
          </span>
        </span>
        <span className={cn("text-right font-mono text-[11.5px] tabular-nums text-muted-fg", slow && "text-warn")}>
          {row.status === "pending" ? "…" : formatDuration(row.durationMs)}
        </span>
        {open ? (
          <ChevronDown size={13} className="justify-self-center text-faint" />
        ) : (
          <ChevronRight size={13} className="justify-self-center text-faint" />
        )}
      </button>
      {open && <LogDetailPanel id={row.id} />}
    </div>
  );
}

/* ---------- page ---------- */

export function LogsPage() {
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [live, setLive] = useState(true);

  const { data, isLoading, transport } = useLogs(filters, live);
  const { data: stats } = useLogStats(live);
  const { data: agents } = useAgents();
  const { data: servers } = useServers();

  const clear = useApiMutation(() => api("/api/logs", { method: "DELETE" }), ["logs"], () => {
    toast.success("Logs cleared");
  });

  const set = (patch: Partial<LogFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const rows = data?.rows ?? [];
  const filtered = Object.values(filters).some(Boolean);
  const errorRate = stats && stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : "0";
  const ms = (value: number | null | undefined) => (value === null || value === undefined ? "—" : String(value));

  return (
    <>
      <PageBar
        title="Logs"
        sub="Every request an agent sent through the switchboard, and what it got back."
        action={
          <div className="flex gap-2">
            <Button onClick={() => setLive((v) => !v)} className={cn(live && "text-ok")}>
              {live ? (
                <>
                  <span className="size-[7px] animate-pulse rounded-full bg-ok" />
                  {transport === "poll" ? "Live (polling)" : "Live"}
                </>
              ) : (
                "Paused"
              )}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm("Delete every recorded request? This cannot be undone.")) clear.mutate(undefined);
              }}
            >
              Clear
            </Button>
          </div>
        }
      />

      <div className="mb-3.5 flex flex-wrap gap-2">
        <Stat label="Requests · 24h" value={stats ? stats.total.toLocaleString() : "—"} />
        <Stat label="Errors · 24h" value={stats ? String(stats.errors) : "—"} unit={`${errorRate}%`} tone="err" />
        <Stat label="Median" value={ms(stats?.medianMs)} unit="ms" />
        <Stat label="p95" value={ms(stats?.p95Ms)} unit="ms" />
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <Select
          className="w-auto"
          aria-label="Filter by agent"
          value={filters.agent}
          onChange={(e) => set({ agent: e.target.value })}
        >
          <option value="">All agents</option>
          {agents?.map((a) => (
            <option key={a.id} value={a.slug}>
              {a.slug}
            </option>
          ))}
        </Select>
        <Select
          className="w-auto"
          aria-label="Filter by server"
          value={filters.server}
          onChange={(e) => set({ server: e.target.value })}
        >
          <option value="">All servers</option>
          {servers?.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.slug}
            </option>
          ))}
        </Select>
        <Select
          className="w-auto"
          aria-label="Filter by method"
          value={filters.method}
          onChange={(e) => set({ method: e.target.value })}
        >
          <option value="">All methods</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <div className="flex gap-0.5 rounded-[10px] border border-border-soft bg-panel-2 p-[3px]">
          {[
            { value: "", label: "All" },
            { value: "error", label: "Errors" },
            { value: "slow", label: "Slow" },
            { value: "pending", label: "In flight" },
          ].map((opt) => (
            <button
              key={opt.value}
              aria-pressed={filters.status === opt.value}
              onClick={() => set({ status: opt.value })}
              className={cn(
                "cursor-pointer rounded-lg px-2.5 py-1 text-[12.5px] font-medium tracking-tight",
                filters.status === opt.value
                  ? "bg-panel font-semibold text-foreground shadow-sm"
                  : "text-muted-fg hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search logs"
          placeholder="Search tool name, summary or error…"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          className="min-w-[180px] flex-1 rounded-[9px] border border-border bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        />
      </div>

      <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
        <div className="grid grid-cols-[80px_14px_minmax(0,1fr)_60px_14px] gap-2.5 border-b border-border-soft bg-panel-2 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint sm:grid-cols-[92px_14px_104px_96px_minmax(0,1fr)_64px_14px]">
          <div>Time</div>
          <div />
          <div className="hidden sm:block">Agent</div>
          <div className="hidden sm:block">Server</div>
          <div>Request</div>
          <div className="text-right">Took</div>
          <div />
        </div>

        {isLoading ? (
          <div className="px-4 py-10 text-center text-xs text-faint">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-faint">
            {filtered
              ? "No requests match these filters."
              : "No requests recorded yet — connect an agent and call a tool."}
          </div>
        ) : (
          rows.map((row, i) => (
            <div key={row.id}>
              {(i === 0 || formatDay(rows[i - 1].ts) !== formatDay(row.ts)) && (
                <div className="border-b border-border-soft bg-panel-2 px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                  {formatDay(row.ts)}
                </div>
              )}
              <LogRow row={row} />
            </div>
          ))
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-3 text-[11px] text-faint">
        <span>
          {rows.length >= LOGS_LIMIT
            ? `Showing the newest ${LOGS_LIMIT} requests — narrow the filters to see further back.`
            : `${rows.length} request${rows.length === 1 ? "" : "s"}`}
        </span>
        {data?.config && (
          <Badge>
            kept {data.config.retentionHours}h · payloads {data.config.capturePayloads ? "on" : "off"}
          </Badge>
        )}
      </div>
    </>
  );
}
