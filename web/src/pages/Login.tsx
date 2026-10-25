import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AccessError, AuthMe } from "@/lib/types";
import { Button, Input } from "@/components/ui";

function Card({ children, onSubmit }: { children: ReactNode; onSubmit?: (e: FormEvent) => void }) {
  const className = "w-full max-w-xs rounded-2xl border border-border bg-panel p-6 shadow-xl";
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {onSubmit ? (
        <form onSubmit={onSubmit} className={className}>
          {children}
        </form>
      ) : (
        <div className={className}>{children}</div>
      )}
    </div>
  );
}

const ACCESS_MESSAGES: Record<AccessError, (email: string | null | undefined) => string> = {
  unknown_email: (email) => `Signed in as ${email ?? "an unknown address"}, but no switchboard user has this email. Ask the Admin.`,
  disabled: (email) => `Signed in as ${email ?? "this address"}, but this account is disabled. Ask the Admin.`,
  no_token: () =>
    "This switchboard sits behind Cloudflare Access, but your request carried no Access token. Open it through its Access-protected address.",
  invalid_token: () => "Cloudflare Access gave your browser a token the switchboard couldn't verify. Sign in again through Access.",
};

/** Cloudflare Access mode: Access is the login, so there is no form — only why you were turned away. */
function AccessScreen({ auth }: { auth: AuthMe }) {
  const message = ACCESS_MESSAGES[auth.accessError ?? "no_token"](auth.accessEmail);
  return (
    <Card>
      <div className="mb-1 text-[15px] font-semibold tracking-tight">MCP Switchboard</div>
      <p className="mb-4 text-xs leading-relaxed text-muted-fg">{message}</p>
      <Button className="w-full" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </Card>
  );
}

type Mode = "login" | "code";

export function Login({ auth }: { auth: AuthMe | undefined }) {
  const qc = useQueryClient();
  const needsSetup = auth?.needsSetup ?? false;
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  if (auth?.loginMode === "cloudflare") return <AccessScreen auth={auth} />;

  const useCode = mode === "code" && !needsSetup;
  const ready = needsSetup
    ? password.length >= 4
    : useCode
      ? !!username.trim() && !!code.trim() && password.length >= 4
      : !!username.trim() && !!password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (needsSetup) await api("/api/auth/setup", { method: "POST", json: { password } });
      else if (useCode) await api("/api/auth/setup-code", { method: "POST", json: { username: username.trim(), code: code.trim(), password } });
      else await api("/api/auth/login", { method: "POST", json: { username: username.trim(), password } });
      await qc.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setPassword("");
    setCode("");
  };

  return (
    <Card onSubmit={(e) => void submit(e)}>
      <div className="mb-1 text-[15px] font-semibold tracking-tight">MCP Switchboard</div>
      <p className="mb-4 text-xs text-faint">
        {needsSetup
          ? "First run — choose a password for the admin account."
          : useCode
            ? "Enter the setup code the Admin gave you, then choose your own password."
            : "Log in with your username and password."}
      </p>
      {!needsSetup && (
        <Input
          autoFocus
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-3 font-sans"
        />
      )}
      {useCode && (
        <Input
          name="setup-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="Setup code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="mb-3 font-mono tracking-wider"
        />
      )}
      <Input
        type="password"
        name="password"
        autoFocus={needsSetup}
        autoComplete={needsSetup || useCode ? "new-password" : "current-password"}
        placeholder={useCode ? "New password" : "Password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mb-3 font-sans"
      />
      <Button type="submit" variant="primary" disabled={busy || !ready} className="w-full">
        {needsSetup ? "Set password" : useCode ? "Set password & log in" : "Log in"}
      </Button>
      {!needsSetup && (
        <button
          type="button"
          onClick={() => switchMode(useCode ? "login" : "code")}
          className="mt-3 block w-full cursor-pointer text-center text-xs font-medium text-muted-fg hover:text-foreground"
        >
          {useCode ? "Back to log in" : "I have a setup code"}
        </button>
      )}
    </Card>
  );
}
