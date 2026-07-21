import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button, Input } from "@/components/ui";

export function Login({ needsSetup }: { needsSetup: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(needsSetup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", json: { password } });
      await qc.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-xs rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <div className="mb-1 text-[15px] font-semibold tracking-tight">MCP Switchboard</div>
        <p className="mb-4 text-xs text-faint">
          {needsSetup ? "First run — choose an admin password." : "Enter the admin password."}
        </p>
        <Input
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 font-sans"
        />
        <Button type="submit" variant="primary" disabled={busy || password.length < 4} className="w-full">
          {needsSetup ? "Set password" : "Log in"}
        </Button>
      </form>
    </div>
  );
}
