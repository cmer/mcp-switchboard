// PROTOTYPE — throwaway, do not ship. Multi-user map › "Multi-user UI prototype" ticket.
// Three structurally different takes on how sharing shows up on the Servers page, switchable via
// ?variant=A|B|C on /servers (dev builds only). Your own servers come from the real API (stubbed if
// empty); users, shares and incoming offers are in-memory fakes — nothing here calls the backend.
import { useState } from "react";
import { Check, Inbox, Share2, Users, X } from "lucide-react";
import { useServers } from "@/lib/hooks";
import type { ServerInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBar } from "@/components/Layout";
import { PrototypeSwitcher } from "@/components/PrototypeSwitcher";
import { StatusDot, statusInfo } from "@/components/StatusDot";
import { Badge, Button, Dialog, Input, Switch, Tabs } from "@/components/ui";

/* ---------- fake multi-user state ---------- */

const ME = "carl";
const OTHER_USERS = ["jane", "sam"];

type Outgoing = { serverId: number; user: string; calls: number; lastUsed: string | null };
type Received = { id: number; owner: string; name: string; alias: string; state: "ok" | "waiting" | "off"; tools: number; agentsOn: number };
type Offer = { id: number; owner: string; name: string; slug: string };

const STUB_SERVERS: Partial<ServerInfo>[] = [
  { id: 1, slug: "gmail", name: "Gmail", type: "http", authType: "oauth", oauthStatus: "ok", state: "connected", toolCount: 9, enabled: true },
  { id: 2, slug: "home-assistant", name: "Home Assistant", type: "http", authType: "bearer", state: "connected", toolCount: 22, enabled: true },
  { id: 3, slug: "context7", name: "Context7", type: "http", authType: "none", state: "connected", toolCount: 2, enabled: true },
  { id: 4, slug: "github", name: "GitHub", type: "stdio", authType: "none", state: "connected", toolCount: 41, enabled: true },
];

function useProto() {
  const { data } = useServers();
  const mine = (data && data.length > 0 ? data : (STUB_SERVERS as ServerInfo[])).slice(0, 6);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([
    { serverId: mine[1]?.id ?? 2, user: "jane", calls: 142, lastUsed: "2h ago" },
    { serverId: mine[2]?.id ?? 3, user: "jane", calls: 12, lastUsed: "3d ago" },
  ]);
  const [received, setReceived] = useState<Received[]>([
    { id: 101, owner: "jane", name: "Notion", alias: "jane-notion", state: "ok", tools: 14, agentsOn: 1 },
    { id: 102, owner: "jane", name: "Google Calendar", alias: "jane-calendar", state: "waiting", tools: 0, agentsOn: 2 },
  ]);
  const [offers, setOffers] = useState<Offer[]>([{ id: 201, owner: "sam", name: "Plex", slug: "plex" }]);

  const sharesOf = (serverId: number) => outgoing.filter((o) => o.serverId === serverId);
  const isShared = (serverId: number, user: string) => outgoing.some((o) => o.serverId === serverId && o.user === user);
  const share = (serverId: number, user: string) =>
    !isShared(serverId, user) && setOutgoing((o) => [...o, { serverId, user, calls: 0, lastUsed: null }]);
  const revoke = (serverId: number, user: string) =>
    setOutgoing((o) => o.filter((x) => !(x.serverId === serverId && x.user === user)));
  const accept = (offer: Offer, alias: string) => {
    setOffers((o) => o.filter((x) => x.id !== offer.id));
    setReceived((r) => [...r, { id: offer.id, owner: offer.owner, name: offer.name, alias, state: "ok", tools: 7, agentsOn: 0 }]);
  };
  const decline = (offer: Offer) => setOffers((o) => o.filter((x) => x.id !== offer.id));
  const removeReceived = (id: number) => setReceived((r) => r.filter((x) => x.id !== id));
  const rename = (id: number, alias: string) => setReceived((r) => r.map((x) => (x.id === id ? { ...x, alias } : x)));

  return { mine, outgoing, received, offers, sharesOf, isShared, share, revoke, accept, decline, removeReceived, rename };
}
type Proto = ReturnType<typeof useProto>;

