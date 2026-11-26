import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ClipboardPaste, CornerDownLeft, Globe, Search, SquareTerminal } from "lucide-react";
import { TEMPLATE_CATEGORIES, templateScore, type ServerTemplate, type TemplateCategory } from "@/lib/templates";
import { cn } from "@/lib/utils";

export type ManualKind = "stdio" | "remote" | "paste";

type Item =
  | { type: "template"; template: ServerTemplate }
  | { type: "manual"; kind: ManualKind; label: string; hint: string; icon: ReactNode; prefill?: string };

interface Group {
  heading: string;
  items: Item[];
}

/** What a typed query looks like, so the matching manual option can be offered first, pre-filled. */
function detectManual(raw: string): ManualKind | null {
  const q = raw.trim();
  if (/^https?:\/\/\S+$/i.test(q)) return "remote";
  if (/^claude\s+mcp\s+add\b/i.test(q) || q.startsWith("{")) return "paste";
  if (/^(npx|uvx|uv|bunx|pnpm|docker|node|python3?|deno)\s/i.test(q) || /^\.{0,2}\//.test(q)) return "stdio";
  return null;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-bold text-primary">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function Tag({ tone, children }: { tone: "local" | "oauth" | "key"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap",
        tone === "local" && "bg-warn-bg text-warn",
        tone === "oauth" && "bg-primary-soft text-primary",
        tone === "key" && "bg-ok-bg text-ok",
      )}
    >
      {children}
    </span>
  );
}

function TemplateTags({ t }: { t: ServerTemplate }) {
  return (
    <span className="flex shrink-0 gap-1">
      {t.transport === "stdio" && <Tag tone="local">Local</Tag>}
      {t.authType === "oauth" ? (
        <Tag tone="oauth">OAuth</Tag>
      ) : (
        t.inputs?.some((inp) => inp.secret) && <Tag tone="key">Key</Tag>
      )}
    </span>
  );
}

/**
 * Search-first template picker (command-palette style): the cursor starts in the search box,
 * results rank as you type, ↑/↓ + Enter pick one. Empty query lists every template grouped by
 * category. The list has a fixed height, so the dialog doesn't grow with the catalog.
 */
