import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import type {
  AgentInfo,
  AuthMe,
  LogConfig,
  LogDetail,
  LogEvent,
  LogFilters,
  LogStats,
  LogSummary,
  ServerInfo,
  ServerToolsInfo,
} from "./types";

const POLL_MS = 4000;

export function useAuthMe() {
  return useQuery({ queryKey: ["auth"], queryFn: () => api<AuthMe>("/api/auth/me") });
}

export function useServers(enabled = true) {
  return useQuery({
    queryKey: ["servers"],
    queryFn: () => api<ServerInfo[]>("/api/servers"),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useAgents(enabled = true) {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentInfo[]>("/api/agents"),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useServerTools(serverId: number | null) {
  return useQuery({
    queryKey: ["server-tools", serverId],
    queryFn: () => api<ServerToolsInfo>(`/api/servers/${serverId}/tools`),
    enabled: serverId !== null,
  });
}

export function useServerLogs(serverId: number | null) {
  return useQuery({
    queryKey: ["server-logs", serverId],
    queryFn: () => api<{ lines: string[] }>(`/api/servers/${serverId}/logs`),
    enabled: serverId !== null,
    refetchInterval: 2000,
  });
}

/* ---------- request logs ---------- */

/** Matches the server's `?status=slow` threshold. */
export const SLOW_MS = 1000;
/** Newest N rows held in the list; the server applies the same cap. */
export const LOGS_LIMIT = 300;

interface LogsPage {
  rows: LogSummary[];
  config: LogConfig;
}

function logsQuery(filters: LogFilters): string {
  const params = new URLSearchParams({ limit: String(LOGS_LIMIT) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}

/** Client-side twin of the server's WHERE clause, for rows arriving over the live stream. */
export function matchesFilters(row: LogSummary, f: LogFilters): boolean {
  if (f.agent && row.agentSlug !== f.agent) return false;
  // Rows with no server span every server, so they survive any server filter.
  if (f.server && row.serverSlug !== null && row.serverSlug !== f.server) return false;
  if (f.method && row.method !== f.method) return false;
  if (f.status === "slow" && !(row.durationMs !== null && row.durationMs > SLOW_MS)) return false;
  if ((f.status === "error" || f.status === "pending") && row.status !== f.status) return false;
  if (f.q) {
    const haystack = [row.target, row.method, row.summary, row.errorMessage, row.agentSlug]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function applyEvent(page: LogsPage, event: LogEvent, filters: LogFilters): LogsPage {
  const known = page.rows.findIndex((r) => r.id === event.row.id);
  const keep = matchesFilters(event.row, filters);
  if (known >= 0) {
    const rows = page.rows.slice();
    if (keep) rows[known] = event.row;
    else rows.splice(known, 1);
    return { ...page, rows };
  }
  // An update can pull a row *into* view (a pending request that just failed, say).
  if (!keep) return page;
  return { ...page, rows: [event.row, ...page.rows].sort((a, b) => b.id - a.id).slice(0, LOGS_LIMIT) };
}

/**
 * The log list, tailed live. SSE is preferred; if the stream never establishes —
 * some reverse proxies buffer or drop `text/event-stream` — we fall back to polling.
 */
export function useLogs(filters: LogFilters, live: boolean) {
  const qc = useQueryClient();
  const [transport, setTransport] = useState<"sse" | "poll">("sse");

  const queryKey = ["logs", filters];
  const query = useQuery({
    queryKey,
    queryFn: () => api<LogsPage>(`/api/logs?${logsQuery(filters)}`),
    refetchInterval: live && transport === "poll" ? 3000 : false,
  });

  // Kept in refs so changing a filter (or typing in search) doesn't drop the stream.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;

  useEffect(() => {
    if (live) setTransport("sse");
  }, [live]);

  useEffect(() => {
    if (!live || transport !== "sse") return;
    const source = new EventSource("/api/logs/stream");
    let failures = 0;

    source.onopen = () => {
      failures = 0;
    };
    source.onmessage = (ev) => {
      let event: LogEvent;
      try {
        event = JSON.parse(ev.data) as LogEvent;
      } catch {
        return;
      }
      qc.setQueryData<LogsPage>(keyRef.current, (page) =>
        page ? applyEvent(page, event, filtersRef.current) : page,
      );
    };
    source.onerror = () => {
      // EventSource reconnects on its own; two failures in a row means the
      // stream isn't getting through at all.
      failures += 1;
      if (failures >= 2) {
        source.close();
        setTransport("poll");
      }
    };

    return () => source.close();
  }, [live, transport, qc]);

  return { ...query, transport: live ? transport : ("off" as const) };
}

export function useLogDetail(id: number | null) {
  return useQuery({
    queryKey: ["log", id],
    queryFn: () => api<LogDetail>(`/api/logs/${id}`),
    enabled: id !== null,
  });
}

export function useLogStats(live: boolean) {
  return useQuery({
    queryKey: ["log-stats"],
    queryFn: () => api<LogStats>("/api/logs/stats"),
    refetchInterval: live ? 15000 : false,
  });
}

export function useLogConfig() {
  return useQuery({ queryKey: ["log-config"], queryFn: () => api<LogConfig>("/api/logs/settings") });
}

/** Generic mutation that invalidates queries and toasts errors. */
export function useApiMutation<TArgs, TResult = unknown>(
  fn: (args: TArgs) => Promise<TResult>,
  invalidate: string[],
  onSuccess?: (result: TResult) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: [key] });
      onSuccess?.(result);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Request failed"),
  });
}