/* ---------- small shared bits (deliberately not a shared layout) ---------- */

function receivedStatus(r: Received) {
  if (r.state === "waiting") return { tone: "warn" as const, text: `Waiting for ${r.owner}`, sub: `${r.owner} needs to re-authorize` };
  if (r.state === "off") return { tone: "off" as const, text: "Unavailable", sub: `${r.owner} turned it off` };
  return { tone: "ok" as const, text: "Connected", sub: `${r.tools} tools` };
}

function OfferCard({ offer, p, compact }: { offer: Offer; p: Proto; compact?: boolean }) {
  const [alias, setAlias] = useState(`${offer.owner}-${offer.slug}`);
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-[12px] border border-primary/40 bg-primary-soft px-4 py-3", compact && "py-2")}>
      <Inbox size={15} className="text-primary" />
      <div className={cn("min-w-0 flex-1 text-[13px]", compact && "basis-[calc(100%-2rem)]")}>
        <b>{offer.owner}</b> shared <b>{offer.name}</b> with you
        <div className="text-xs text-faint">Your agents will see its tools as <code className="font-mono">{alias}__…</code></div>
      </div>
      <Input className={cn("w-40 font-mono text-xs", compact && "flex-1")} value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="Alias" />
      <Button size="sm" variant="primary" onClick={() => p.accept(offer, alias)}>
        <Check size={13} /> Accept
      </Button>
      <Button size="sm" variant="ghost" onClick={() => p.decline(offer)}>
        Decline
      </Button>
    </div>
  );
}

