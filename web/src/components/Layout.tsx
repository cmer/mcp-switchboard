import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { Bot, Server, Settings } from "lucide-react";
import { useAuthMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";

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
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const { data: auth } = useAuthMe();
  const instanceName = auth?.instanceName ?? null;
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
          {NAV.map(({ to, label, icon: Icon }) => (
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
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2.5 font-mono text-[11px] text-faint">v{__APP_VERSION__}</div>
      </aside>
      <main className="min-w-0 flex-1 px-5 py-6 sm:px-7">
        <div className="mx-auto max-w-3xl">{children}</div>
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
