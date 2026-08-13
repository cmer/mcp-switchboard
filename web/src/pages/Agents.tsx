import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAgents, useApiMutation, useAuthMe, useServers } from "@/lib/hooks";
import type { AgentInfo, AgentRole, ServerInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBar } from "@/components/Layout";
import { StatusDot, statusInfo } from "@/components/StatusDot";
import { Badge, Button, CopyButton, Dialog, Field, Input, Switch, Tabs } from "@/components/ui";

/**
 * The endpoint usually lives on the origin the UI is served from, but MCP_PORT can move it to its
 * own port (or a separate public hostname), in which case the server tells us where.
 */
function useEndpointUrl(): (slug: string) => string {
  const { data } = useAuthMe();
  const base = data?.mcpBaseUrl || window.location.origin;
  return (slug) => `${base}/mcp/${slug}`;
}

/* ---------- connect dialog ---------- */

function ConnectDialog({ agent, open, onClose }: { agent: AgentInfo; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"claude" | "codex" | "ohmypi" | "json">("claude");
  const url = useEndpointUrl()(agent.slug);

  const snippets: Record<typeof tab, { caption: string; text: string }> = {
    claude: {
      caption: "One-liner",
      text: `claude mcp add switchboard --transport http \\\n  ${url} \\\n  --header "Authorization: Bearer ${agent.token}"`,
    },
    codex: {
      caption: "config.toml",
      text: `[mcp_servers.switchboard]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${agent.token}" }`,
    },
    ohmypi: {
      caption: "Slash command",
      text: `/mcp add switchboard --scope user \\\n  --url ${url} --transport http \\\n  --token ${agent.token}`,
    },
    json: {
      caption: ".mcp.json",
      text: `{\n  "mcpServers": {\n    "switchboard": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${agent.token}" }\n    }\n  }\n}`,
    },
  };
  const current = snippets[tab];

  return (
    <Dialog open={open} onClose={onClose} title={`Connect ${agent.name}`} description="Each form registers the switchboard as a single MCP server." wide>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "claude", label: "Claude Code" },
          { value: "codex", label: "Codex" },
          { value: "ohmypi", label: "Oh My Pi" },
          { value: "json", label: "Raw JSON" },
        ]}
      />
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-fg">{current.caption}</span>
          <CopyButton text={current.text} />
        </div>
        <pre className="overflow-x-auto rounded-[10px] border border-border-soft bg-code-bg px-3.5 py-3 font-mono text-xs leading-relaxed">
          {current.text}
        </pre>
        <p className="mt-3 text-xs text-faint">
          Tools arrive namespaced: <code className="font-mono">github__create_issue</code>,{" "}
          <code className="font-mono">postgres__query</code>, …
        </p>
      </div>
    </Dialog>
  );
}

/* ---------- agent card ---------- */