function ShareDialog({ server, p, onClose }: { server: ServerInfo | null; p: Proto; onClose: () => void }) {
  if (!server) return null;
  return (
    <Dialog open onClose={onClose} title={`Share ${server.name}`} description="They use your connection and your credentials. They never see its config or secrets.">
      <div className="divide-y divide-border-soft rounded-[10px] border border-border-soft">
        {OTHER_USERS.map((u) => {
          const s = p.sharesOf(server.id).find((x) => x.user === u);
          return (
            <div key={u} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{u}</div>
                <div className="text-xs text-faint">
                  {s ? (s.lastUsed ? `${s.calls} calls · last used ${s.lastUsed}` : "Offered · not accepted yet") : "Not shared"}
                </div>
              </div>
              {s ? (
                <Button size="sm" variant="danger" onClick={() => p.revoke(server.id, u)}>
                  Revoke
                </Button>
              ) : (
                <Button size="sm" onClick={() => p.share(server.id, u)}>
                  Share
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

/* ---------- Variant A: one list, everything inline ---------- */

function VariantA({ p }: { p: Proto }) {
  const [sharing, setSharing] = useState<ServerInfo | null>(null);
  return (
    <>
      <PageBar title="Servers" sub={`${p.mine.length} yours · ${p.received.length} shared with you`} />
      <div className="mb-4 flex flex-col gap-2">
        {p.offers.map((o) => (
          <OfferCard key={o.id} offer={o} p={p} />
        ))}
      </div>
      <div className="divide-y divide-border-soft rounded-[14px] border border-border bg-panel">
        {p.mine.map((s) => {
          const st = statusInfo(s);
          const shares = p.sharesOf(s.id);
          return (
            <div key={s.id} className="flex items-center gap-3.5 px-4 py-3">
              <StatusDot tone={st.tone} />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[13px] font-semibold">{s.slug}</span>
                <div className="text-xs text-faint">
                  {st.text} · {s.toolCount} tools
                </div>
              </div>
              {shares.length > 0 && (
                <Badge title={shares.map((x) => `${x.user}: ${x.calls} calls`).join("\n")}>
                  <Users size={11} className="mr-1" /> shared with {shares.map((x) => x.user).join(", ")}
                </Badge>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSharing(s)}>
                <Share2 size={13} /> Share
              </Button>
              <Switch checked={s.enabled} onChange={() => {}} label="Enable" />
            </div>
          );
        })}
        {p.received.map((r) => {
          const st = receivedStatus(r);
          return (
            <div key={r.id} className="flex items-center gap-3.5 bg-panel-2/40 px-4 py-3">
              <StatusDot tone={st.tone} />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[13px] font-semibold">{r.alias}</span>
                <div className="text-xs text-faint">
                  {st.text} · {st.sub}
                </div>
              </div>
              <Badge className="border-primary/40 text-primary">from {r.owner}</Badge>
              <Button size="sm" variant="ghost" onClick={() => p.removeReceived(r.id)}>
                Remove
              </Button>
              {/* no on/off switch: the owner controls whether it runs */}
              <span className="w-9" />
            </div>
          );
        })}
      </div>
      <ShareDialog server={sharing} p={p} onClose={() => setSharing(null)} />
    </>
  );
}

/* ---------- Variant B: tabs — Mine / Shared with me / Shared by me ---------- */

function VariantB({ p }: { p: Proto }) {
  const [tab, setTab] = useState<"mine" | "in" | "out">("mine");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <>
      <PageBar title="Servers" action={<Button variant="primary">+ Add server</Button>} />
      <div className="mb-4 w-full max-w-md">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "mine", label: `Mine (${p.mine.length})` },
            { value: "in", label: `Shared with me (${p.received.length}${p.offers.length ? ` +${p.offers.length} new` : ""})` },
            { value: "out", label: `Shared by me (${p.outgoing.length})` },
          ]}
        />
      </div>

      {tab === "mine" && (
        <div className="divide-y divide-border-soft rounded-[14px] border border-border bg-panel">
          {p.mine.map((s) => {
            const st = statusInfo(s);
            const n = p.sharesOf(s.id).length;
            return (
              <div key={s.id} className="flex items-center gap-3.5 px-4 py-3">
                <StatusDot tone={st.tone} />
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-[13px] font-semibold">{s.slug}</span>
                  <div className="text-xs text-faint">
                    {st.text} · {s.toolCount} tools
                  </div>
                </div>
                {n > 0 && (
                  <button className="cursor-pointer text-xs text-primary" onClick={() => setTab("out")}>
                    <Share2 size={12} className="mr-1 inline" />
                    {n}
                  </button>
                )}
                <Switch checked={s.enabled} onChange={() => {}} label="Enable" />
              </div>
            );
          })}
        </div>
      )}

      {tab === "in" && (
        <div className="flex flex-col gap-3">
          {p.offers.map((o) => (
            <OfferCard key={o.id} offer={o} p={p} compact />
          ))}
          <table className="w-full overflow-hidden rounded-[14px] border border-border bg-panel text-[13px]">
            <thead className="bg-panel-2 text-left text-[11px] uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2">Alias (tool prefix)</th>
                <th className="px-4 py-2">Server</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Your agents</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {p.received.map((r) => {
                const st = receivedStatus(r);
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5 font-mono font-semibold">
                      {renaming === r.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            p.rename(r.id, draft);
                            setRenaming(null);
                          }}
                        >
                          <Input autoFocus className="w-36 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
                        </form>
                      ) : (
                        <button
                          className="cursor-pointer hover:underline"
                          title="Rename alias"
                          onClick={() => {
                            setRenaming(r.id);
                            setDraft(r.alias);
                          }}
                        >
                          {r.alias}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5">{r.name}</td>
                    <td className="px-4 py-2.5">{r.owner}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <StatusDot tone={st.tone} /> {st.text}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-faint">{r.agentsOn} on · set on Agents page</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => p.removeReceived(r.id)}>
                        <X size={13} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "out" && (
        <div className="flex flex-col gap-3">
          {p.mine.map((s) => {
            const shares = p.sharesOf(s.id);
            const notYet = OTHER_USERS.filter((u) => !p.isShared(s.id, u));
            return (
              <div key={s.id} className="rounded-[14px] border border-border bg-panel px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 font-mono text-[13px] font-semibold">{s.slug}</span>
                  {notYet.map((u) => (
                    <Button key={u} size="sm" onClick={() => p.share(s.id, u)}>
                      + {u}
                    </Button>
                  ))}
                </div>
                {shares.length === 0 ? (
                  <p className="mt-1 text-xs text-faint">Not shared</p>
                ) : (
                  shares.map((x) => (
                    <div key={x.user} className="mt-2 flex items-center gap-3 rounded-lg bg-panel-2/50 px-3 py-1.5 text-xs">
                      <b className="w-16">{x.user}</b>
                      <span className="flex-1 text-faint">{x.lastUsed ? `${x.calls} calls · last ${x.lastUsed}` : "offered, not accepted"}</span>
                      <Button size="sm" variant="danger" onClick={() => p.revoke(s.id, x.user)}>
                        Revoke
                      </Button>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ---------- Variant C: people matrix — servers × users, like the agent switch matrix ---------- */

function VariantC({ p }: { p: Proto }) {
  return (
    <>
      <PageBar title="Servers" sub="Sharing is a grid: tick a cell to share that server with that person" />
      <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
        <div className="grid border-b border-border-soft bg-panel-2 px-4 py-2 text-[11px] uppercase tracking-wide text-faint" style={{ gridTemplateColumns: `1fr repeat(${OTHER_USERS.length}, 110px)` }}>
          <span>Your servers</span>
          {OTHER_USERS.map((u) => (
            <span key={u} className="text-center">
              {u}
            </span>
          ))}
        </div>
        {p.mine.map((s) => {
          const st = statusInfo(s);
          return (
            <div
              key={s.id}
              className="grid items-center border-b border-border-soft px-4 py-2.5 last:border-0"
              style={{ gridTemplateColumns: `1fr repeat(${OTHER_USERS.length}, 110px)` }}
            >
              <span className="flex items-center gap-3">
                <StatusDot tone={st.tone} />
                <span className="font-mono text-[13px] font-semibold">{s.slug}</span>
                <span className="text-xs text-faint">{s.toolCount} tools</span>
              </span>
              {OTHER_USERS.map((u) => {
                const sh = p.sharesOf(s.id).find((x) => x.user === u);
                return (
                  <span key={u} className="flex flex-col items-center gap-0.5">
                    <Switch checked={!!sh} onChange={(v) => (v ? p.share(s.id, u) : p.revoke(s.id, u))} label={`Share ${s.slug} with ${u}`} />
                    <span className="text-[10px] text-faint">{sh ? (sh.lastUsed ? `${sh.calls} calls` : "offered") : " "}</span>
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>

      <h2 className="mt-6 mb-2 text-[13px] font-semibold">From other people</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {OTHER_USERS.map((u) => {
          const mineFrom = p.received.filter((r) => r.owner === u);
          const offersFrom = p.offers.filter((o) => o.owner === u);
          return (
            <div key={u} className="rounded-[14px] border border-border bg-panel p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
                <span className="grid size-6 place-items-center rounded-full bg-primary-soft text-[11px] text-primary">{u[0].toUpperCase()}</span>
                {u}
              </div>
              {offersFrom.map((o) => (
                <OfferCard key={o.id} offer={o} p={p} compact />
              ))}
              {mineFrom.length === 0 && offersFrom.length === 0 && <p className="text-xs text-faint">Nothing shared with you.</p>}
              {mineFrom.map((r) => {
                const st = receivedStatus(r);
                return (
                  <div key={r.id} className="mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel-2/50">
                    <StatusDot tone={st.tone} />
                    <span className="flex-1 font-mono text-xs font-semibold">{r.alias}</span>
                    <span className="text-[11px] text-faint">{st.text}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------- switcher host ---------- */

const VARIANTS = [
  { key: "A", name: "One list" },
  { key: "B", name: "Tabs" },
  { key: "C", name: "People grid" },
];

export function ServersPrototype({ variant }: { variant: string }) {
  const p = useProto();
  return (
    <>
      <div className="mb-3 rounded-lg border border-dashed border-fuchsia-500 px-3 py-1.5 font-mono text-[11px] text-fuchsia-600">
        PROTOTYPE · signed in as {ME} · fake users/shares in memory · reload resets
      </div>
      {variant === "B" ? <VariantB p={p} /> : variant === "C" ? <VariantC p={p} /> : <VariantA p={p} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}
