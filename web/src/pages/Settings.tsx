import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useApiMutation, useAuthMe, useLogConfig } from "@/lib/hooks";
import type { LoginMode, LogConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBar } from "@/components/Layout";
import { Button, Field, Input, Switch, Tabs, Textarea } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const change = useApiMutation(
    () =>
      api("/api/auth/change-password", {
        method: "POST",
        json: { currentPassword, newPassword },
      }),
    ["auth"],
    () => {
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed — other browsers were logged out");
    },
  );

  return (
    <div className="flex max-w-sm flex-col gap-3">
      <Field label="Current password">
        <Input
          type="password"
          className="font-sans"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </Field>
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
          disabled={change.isPending || newPassword.length < 4 || !currentPassword}
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

/** Whether my own requests and responses are stored: mine to decide, since the log rows are mine. */
function PayloadCaptureToggle() {
  const { data: config } = useLogConfig();
  const save = useApiMutation(
    (capturePayloads: boolean) => api("/api/logs/settings", { method: "PUT", json: { capturePayloads } }),
    ["log-config", "logs", "auth"],
    () => toast.success("Saved"),
  );
  if (!config) return null;
  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={config.capturePayloads}
        onChange={(capturePayloads) => save.mutate(capturePayloads)}
        label="Record request and response payloads"
      />
      <div>
        <div className="text-[13px] font-medium">Record request and response payloads</div>
        <div className="text-xs text-faint">
          {config.capturePayloads
            ? "Full JSON-RPC frames from your agents are stored, so tool arguments and results — including any secrets an agent passes through — sit in the database unredacted."
            : "Only metadata is stored: who called what, when, how long it took, and how big the frames were."}
        </div>
      </div>
    </div>
  );
}

/** Retention and the payload cap apply to everyone's logs, so they are the Admin's. */
function RetentionForm() {
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
      <div className="flex max-w-lg flex-wrap items-end gap-2">
        <div className="w-32">
          <Field label="Keep for" hint="hours">
            <Input type="number" min={1} max={8760} value={hoursValue} onChange={(e) => setHours(e.target.value)} />
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
        Applies to every user's logs. Older requests are deleted automatically; shortening the window prunes them right away.
        Frames larger than the cap are clipped, but their true size is still recorded.
      </p>
    </>
  );
}

/** Password, or Cloudflare Access in front of the whole UI. Switching to Access has to be done from behind Access. */
function LoginModeForm({ mode, teamDomain, audTags, adminEmail }: { mode: LoginMode; teamDomain: string; audTags: string[]; adminEmail: string | null }) {
  const [picked, setPicked] = useState<LoginMode>(mode);
  const [domain, setDomain] = useState(teamDomain);
  const [tags, setTags] = useState(audTags.join("\n"));

  const save = useApiMutation(
    () =>
      api("/api/auth/settings", {
        method: "POST",
        json:
          picked === "cloudflare"
            ? {
                loginMode: "cloudflare",
                accessTeamDomain: domain.trim(),
                accessAudTags: tags
                  .split(/[\s,]+/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              }
            : { loginMode: "password" },
      }),
    ["auth"],
    () => toast.success(picked === "cloudflare" ? "Cloudflare Access is on" : "Back to password sign-in"),
  );

  const tagList = tags.split(/[\s,]+/).filter(Boolean);
  const changed = picked !== mode || (picked === "cloudflare" && (domain.trim() !== teamDomain || tagList.join() !== audTags.join()));
  const ready = picked === "password" || (domain.trim() !== "" && tagList.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-xs">
        <Tabs
          value={picked}
          onChange={(v) => {
            setPicked(v);
            save.reset();
          }}
          options={[
            { value: "password", label: "Password" },
            { value: "cloudflare", label: "Cloudflare Access" },
          ]}
        />
      </div>
      {picked === "cloudflare" ? (
        <>
          <p className="text-xs leading-relaxed text-muted-fg">
            Cloudflare Access signs everyone in, and a user's email decides which switchboard user they are. Password login is
            off while this is on. Open the switchboard through its Access-protected address to save these settings:
            they are only accepted from a request that carries a valid Access token for your own email
            {adminEmail ? <> (<span className="font-mono">{adminEmail}</span>)</> : ", which isn't set yet. Add it on the Users page first"}.
          </p>
          <div className="grid max-w-lg gap-3 sm:grid-cols-2">
            <Field label="Team domain" hint="from Zero Trust settings">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="myteam.cloudflareaccess.com" spellCheck={false} />
            </Field>
            <Field label="Application AUD tag" hint="one per line">
              <Textarea rows={2} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="32-character tag" spellCheck={false} />
            </Field>
          </div>
          <p className="rounded-[10px] bg-warn-bg px-3 py-2 text-xs leading-relaxed text-muted-fg">
            <b className="font-semibold text-foreground">In Access mode, don't expose the admin port on your LAN.</b> Anything
            that reaches the port directly skips Access.
          </p>
        </>
      ) : (
        mode === "cloudflare" && (
          <p className="text-xs leading-relaxed text-muted-fg">
            Users sign in with a username and password again. Anyone who never chose a password needs a setup code from the Users
            page.
          </p>
        )
      )}
      {save.isError && (
        <p role="alert" className="rounded-[10px] bg-err-bg px-3 py-2 text-xs leading-relaxed text-err">
          {save.error instanceof Error ? save.error.message : "Could not save"}
        </p>
      )}
      {(picked === "cloudflare" || mode === "cloudflare") && (
        <div>
          <Button variant="primary" disabled={save.isPending || !changed || !ready} onClick={() => save.mutate(undefined)}>
            {picked === "cloudflare" ? (mode === "cloudflare" ? "Save Access settings" : "Switch to Cloudflare Access") : "Switch to password sign-in"}
          </Button>
        </div>
      )}
    </div>
  );
}

function SectionHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mt-6 mb-2.5 first:mt-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h2>
      <p className="text-xs text-faint">{sub}</p>
    </div>
  );
}

