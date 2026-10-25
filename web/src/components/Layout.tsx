import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { Bot, LogOut, ScrollText, Server, Settings, Users } from "lucide-react";
import { useAuthMe, useLogout, useServerRequests } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { needsMyAction } from "@/components/ServerRequests";

function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="bm" x1="0" y1="0" x2="28" y2="28">
          <stop stopColor="var(--primary-2)" />
          <stop offset="1" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill="url(#bm)" />
      <circle cx="9" cy="9" r="2.1" fill="#fff" />
      <circle cx="19" cy="14" r="2.1" fill="#fff" />
      <circle cx="9" cy="19" r="2.1" fill="#fff" />
      <path d="M11 9.6 17 13M11 18.4 17 15" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
    </svg>
  );
}

const NAV = [
  { to: "/servers", label: "Servers", icon: Server },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Only the Admin manages users. Sits above Settings, with the other things you configure. */
const USERS_NAV = { to: "/users", label: "Users", icon: Users };

export function Layout({ children }: { children: ReactNode }) {
  const { data: auth } = useAuthMe();
  const { data: requests } = useServerRequests();
  const instanceName = auth?.instanceName ?? null;
  // Requests are reviewed on the Servers page, so that's where the badge points.
  // Your own requests waiting on the Admin aren't yours to act on, so they don't count.
  const pending = (requests ?? []).filter(needsMyAction).length;
  const user = auth?.user ?? null;
  const logout = useLogout();
  const nav = user?.role === "admin" ? [...NAV.slice(0, 3), USERS_NAV, ...NAV.slice(3)] : NAV;
  // The log table needs more room than the forms-shaped pages.
  const wide = useLocation().pathname.startsWith("/logs");
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border-soft bg-panel px-3 py-4 sm:flex">
        <div className="flex items-center gap-2.5 px-2 pb-4">
          <BrandMark />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold tracking-tight">MCP Switchboard</div>
            {instanceName && <div className="truncate text-[10.5px] text-faint">{instanceName}</div>}
          </div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-muted-fg hover:text-foreground",
                  isActive && "bg-primary-soft font-semibold text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={15} className={cn(isActive && "text-primary")} />
                  {label}
                  {to === "/servers" && pending > 0 && (
                    <span
                      title={`${pending} agent request${pending === 1 ? "" : "s"} waiting for review`}
                      className="ml-auto inline-flex min-w-[19px] justify-center rounded-full bg-warn-bg px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-warn"
                    >
                      {pending}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2.5">
          {user && (
            <div className="flex items-center gap-2 border-t border-border-soft pt-3">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary"
              >
                {user.username[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold leading-tight" title={user.email ?? undefined}>
                  {user.username}
                </span>
                {user.role === "admin" && <span className="block text-[10.5px] leading-tight text-faint">Admin</span>}
              </span>
              <button
                onClick={() => void logout()}
                className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] font-medium text-muted-fg hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              >
                <LogOut size={12} /> Log out
              </button>
            </div>
          )}
          <div className="font-mono text-[11px] text-faint">v{__APP_VERSION__}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-5 py-6 sm:px-7">
        <div className={cn("mx-auto", wide ? "max-w-5xl" : "max-w-3xl")}>{children}</div>
      </main>
    </div>
  );
}

export function PageBar({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div>
        <h1 className="text-[17px] font-semibold tracking-tight">{title}</h1>
        {sub && <div className="mt-0.5 text-xs text-faint">{sub}</div>}
      </div>
      {action}
    </div>
  );
}
