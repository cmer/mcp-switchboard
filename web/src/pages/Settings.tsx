import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageBar } from "@/components/Layout";
import { Button } from "@/components/ui";

export function SettingsPage() {
  const qc = useQueryClient();
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["auth"] });
  };

  return (
    <>
      <PageBar title="Settings" />
      <div className="rounded-[14px] border border-border bg-panel px-4 py-4">
        <h2 className="text-sm font-semibold">Session</h2>
        <p className="mt-1 mb-3 text-xs text-faint">You're logged in as the switchboard admin.</p>
        <Button onClick={() => void logout()}>Log out</Button>
      </div>
      <div className="mt-4 rounded-[14px] border border-border bg-panel px-4 py-4 text-xs leading-relaxed text-muted-fg">
        <h2 className="mb-1 text-sm font-semibold text-foreground">About</h2>
        <p>
          MCP Switchboard v0.1.0 · data lives in <code className="font-mono">data/</code> next to the server (SQLite + encryption
          key). Backup = copy that directory. Set <code className="font-mono">PUBLIC_URL</code> if you access the switchboard via a
          LAN hostname so OAuth redirects come back to the right place.
        </p>
      </div>
    </>
  );
}
