import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApiMutation, useServerLogs, useServers, useServerTools } from "@/lib/hooks";
import type { ServerInfo } from "@/lib/types";
import { PageBar } from "@/components/Layout";
import { StatusDot, statusInfo } from "@/components/StatusDot";
import { Badge, Button, Dialog, Field, Input, Select, Switch, Tabs, Textarea } from "@/components/ui";

/* ---------- add / edit dialog ---------- */

interface ImportPreviewEntry {
  name: string;
  slug: string;
  type: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  url: string | null;
  authType: string;
  envKeys: string[];
  slugTaken: boolean;
}

interface FormState {
  name: string;
  slug: string;
  description: string;
  kind: "stdio" | "remote" | "paste";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  remoteType: "http" | "sse";
  authType: "none" | "bearer" | "headers" | "oauth";
  bearerToken: string;
  headers: string;
}

const EMPTY: FormState = {
  name: "",
  slug: "",
  description: "",
  kind: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  remoteType: "http",
  authType: "oauth",
  bearerToken: "",
  headers: "",
};

function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function ServerDialog({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: ServerInfo | null;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<{ servers: ImportPreviewEntry[]; error: string | null }>({
    servers: [],
    error: null,
  });

  // debounced dry-run parse of pasted text
  useEffect(() => {
    if (form.kind !== "paste" || !pasteText.trim()) {
      setPreview({ servers: [], error: null });
      return;
    }
    const t = setTimeout(() => {
      api<{ servers: ImportPreviewEntry[] }>("/api/servers/import", { method: "POST", json: { text: pasteText, dryRun: true } })
        .then((res) => setPreview({ servers: res.servers, error: null }))
        .catch((err) => setPreview({ servers: [], error: err instanceof Error ? err.message : "Could not parse" }));
    }, 350);
    return () => clearTimeout(t);
  }, [form.kind, pasteText]);
  useEffect(() => {
    if (!open) return;
    if (!editing) {
      setForm(EMPTY);
      setPasteText("");
      return;
    }
    setForm({
      name: editing.name,
      slug: editing.slug,
      description: editing.description ?? "",
      kind: editing.type === "stdio" ? "stdio" : "remote",
      command: editing.command ?? "",
      args: editing.args.join("\n"),
      env: "",
      cwd: editing.cwd ?? "",
      url: editing.url ?? "",
      remoteType: editing.type === "sse" ? "sse" : "http",
      authType: editing.authType,
      bearerToken: "",
      headers: "",
    });
  }, [open, editing]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const doImport = useApiMutation(
    () =>
      api<{ created: ServerInfo[]; errors: { name: string; error: string }[] }>("/api/servers/import", {
        method: "POST",
        json: { text: pasteText },
      }),
    ["servers", "agents"],
    (res) => {
      onClose();
      setPasteText("");
      if (res.created.length > 0) {
        toast.success(`Added ${res.created.length} server${res.created.length === 1 ? "" : "s"}`);
      }
      for (const e of res.errors) toast.error(`${e.name}: ${e.error}`);
    },
  );

  const save = useApiMutation(
    async () => {
      const base = {
        name: form.name,
        ...(form.slug ? { slug: form.slug } : {}),
        description: form.description.trim() || null,
        type: form.kind === "stdio" ? ("stdio" as const) : form.remoteType,
      };
      const payload =
        form.kind === "stdio"
          ? {
              ...base,
              command: form.command,
              args: form.args.split("\n").map((s) => s.trim()).filter(Boolean),
              ...(form.env.trim() || !editing ? { env: parseKv(form.env) ?? (editing ? null : undefined) } : {}),
              cwd: form.cwd || null,
            }
          : {
              ...base,
              url: form.url,
              authType: form.authType,
              ...(form.authType === "bearer" && form.bearerToken ? { bearerToken: form.bearerToken } : {}),
              ...(form.authType === "headers" && form.headers.trim() ? { headers: parseKv(form.headers) } : {}),
            };
      return api<ServerInfo>(editing ? `/api/servers/${editing.id}` : "/api/servers", {
        method: editing ? "PATCH" : "POST",
        json: payload,
      });
    },
    ["servers"],
    (created) => {
      onClose();
      if (!editing && created.authType === "oauth") void startOAuth(created.id);
      else toast.success(editing ? "Server updated" : "Server added");
    },
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : "Add server"}
      description={
        form.kind === "stdio"
          ? "Runs on this machine, supervised by the switchboard."
          : form.kind === "remote"
            ? "Hosted elsewhere; the switchboard connects out."
            : "Paste a claude mcp add command or an mcpServers JSON block."
      }
      wide
    >
      <div className="mb-4">
        <Tabs
          value={form.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: "stdio", label: "Local (stdio)" },
            { value: "remote", label: "Remote" },
            ...(editing ? [] : [{ value: "paste" as const, label: "Paste" }]),
          ]}
        />
      </div>
      {form.kind === "paste" ? (
        <div className="flex flex-col gap-3">
          <Textarea
            rows={6}
            autoFocus
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`claude mcp add --transport http linear https://mcp.linear.app/mcp\n\n— or —\n\n{ "mcpServers": { "sequential-thinking": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"] } } }`}
          />
          {preview.error && pasteText.trim() && (
            <p className="rounded-[10px] bg-err-bg px-3 py-2 text-xs text-err">{preview.error}</p>
          )}
          {preview.servers.length > 0 && (
            <div className="overflow-hidden rounded-[10px] border border-border-soft">
              {preview.servers.map((p) => (
                <div key={p.slug} className="flex items-center gap-2.5 border-b border-border-soft bg-panel px-3 py-2 last:border-0">
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs font-semibold">{p.slug}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {p.type === "stdio" ? [p.command, ...p.args].join(" ") : p.url}
                      {p.envKeys.length > 0 && ` · env: ${p.envKeys.join(", ")}`}
                    </span>
                  </span>
                  <Badge>{p.type === "stdio" ? "Local · stdio" : `Remote · ${p.authType === "none" ? p.type.toUpperCase() : p.authType}`}</Badge>
                  {p.slugTaken && <Badge className="border-transparent bg-warn-bg font-semibold text-warn">slug taken</Badge>}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input className="font-sans" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="GitHub" />
          </Field>
          <Field label="Slug" hint="prefixes tool names">
            <Input
              value={form.slug}
              onChange={(e) => set({ slug: e.target.value })}
              placeholder={form.name ? form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "github"}
            />
          </Field>
        </div>
        <Field label="Description" hint="shown to agents — say which account/purpose this is">
          <Input
            className="font-sans"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Work Gmail — carl@company.com"
          />
        </Field>

        {form.kind === "stdio" ? (
          <>
            <Field label="Command">
              <Input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
            </Field>
            <Field label="Arguments" hint="one per line">
              <Textarea
                rows={3}
                value={form.args}
                onChange={(e) => set({ args: e.target.value })}
                placeholder={"-y @modelcontextprotocol/server-filesystem\n/home/carl"}
              />
            </Field>
            <Field
              label="Environment variables"
              hint={editing?.hasEnv ? `KEY=value per line — stored: ${editing.envKeys.join(", ")} (leave blank to keep)` : "KEY=value per line · encrypted at rest"}
            >
              <Textarea rows={2} value={form.env} onChange={(e) => set({ env: e.target.value })} placeholder="GITHUB_TOKEN=ghp_…" />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.linear.app/mcp" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Transport">
                <Select value={form.remoteType} onChange={(e) => set({ remoteType: e.target.value as "http" | "sse" })}>
                  <option value="http">Streamable HTTP</option>
                  <option value="sse">SSE (legacy)</option>
                </Select>
              </Field>
              <Field label="Authentication">
                <Select value={form.authType} onChange={(e) => set({ authType: e.target.value as FormState["authType"] })}>
                  <option value="oauth">OAuth</option>
                  <option value="bearer">Bearer token</option>
                  <option value="headers">Custom headers</option>
                  <option value="none">None</option>
                </Select>
              </Field>
            </div>
            {form.authType === "bearer" && (
              <Field label="Bearer token" hint={editing?.hasBearerToken ? "leave blank to keep the stored token" : "encrypted at rest"}>
                <Input type="password" value={form.bearerToken} onChange={(e) => set({ bearerToken: e.target.value })} />
              </Field>
            )}
            {form.authType === "headers" && (
              <Field
                label="Headers"
                hint={editing?.hasHeaders ? `Header=value per line — stored: ${editing.headerKeys.join(", ")} (blank keeps)` : "Header=value per line · encrypted"}
              >
                <Textarea rows={2} value={form.headers} onChange={(e) => set({ headers: e.target.value })} placeholder="X-Api-Key=…" />
              </Field>
            )}
            {form.authType === "oauth" && (
              <p className="rounded-[10px] bg-primary-soft px-3 py-2 text-xs leading-relaxed text-muted-fg">
                <b className="font-semibold text-foreground">You'll authorize in your browser after saving.</b> Tokens are stored
                encrypted and refreshed automatically in the background — agents never see them and auth never goes stale.
              </p>
            )}
          </>
        )}
      </div>
      )}
      <div className="mt-5 flex justify-end gap-2 border-t border-border-soft pt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {form.kind === "paste" ? (
          <Button
            variant="primary"
            disabled={doImport.isPending || preview.servers.length === 0 || preview.servers.every((p) => p.slugTaken)}
            onClick={() => doImport.mutate(undefined)}
          >
            {preview.servers.length > 1 ? `Add ${preview.servers.length} servers` : "Add server"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={save.isPending || !form.name || (form.kind === "stdio" ? !form.command : !form.url)}
            onClick={() => save.mutate(undefined)}
          >
            {editing ? "Save changes" : form.kind === "remote" && form.authType === "oauth" ? "Save & authorize" : "Add server"}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/* ---------- OAuth helper ---------- */

async function startOAuth(serverId: number): Promise<void> {
  try {
    const res = await api<{ authorized: boolean; authorizeUrl?: string }>(`/api/servers/${serverId}/oauth/start`, {
      method: "POST",
    });
    if (res.authorized) toast.success("Already authorized — tokens refreshed");
    else if (res.authorizeUrl) window.location.href = res.authorizeUrl;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Could not start authorization");
  }
}

/* ---------- expanded row details ---------- */

function ServerDetails({ server, onEdit }: { server: ServerInfo; onEdit: () => void }) {
  const [tab, setTab] = useState<"tools" | "logs">("tools");
  const tools = useServerTools(tab === "tools" ? server.id : null);
  const logs = useServerLogs(tab === "logs" ? server.id : null);

  const restart = useApiMutation(
    () => api(`/api/servers/${server.id}/restart`, { method: "POST" }),
    ["servers"],
    () => toast.success("Restarting…"),
  );
  const del = useApiMutation(
    () => api(`/api/servers/${server.id}`, { method: "DELETE" }),
    ["servers", "agents"],
    () => toast.success("Server deleted"),
  );

  return (
    <div className="border-t border-border-soft bg-panel-2/40 px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="w-56">
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "tools", label: `Tools (${server.toolCount})` },
              { value: "logs", label: "Logs" },
            ]}
          />
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" onClick={() => restart.mutate(undefined)}>
            Restart
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (confirm(`Delete server "${server.name}"? Agents will lose its tools immediately.`)) del.mutate(undefined);
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {tab === "tools" ? (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-border-soft bg-panel">
          {(tools.data?.tools ?? []).length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-faint">No tools discovered{server.state !== "connected" ? " — server is not connected" : ""}.</p>
          ) : (
            tools.data!.tools.map((t) => (
              <div key={t.name} className="border-b border-border-soft px-3 py-2 last:border-0">
                <code className="font-mono text-xs font-semibold">{t.namespacedName}</code>
                {t.description && <p className="mt-0.5 line-clamp-2 text-xs text-faint">{t.description}</p>}
              </div>
            ))
          )}
        </div>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-lg border border-border-soft bg-code-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-fg">
          {(logs.data?.lines ?? []).join("\n") || "No stderr output."}
        </pre>
      )}
    </div>
  );
}

/* ---------- row ---------- */

function ServerRow({ server, onEdit }: { server: ServerInfo; onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const status = statusInfo(server);

  const toggle = useApiMutation(
    (enabled: boolean) => api(`/api/servers/${server.id}`, { method: "PATCH", json: { enabled } }),
    ["servers"],
  );

  const transportLabel =
    server.type === "stdio" ? "Local · stdio" : `Remote · ${server.authType === "oauth" ? "OAuth" : server.type === "sse" ? "SSE" : "HTTP"}`;

  const subline = (() => {
    if (!server.enabled) return "Off · not offered to any agent";
    if (status.text === "Needs auth") return "Authorization required or expired";
    if (server.state === "backoff") return server.lastError ?? "Connection failed";
    if (server.authType === "oauth" && server.tokenExpiresAt) {
      const min = Math.max(0, Math.round((server.tokenExpiresAt - Date.now()) / 60000));
      return `Token expires in ${min} min · auto-refreshes in background`;
    }
    return server.lastError ?? `${server.toolCount} tools available`;
  })();

  return (
    <div className={!server.enabled ? "opacity-70" : undefined}>
      <div className="flex items-center gap-3.5 px-4 py-3">
        <StatusDot tone={status.tone} />
        <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setExpanded((e) => !e)}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-semibold">{server.slug}</span>
            {expanded ? <ChevronUp size={13} className="text-faint" /> : <ChevronDown size={13} className="text-faint" />}
          </div>
          <div className="truncate text-xs text-faint">
            <span
              className={
                status.tone === "ok"
                  ? "font-medium text-ok"
                  : status.tone === "warn"
                    ? "font-medium text-warn"
                    : status.tone === "err"
                      ? "font-medium text-err"
                      : undefined
              }
            >
              {status.text}
            </span>
            {" · "}
            {subline}
          </div>
        </button>
        <Badge className="hidden md:inline-flex">{transportLabel}</Badge>
        {server.enabled && status.text === "Needs auth" ? (
          <Button size="sm" onClick={() => void startOAuth(server.id)}>
            Authorize
          </Button>
        ) : (
          <span className="min-w-[52px] text-right font-mono text-xs tabular-nums text-muted-fg">
            {server.enabled && server.state === "connected" ? `${server.toolCount} tools` : "—"}
          </span>
        )}
        <Switch checked={server.enabled} onChange={(v) => toggle.mutate(v)} label={`Enable ${server.name}`} />
      </div>
      {expanded && <ServerDetails server={server} onEdit={onEdit} />}
    </div>
  );
}

/* ---------- page ---------- */

export function ServersPage() {
  const { data: servers, isLoading } = useServers();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServerInfo | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const auth = searchParams.get("auth");
    if (!auth) return;
    if (auth === "ok") toast.success("Authorization complete");
    else toast.error(`Authorization failed: ${searchParams.get("reason") ?? "unknown error"}`);
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const healthy = useMemo(
    () => (servers ?? []).filter((s) => s.enabled && s.state === "connected").length,
    [servers],
  );

  return (
    <>
      <PageBar
        title="Servers"
        sub={servers ? `${servers.length} configured · ${healthy} healthy` : undefined}
        action={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus size={14} /> Add server
          </Button>
        }
      />
      <div className="divide-y divide-border-soft rounded-[14px] border border-border bg-panel">
        {isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-faint">Loading…</p>
        ) : (servers ?? []).length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">No servers yet</p>
            <p className="mt-1 text-xs text-faint">Add your first MCP server — local command or remote URL.</p>
          </div>
        ) : (
          servers!.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onEdit={() => {
                setEditing(s);
                setDialogOpen(true);
              }}
            />
          ))
        )}
      </div>
      <ServerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} editing={editing} />
    </>
  );
}
