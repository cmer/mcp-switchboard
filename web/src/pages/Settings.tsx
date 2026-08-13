import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApiMutation, useAuthMe, useLogConfig } from "@/lib/hooks";
import type { LogConfig } from "@/lib/types";
import { PageBar } from "@/components/Layout";
import { Button, Field, Input, Switch } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

function ChangePasswordForm({ authDisabled }: { authDisabled: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const change = useApiMutation(
    () =>
      api("/api/auth/change-password", {
        method: "POST",
        json: authDisabled ? { newPassword } : { currentPassword, newPassword },
      }),
    ["auth"],
    () => {
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed — other browsers were logged out");
    },
  );

  return (
    <div className="mt-4 flex max-w-sm flex-col gap-3 border-t border-border-soft pt-4">
      <h3 className="text-sm font-semibold">Change password</h3>
      {!authDisabled && (
        <Field label="Current password">
          <Input
            type="password"
            className="font-sans"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
      )}
      <Field label="New password" hint="at least 4 characters">
        <Input
          type="password"
          className="font-sans"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Field>
      <div>
        <Button
          variant="primary"
          disabled={change.isPending || newPassword.length < 4 || (!authDisabled && !currentPassword)}
          onClick={() => change.mutate(undefined)}
        >
          Change password
        </Button>
      </div>
    </div>
  );
}

function InstanceNameForm({ current }: { current: string | null }) {
  const [name, setName] = useState(current ?? "");
  const save = useApiMutation(
    () => api("/api/auth/settings", { method: "POST", json: { instanceName: name.trim() || null } }),
    ["auth"],
    () => toast.success("Saved"),
  );
  return (
    <div className="flex max-w-sm items-end gap-2">
      <div className="flex-1">
        <Field label="Instance name" hint="shown under the logo — leave blank to hide">
          <Input className="font-sans" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. homelab, office" />
        </Field>
      </div>
      <Button variant="primary" disabled={save.isPending || (current ?? "") === name.trim()} onClick={() => save.mutate(undefined)}>
        Save
      </Button>
    </div>
  );
}

function LogSettingsForm() {
  const { data: config } = useLogConfig();
  const [hours, setHours] = useState<string | null>(null);
  const [maxKb, setMaxKb] = useState<string | null>(null);

  const save = useApiMutation(
    (patch: Partial<LogConfig>) => api("/api/logs/settings", { method: "PUT", json: patch }),
    ["log-config", "logs"],
    () => toast.success("Saved"),
  );

  if (!config) return null;
  const hoursValue = hours ?? String(config.retentionHours);
  const maxKbValue = maxKb ?? String(config.maxPayloadKb);
  const dirty = Number(hoursValue) !== config.retentionHours || Number(maxKbValue) !== config.maxPayloadKb;

  return (
    <>
      <div className="flex items-center gap-3">
        <Switch
          checked={config.capturePayloads}
          onChange={(capturePayloads) => save.mutate({ capturePayloads })}
          label="Record request and response payloads"
        />
        <div>
          <div className="text-[13px] font-medium">Record request and response payloads</div>
          <div className="text-xs text-faint">
            {config.capturePayloads
              ? "Full JSON-RPC frames are stored, so tool arguments and results — including any secrets an agent passes through — sit in the database unredacted."
              : "Only metadata is stored: who called what, when, how long it took, and how big the frames were."}
          </div>
        </div>
      </div>

      <div className="mt-4 flex max-w-lg flex-wrap items-end gap-2 border-t border-border-soft pt-4">
        <div className="w-32">
          <Field label="Keep for" hint="hours">
            <Input
              type="number"
              min={1}
              max={8760}
              value={hoursValue}
              onChange={(e) => setHours(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Payload cap" hint="KB">
            <Input type="number" min={1} max={1024} value={maxKbValue} onChange={(e) => setMaxKb(e.target.value)} />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={save.isPending || !dirty}
          onClick={() => {
            save.mutate({ retentionHours: Number(hoursValue), maxPayloadKb: Number(maxKbValue) });
            setHours(null);
            setMaxKb(null);
          }}
        >
          Save
        </Button>
      </div>
      <p className="mt-2 text-xs text-faint">
        Older requests are deleted automatically; shortening the window prunes them right away. Frames larger than the
        cap are clipped, but their true size is still recorded.
      </p>
    </>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: auth } = useAuthMe();
  const authDisabled = auth?.authDisabled ?? false;

  const setAuthDisabled = useApiMutation(
    (disabled: boolean) => api("/api/auth/settings", { method: "POST", json: { authDisabled: disabled } }),
    ["auth"],
    () => toast.success("Saved"),
  );
  const setAutoEnable = useApiMutation(
    (on: boolean) => api("/api/auth/settings", { method: "POST", json: { autoEnableNewServers: on } }),
    ["auth"],
    () => toast.success("Saved"),
  );
  const setAllowRequests = useApiMutation(
    (on: boolean) => api("/api/auth/settings", { method: "POST", json: { allowServerRequests: on } }),
    ["auth"],
    () => toast.success("Saved"),
  );

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["auth"] });
  };

  return (
    <>
      <PageBar title="Settings" />

      <div className="rounded-[14px] border border-border bg-panel px-4 py-4">
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">General</h2>
        <InstanceNameForm key={auth?.instanceName ?? ""} current={auth?.instanceName ?? null} />
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-soft pt-4">
          <div>
            <div className="text-[13px] font-medium">Appearance</div>
            <div className="text-xs text-faint">System follows your OS light/dark setting.</div>
          </div>
          <ThemeToggle />
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-border-soft pt-4">
          <Switch
            checked={auth?.autoEnableNewServers ?? false}
            onChange={(v) => setAutoEnable.mutate(v)}
            label="Enable new servers for all agents"
          />
          <div>
            <div className="text-[13px] font-medium">Enable new servers for all agents</div>
            <div className="text-xs text-faint">
              When on, a newly added server is switched on for every agent automatically. When off, servers start
              disabled and you opt them in per agent.
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-border-soft pt-4">
          <Switch
            checked={auth?.allowServerRequests ?? true}
            onChange={(v) => setAllowRequests.mutate(v)}
            label="Allow agents to request servers"
          />
          <div>
            <div className="text-[13px] font-medium">Allow agents to request servers</div>
            <div className="text-xs text-faint">
              Adds a request tool to every agent so they can ask you for new MCP servers.
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-[14px] border border-border bg-panel px-4 py-4">
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Logs</h2>
        <LogSettingsForm />
      </div>

      <div className="mt-4 rounded-[14px] border border-border bg-panel px-4 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight">Security</h2>
        <div className="mt-3 flex items-center gap-3">
          <Switch
            checked={!authDisabled}
            onChange={(requireAuth) => {
              if (
                requireAuth ||
                confirm(
                  "Disable web UI authentication? Anyone who can reach this address gets full admin access. Only do this on a trusted network.",
                )
              ) {
                setAuthDisabled.mutate(!requireAuth);
              }
            }}
            label="Require password to access the web UI"
          />
          <div>
            <div className="text-[13px] font-medium">Require password to access the web UI</div>
            <div className="text-xs text-faint">
              {authDisabled
                ? "Auth is off — anyone who can reach this address has full admin access. Trusted networks only."
                : "You stay logged in for 365 days per browser; agents always use their own bearer tokens."}
            </div>
          </div>
        </div>
        <ChangePasswordForm authDisabled={authDisabled} />
      </div>

      {!authDisabled && (
        <div className="mt-4 rounded-[14px] border border-border bg-panel px-4 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight">Session</h2>
          <p className="mt-1 mb-3 text-xs text-faint">You're logged in as the switchboard admin on this browser.</p>
          <Button onClick={() => void logout()}>Log out</Button>
        </div>
      )}

      <div className="mt-4 rounded-[14px] border border-border bg-panel px-4 py-4 text-xs leading-relaxed text-muted-fg">
        <h2 className="mb-1 text-[15px] font-semibold tracking-tight text-foreground">About</h2>
        <p>
          MCP Switchboard v{__APP_VERSION__} · data lives in <code className="font-mono">data/</code> next to the server (SQLite + encryption
          key). Backup = copy that directory. Set <code className="font-mono">PUBLIC_URL</code> if you access the switchboard via a
          LAN hostname so OAuth redirects come back to the right place.
        </p>
      </div>
    </>
  );
}