export function TemplatePicker({
  templates,
  onPick,
  onManual,
}: {
  templates: ServerTemplate[];
  onPick: (t: ServerTemplate) => void;
  onManual: (kind: ManualKind, prefill?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  const counts = useMemo(() => {
    const matching = templates.filter((t) => templateScore(t, q) > 0);
    const byCat = Object.fromEntries(
      TEMPLATE_CATEGORIES.map((c) => [c.id, matching.filter((t) => t.category === c.id).length]),
    ) as Record<TemplateCategory, number>;
    return { all: matching.length, ...byCat };
  }, [templates, q]);

  const groups = useMemo<Group[]>(() => {
    const matches = templates.filter((t) => (category === "all" || t.category === category) && templateScore(t, q) > 0);
    const out: Group[] = [];

    const detected = detectManual(query);
    const raw = query.trim();
    const manual: Item[] = [
      {
        type: "manual",
        kind: "remote",
        label: "Remote URL",
        hint: detected === "remote" ? `Connect to ${raw}` : "Any HTTP or SSE endpoint",
        icon: <Globe size={16} />,
        prefill: detected === "remote" ? raw : undefined,
      },
      {
        type: "manual",
        kind: "stdio",
        label: "Local command",
        hint: detected === "stdio" ? `Run ${raw}` : "npx, uvx, docker…",
        icon: <SquareTerminal size={16} />,
        prefill: detected === "stdio" ? raw : undefined,
      },
      {
        type: "manual",
        kind: "paste",
        label: "Paste config",
        hint: detected === "paste" ? "Import what you typed" : "claude mcp add … or an mcpServers JSON block",
        icon: <ClipboardPaste size={16} />,
        prefill: detected === "paste" ? raw : undefined,
      },
    ];
    if (detected) {
      // The query is a URL / command / config, not a service name: lead with what it is.
      manual.sort((a, b) => Number(b.type === "manual" && b.kind === detected) - Number(a.type === "manual" && a.kind === detected));
      out.push({ heading: "Set up manually", items: manual });
    }

    if (q) {
      matches.sort((a, b) => templateScore(b, q) - templateScore(a, q) || a.name.localeCompare(b.name));
      if (matches.length) out.push({ heading: "Best matches", items: matches.map((t) => ({ type: "template", template: t })) });
    } else {
      for (const c of TEMPLATE_CATEGORIES) {
        const inCat = matches.filter((t) => t.category === c.id);
        if (inCat.length) out.push({ heading: c.name, items: inCat.map((t) => ({ type: "template", template: t })) });
      }
    }

    if (!detected) out.push({ heading: "Set up manually", items: manual });
    return out;
  }, [templates, category, q, query]);

  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // A typed URL or command isn't a failed search, so it gets no "no template" line.
  const noTemplateMatch = !!q && !detectManual(query) && !items.some((i) => i.type === "template");

  useEffect(() => setActive(0), [q, category]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.type === "template") onPick(item.template);
    else onManual(item.kind, item.prefill);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape" && (query || category !== "all")) {
      // First Escape clears the search; a second one closes the dialog.
      e.stopPropagation();
      setQuery("");
      setCategory("all");
    }
  };

  let index = 0;
  return (
    <div className="-mx-5 -mb-5 flex flex-col">
      <label className="flex items-center gap-2.5 border-y border-border-soft px-5 py-3">
        <Search size={17} className="shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Search ${templates.length} services, or paste a URL or command…`}
          role="combobox"
          aria-expanded
          aria-controls="template-picker-list"
          aria-activedescendant={`template-option-${active}`}
          aria-label="Search services"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-faint"
        />
      </label>

      <div className="flex gap-1.5 overflow-x-auto border-b border-border-soft px-5 py-2.5 [scrollbar-width:none]">
        {[{ id: "all" as const, short: "All" }, ...TEMPLATE_CATEGORIES].map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={category === c.id}
            onClick={() => setCategory(c.id)}
            className={cn(
              "cursor-pointer rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
              category === c.id
                ? "border-foreground bg-foreground text-panel"
                : "border-border-soft bg-panel text-muted-fg hover:border-border hover:text-foreground",
            )}
          >
            {c.short}
            <span className="ml-1 tabular-nums opacity-55">{counts[c.id]}</span>
          </button>
        ))}
      </div>

      <div ref={listRef} id="template-picker-list" role="listbox" aria-label="Services" className="h-[22rem] overflow-y-auto px-2 pb-2">
        {noTemplateMatch && (
          <p className="px-3 pt-6 pb-1 text-center text-[13px] text-muted-fg">
            No template for “{query.trim()}”{category !== "all" && " in this category"}.
          </p>
        )}
        {groups.map((g) => (
          <Fragment key={g.heading}>
            <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{g.heading}</div>
            {g.items.map((item) => {
              const i = index++;
              const isActive = i === active;
              return (
                <div
                  key={item.type === "template" ? item.template.slug : `manual-${item.kind}`}
                  id={`template-option-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isActive}
                  onMouseMove={() => !isActive && setActive(i)}
                  onClick={() => choose(item)}
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-[7px]",
                    isActive && "bg-primary-soft",
                  )}
                >
                  {item.type === "template" ? (
                    <>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-border-soft bg-white shadow-sm">
                        {item.template.logo}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-semibold tracking-tight">
                          <Highlight text={item.template.name} query={q} />
                        </span>
                        <span className="block truncate text-xs text-muted-fg">
                          <Highlight text={item.template.tagline} query={q} />
                        </span>
                      </span>
                      <TemplateTags t={item.template} />
                    </>
                  ) : (
                    <>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-dashed border-border bg-panel-2 text-muted-fg">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-semibold tracking-tight">{item.label}</span>
                        <span className={cn("block truncate text-xs text-muted-fg", item.prefill && "font-mono")}>{item.hint}</span>
                      </span>
                    </>
                  )}
                  <CornerDownLeft size={13} className={cn("shrink-0 text-faint", isActive ? "opacity-100" : "opacity-0")} />
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div className="flex items-center gap-3.5 rounded-b-2xl border-t border-border-soft bg-panel-2 px-5 py-2.5 text-[11.5px] text-faint">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> set up
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> {query || category !== "all" ? "clear" : "close"}
        </span>
        <span className="ml-auto hidden sm:inline">Templates fill in the URL, command and auth for you</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-b-2 border-border bg-panel px-1 font-mono text-[10.5px] text-muted-fg">
      {children}
    </kbd>
  );
}