function AgentCard({ agent, servers }: { agent: AgentInfo; servers: ServerInfo[] }) {
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const endpoint = useEndpointUrl()(agent.slug);

  const enabledCount = agent.servers.filter((s) => s.enabled).length;
  const toolCount = useMemo(() => {
    const enabledIds = new Set(agent.servers.filter((s) => s.enabled).map((s) => s.serverId));
    return servers.filter((s) => enabledIds.has(s.id) && s.state === "connected").reduce((sum, s) => sum + s.toolCount, 0);
  }, [agent.servers, servers]);

  const setMatrix = useApiMutation(
    ({ serverId, enabled }: { serverId: number; enabled: boolean }) =>
      api(`/api/agents/${agent.id}/servers/${serverId}`, { method: "PUT", json: { enabled } }),
    ["agents"],
  );
  const rotate = useApiMutation(
    () => api(`/api/agents/${agent.id}/token/rotate`, { method: "POST" }),
    ["agents"],
    () => toast.success("Token rotated — the old token no longer works"),
  );
  const del = useApiMutation(
    () => api(`/api/agents/${agent.id}`, { method: "DELETE" }),
    ["agents"],
    () => toast.success("Agent deleted"),
  );
  const setRole = useApiMutation(
    (role: AgentRole) => api(`/api/agents/${agent.id}`, { method: "PATCH", json: { role } }),
    ["agents"],
    () => toast.success("Role updated — live sessions pick it up on their next tools/list"),
  );
  const isManager = agent.role === "manager";

  const initials = agent.name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
  const masked = `${agent.token.slice(0, 6)}••••••••${agent.token.slice(-4)}`;

  return (
    <div className="mb-3.5 overflow-hidden rounded-[14px] border border-border bg-panel">
      <button className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left" onClick={() => setExpanded((e) => !e)}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-[12.5px] font-semibold text-primary">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold tracking-tight">{agent.name}</span>
          <span className="block truncate text-xs text-faint">
            {enabledCount} of {servers.length} servers · {toolCount} tools exposed
          </span>
        </span>
        {isManager && (
          <Badge className="border-transparent bg-warn-bg font-semibold text-warn" title="Can register remote servers and edit every agent's server assignments over MCP">
            manager
          </Badge>
        )}
        {agent.sessions > 0 ? (
          <Badge className="border-transparent bg-ok-bg font-semibold text-ok">connected</Badge>
        ) : (
          <Badge>idle</Badge>
        )}
        {expanded ? <ChevronUp size={14} className="text-faint" /> : <ChevronDown size={14} className="text-faint" />}
      </button>

      {expanded && (
        <div className="border-t border-border-soft px-4 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="w-[72px] shrink-0 text-xs font-semibold text-muted-fg">Endpoint</span>
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border-soft bg-code-bg px-2.5 py-1.5 font-mono text-xs">
              {endpoint}
            </code>
            <CopyButton text={endpoint} />
          </div>
          <div className="mb-2 flex items-center gap-2">
            <span className="w-[72px] shrink-0 text-xs font-semibold text-muted-fg">Token</span>
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border-soft bg-code-bg px-2.5 py-1.5 font-mono text-xs">
              {revealed ? agent.token : masked}
            </code>
            <Button size="sm" onClick={() => setRevealed((r) => !r)}>
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <CopyButton text={agent.token} />
          </div>
          <div className="mb-4 flex items-center gap-1.5 pl-[80px]">
            <Button size="sm" variant="ghost" onClick={() => setConnectOpen(true)}>
              Connection instructions →
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (confirm("Rotate this agent's token? The old token stops working immediately.")) rotate.mutate(undefined);
              }}
            >
              Rotate token
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-err"
              onClick={() => {
                if (confirm(`Delete agent "${agent.name}"?`)) del.mutate(undefined);
              }}
            >
              Delete
            </Button>
          </div>

          <div
            className={cn(
              "mb-4 flex items-start gap-3 rounded-[10px] border px-3 py-2.5",
              isManager ? "border-warn/40 bg-warn-bg" : "border-border-soft bg-panel-2/40",
            )}
          >
            <Switch
              checked={isManager}
              onChange={(v) => setRole.mutate(v ? "manager" : "standard")}
              label={`Manager role for ${agent.name}`}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium">Manager</div>
              <div className="text-xs leading-relaxed text-faint">
                Manager agents can register remote MCP servers and change every agent's server assignments via MCP
                tools. stdio servers still require your approval. Grant this only to agents you drive directly.
              </div>
            </div>
          </div>

          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-xs font-semibold">Servers for this agent</span>
            <span className="text-[11px] text-faint">changes apply live</span>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-border-soft">
            {servers.length === 0 ? (
              <p className="px-3 py-3 text-xs text-faint">No servers configured yet — add one on the Servers page.</p>
            ) : (
              servers.map((server) => {
                const entry = agent.servers.find((s) => s.serverId === server.id);
                const enabled = entry?.enabled ?? false;
                const status = statusInfo(server);
                return (
                  <div key={server.id} className="flex items-center gap-2.5 border-b border-border-soft bg-panel px-3 py-2 last:border-0">
                    <StatusDot tone={status.tone} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{server.slug}</span>
                    <span className="font-mono text-[11px] tabular-nums text-muted-fg">
                      {!server.enabled ? "off globally" : server.state === "connected" ? `${server.toolCount} tools` : "—"}
                    </span>
                    <Switch
                      checked={enabled}
                      disabled={!server.enabled}
                      onChange={(v) => setMatrix.mutate({ serverId: server.id, enabled: v })}
                      label={`${server.slug} for ${agent.name}`}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
      <ConnectDialog agent={agent} open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}

/* ---------- page ---------- */

export function AgentsPage() {
  const { data: agents, isLoading } = useAgents();
  const { data: servers } = useServers();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");

  const create = useApiMutation(
    () => api<AgentInfo>("/api/agents", { method: "POST", json: { name } }),
    ["agents"],
    () => {
      setDialogOpen(false);
      setName("");
      toast.success("Agent created — enable some servers for it below");
    },
  );

  const connectedCount = (agents ?? []).filter((a) => a.sessions > 0).length;

  return (
    <>
      <PageBar
        title="Agents"
        sub={agents ? `${agents.length} agents · ${connectedCount} connected now` : undefined}
        action={
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            <Plus size={14} /> Add agent
          </Button>
        }
      />
      {isLoading ? (
        <p className="py-8 text-center text-sm text-faint">Loading…</p>
      ) : (agents ?? []).length === 0 ? (
        <div className="rounded-[14px] border border-border bg-panel px-4 py-10 text-center">
          <p className="text-sm font-medium">No agents yet</p>
          <p className="mt-1 text-xs text-faint">Create one per tool that should reach your MCP servers — Claude Code, Codex, …</p>
        </div>
      ) : (
        agents!.map((agent) => <AgentCard key={agent.id} agent={agent} servers={servers ?? []} />)
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Add agent" description="Each agent gets its own endpoint and bearer token.">
        <Field label="Name">
          <Input className="font-sans" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code" />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name || create.isPending} onClick={() => create.mutate(undefined)}>
            Create agent
          </Button>
        </div>
      </Dialog>
    </>
  );
}
