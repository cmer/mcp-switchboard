import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import type { AgentInfo, AuthMe, ServerInfo, ServerToolsInfo } from "./types";

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
