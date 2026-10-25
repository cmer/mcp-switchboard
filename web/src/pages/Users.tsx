import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApiMutation, useAuthMe, useUsers } from "@/lib/hooks";
import type { SetupCode, UserInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBar } from "@/components/Layout";
import { Badge, Button, CopyButton, Dialog, Field, Input, Switch } from "@/components/ui";

/* ---------- setup code ---------- */

/** Shown once: the code is stored as a hash, so closing this dialog loses it (Reset password makes a new one). */
function SetupCodeDialog({ shown, onClose }: { shown: { username: string; code: SetupCode; reset: boolean } | null; onClose: () => void }) {
  if (!shown) return null;
  const expires = new Date(shown.code.expiresAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={shown.reset ? `Password reset for ${shown.username}` : `${shown.username} created`}
      description="Give them this setup code. It is shown only now."
    >
      <div className="flex items-center gap-3 rounded-[10px] border border-border-soft bg-code-bg px-3.5 py-3">
        <code className="min-w-0 flex-1 select-all font-mono text-lg font-semibold tracking-[0.14em]">{shown.code.code}</code>
        <CopyButton text={shown.code.code} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-fg">
        Single use, and it expires {expires}. {shown.username} opens{" "}
        <code className="font-mono">{window.location.origin}</code>, picks <b className="font-semibold">I have a setup code</b>,
        and chooses their own password; you never learn it.
        {shown.reset && " Their old password and every signed-in browser stopped working when you reset it."}
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

/* ---------- create ---------- */

function CreateUserDialog({
  open,
  onClose,
  accessMode,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  accessMode: boolean;
  onCreated: (username: string, code: SetupCode) => void;
}) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");

  const create = useApiMutation(
    () =>
      api<{ user: UserInfo; setupCode: SetupCode }>("/api/users", {
        method: "POST",
        json: { username: username.trim().toLowerCase(), email: email.trim() || null },
      }),
    ["users"],
    (res) => {
      onClose();
      setUsername("");
      setEmail("");
      // Access mode has no passwords, so there is no code to hand over.
      if (accessMode) toast.success(`${res.user.username} created — they sign in through Cloudflare Access with that email`);
      else onCreated(res.user.username, res.setupCode);
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending && username.trim() && (!accessMode || email.trim())) create.mutate(undefined);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create user"
      description={
        accessMode
          ? "They sign in through Cloudflare Access; their email decides which user they are."
          : "They get a one-time setup code to choose their own password."
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Username" hint="lowercase letters, digits and dashes">
          <Input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jane"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field label="Email" hint={accessMode ? "must match their Cloudflare Access email" : "optional"}>
          <Input
            type="email"
            className="font-sans"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
          />
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !username.trim() || (accessMode && !email.trim())}>
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---------- rename ---------- */

/** A new username moves every agent URL of the user; nothing redirects, so say which ones stop working. */
function RenameDialog({ user, onClose }: { user: UserInfo | null; onClose: () => void }) {
  const [name, setName] = useState(user?.username ?? "");
  const agents = useQuery({
    queryKey: ["user-agents", user?.id],
    queryFn: () => api<{ slug: string }[]>(`/api/users/${user!.id}/agents`),
    enabled: user !== null,
  });
  const rename = useApiMutation(
    () =>
      api<{ user: UserInfo; brokenAgentSlugs: string[] }>(`/api/users/${user!.id}`, {
        method: "PATCH",
        json: { username: name.trim().toLowerCase() },
      }),
    ["users"],
    (res) => {
      onClose();
      toast.success(
        res.brokenAgentSlugs.length > 0
          ? `Renamed to ${res.user.username} — ${res.brokenAgentSlugs.length} agent URL${res.brokenAgentSlugs.length === 1 ? "" : "s"} changed`
          : `Renamed to ${res.user.username}`,
      );
    },
  );
  if (!user) return null;

  const next = name.trim().toLowerCase();
  const slugs = agents.data?.map((a) => a.slug) ?? [];
  const origin = window.location.origin;

  return (
    <Dialog open onClose={onClose} title={`Rename ${user.username}`} description="Only you can rename a user.">
      <div className="flex flex-col gap-3">
        <Field label="New username" hint="lowercase letters, digits and dashes">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" spellCheck={false} />
        </Field>
        {slugs.length > 0 && (
          <div className="rounded-[10px] border border-warn/40 bg-warn-bg px-3 py-2.5">
            <p className="text-xs font-semibold">These agent URLs stop working, with no redirect:</p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {slugs.map((slug) => (
                <li key={slug} className="truncate font-mono text-[11.5px] text-muted-fg">
                  {origin}/mcp/<b className="font-semibold text-foreground">{user.username}</b>/{slug}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-muted-fg">
              {user.username} has to reconfigure each agent with the new URL. Tokens stay the same, and other users' aliases
              are untouched.
              {user.isDefault && " The older /mcp/<agent> form keeps working for this user."}
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={slugs.length > 0 ? "danger" : "primary"}
            disabled={rename.isPending || !next || next === user.username}
            onClick={() => rename.mutate(undefined)}
          >
            {slugs.length > 0 ? "Rename anyway" : "Rename"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- delete ---------- */

function DeleteDialog({ user, onClose }: { user: UserInfo | null; onClose: () => void }) {
  const del = useApiMutation(
    () => api(`/api/users/${user!.id}`, { method: "DELETE" }),
    ["users"],
    () => {
      onClose();
      toast.success("User deleted");
    },
  );
  if (!user) return null;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <Dialog open onClose={onClose} title={`Delete ${user.username}?`} description="This can't be undone.">
      <p className="text-[13px] leading-relaxed text-muted-fg">
        Removes {user.username}, their {count(user.serverCount, "server")} and {count(user.agentCount, "agent")}, and every
        share of those servers. Other users' agents lose anything {user.username} shared with them.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(undefined)}>
          Delete {user.username}
        </Button>
      </div>
    </Dialog>
  );
}

/* ---------- row ---------- */

function EmailEditor({ user }: { user: UserInfo }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user.email ?? "");
  const save = useApiMutation(
    () => api(`/api/users/${user.id}`, { method: "PATCH", json: { email: draft.trim() || null } }),
    ["users"],
    () => setEditing(false),
  );

  if (!editing) {
    return (
      <button
        className="cursor-pointer text-left text-xs text-faint hover:text-foreground"
        onClick={() => {
          setDraft(user.email ?? "");
          setEditing(true);
        }}
        title="Edit email"
      >
        {user.email ?? "Add email"}
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <Input
        autoFocus
        type="email"
        className="w-56 font-sans text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        aria-label={`Email for ${user.username}`}
        placeholder="name@example.com"
      />
      <Button size="sm" variant="primary" type="submit" disabled={save.isPending}>
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

function UserRow({
  user,
  accessMode,
  onRename,
  onDelete,
  onCode,
}: {
  user: UserInfo;
  accessMode: boolean;
  onRename: () => void;
  onDelete: () => void;
  onCode: (code: SetupCode) => void;
}) {
  const isAdmin = user.role === "admin";
  const patch = useApiMutation(
    (body: { canRunLocalCommands: boolean }) => api(`/api/users/${user.id}`, { method: "PATCH", json: body }),
    ["users"],
  );
  const setDisabled = useApiMutation(
    (disable: boolean) => api(`/api/users/${user.id}/${disable ? "disable" : "enable"}`, { method: "POST" }),
    ["users"],
    () => toast.success(user.disabled ? `${user.username} can sign in again` : `${user.username} is disabled — signed out everywhere`),
  );
  const reset = useApiMutation(
    () => api<{ setupCode: SetupCode }>(`/api/users/${user.id}/reset-password`, { method: "POST" }),
    ["users"],
    (res) => onCode(res.setupCode),
  );

  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div className={cn("flex items-start gap-3.5 px-4 py-3.5", user.disabled && "opacity-70")}>
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12.5px] font-semibold text-primary"
      >
        {user.username[0]?.toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">{user.username}</span>
          {isAdmin && <Badge className="border-transparent bg-primary-soft font-semibold text-primary">Admin</Badge>}
          {user.disabled && <Badge className="border-transparent bg-err-bg font-semibold text-err">disabled</Badge>}
          {!accessMode && !user.hasPassword && !user.disabled && (
            <Badge className="border-transparent bg-warn-bg font-semibold text-warn" title="They haven't redeemed their setup code yet">
              {user.setupCodePending ? "setup code pending" : "no password"}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
          <span>
            {count(user.serverCount, "server")} · {count(user.agentCount, "agent")}
          </span>
          <span aria-hidden="true">·</span>
          <EmailEditor user={user} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button size="sm" onClick={onRename}>
            Rename
          </Button>
          {!accessMode && !user.isDefault && (
            <Button
              size="sm"
              disabled={reset.isPending}
              onClick={() => {
                if (confirm(`Reset ${user.username}'s password? Their current password and every signed-in browser stop working.`)) {
                  reset.mutate(undefined);
                }
              }}
            >
              Reset password
            </Button>
          )}
          {!user.isDefault && (
            <>
              <Button
                size="sm"
                disabled={setDisabled.isPending}
                onClick={() => {
                  if (user.disabled) setDisabled.mutate(false);
                  else if (confirm(`Disable ${user.username}? They are signed out, and their agents and servers stop until you enable them again.`)) {
                    setDisabled.mutate(true);
                  }
                }}
              >
                {user.disabled ? "Enable" : "Disable"}
              </Button>
              <Button size="sm" variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      <label className="flex shrink-0 items-center gap-2 pt-0.5">
        <span className="text-xs text-muted-fg" title="Lets them add servers that run commands on this machine without asking you">
          Run local commands
        </span>
        <Switch
          checked={user.canRunLocalCommands}
          // The Admin always can.
          disabled={isAdmin || patch.isPending}
          onChange={(canRunLocalCommands) => patch.mutate({ canRunLocalCommands })}
          label={`${user.username} can run local commands`}
        />
      </label>
    </div>
  );
}

/* ---------- page ---------- */

export function UsersPage() {
  const { data: auth } = useAuthMe();
  const { data: users, isLoading, error } = useUsers();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<UserInfo | null>(null);
  const [deleting, setDeleting] = useState<UserInfo | null>(null);
  const [code, setCode] = useState<{ username: string; code: SetupCode; reset: boolean } | null>(null);

  const accessMode = auth?.loginMode === "cloudflare";

  return (
    <>
      <PageBar
        title="Users"
        sub={users ? `${users.length} user${users.length === 1 ? "" : "s"} · names and counts only` : undefined}
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> Create user
          </Button>
        }
      />
      <div className="divide-y divide-border-soft rounded-[14px] border border-border bg-panel">
        {isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-faint">Loading…</p>
        ) : error ? (
          <p className="px-4 py-8 text-center text-sm text-err">
            {error instanceof ApiError ? error.message : "Could not load users"}
          </p>
        ) : (
          (users ?? []).map((user) => (
            <UserRow
              key={user.id}
              user={user}
              accessMode={accessMode}
              onRename={() => setRenaming(user)}
              onDelete={() => setDeleting(user)}
              onCode={(c) => setCode({ username: user.username, code: c, reset: true })}
            />
          ))
        )}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-faint">
        You can't see other users' servers, agents or logs, only how many they have. Users can share their own servers with
        each other from the Servers page.
      </p>

      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        accessMode={accessMode}
        onCreated={(username, c) => setCode({ username, code: c, reset: false })}
      />
      {/* Keyed so each rename starts from the right user's name. */}
      {renaming && <RenameDialog key={renaming.id} user={renaming} onClose={() => setRenaming(null)} />}
      <DeleteDialog user={deleting} onClose={() => setDeleting(null)} />
      <SetupCodeDialog shown={code} onClose={() => setCode(null)} />
    </>
  );
}