const CARD = "rounded-[14px] border border-border bg-panel px-4 py-4";

export function SettingsPage() {
  const { data: auth } = useAuthMe();
  const isAdmin = auth?.user?.role === "admin";
  const accessMode = auth?.loginMode === "cloudflare";

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

  return (
    <>
      <PageBar title="Settings" />

      <SectionHeading title="Yours" sub={`For ${auth?.user?.username ?? "you"}: your servers, agents and logs. Nobody else is affected.`} />
      <div className={CARD}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Preferences</h2>
        <div className="flex items-center justify-between gap-3">
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
            label="Enable new servers for all my agents"
          />
          <div>
            <div className="text-[13px] font-medium">Enable new servers for all my agents</div>
            <div className="text-xs text-faint">
              When on, a server you add (or accept from someone) is switched on for every one of your agents automatically.
              When off, servers start disabled and you opt them in per agent.
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
              Adds a request tool to each of your agents so they can ask you for new MCP servers.
            </div>
          </div>
        </div>
      </div>

      <div className={cn(CARD, "mt-4")}>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Logs</h2>
        <PayloadCaptureToggle />
      </div>

      {!accessMode && (
        <div className={cn(CARD, "mt-4")}>
          <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Change password</h2>
          <ChangePasswordForm />
        </div>
      )}

      {isAdmin && (
        <>
          <SectionHeading title="Instance" sub="Admin only. These apply to everyone on this switchboard." />
          <div className={CARD}>
            <h2 className="mb-3 text-[15px] font-semibold tracking-tight">General</h2>
            <InstanceNameForm key={auth?.instanceName ?? ""} current={auth?.instanceName ?? null} />
          </div>

          <div className={cn(CARD, "mt-4")}>
            <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Logs</h2>
            <RetentionForm />
          </div>

          <div className={cn(CARD, "mt-4")}>
            <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Sign-in</h2>
            <LoginModeForm
              // Remount when the server's saved values change, so the form never shows stale drafts.
              key={`${auth?.loginMode}|${auth?.access?.teamDomain}|${auth?.access?.audTags?.join()}`}
              mode={auth?.loginMode ?? "password"}
              teamDomain={auth?.access?.teamDomain ?? ""}
              audTags={auth?.access?.audTags ?? []}
              adminEmail={auth?.user?.email ?? null}
            />
          </div>
        </>
      )}

      <div className={cn(CARD, "mt-6 text-xs leading-relaxed text-muted-fg")}>
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
