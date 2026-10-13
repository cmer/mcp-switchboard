// PROTOTYPE — throwaway. Floating variant switcher for ?variant= UI prototypes; dev builds only.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PrototypeSwitcher({ variants }: { variants: { key: string; name: string }[] }) {
  const [params, setParams] = useSearchParams();
  const current = params.get("variant") ?? variants[0].key;
  const idx = Math.max(0, variants.findIndex((v) => v.key === current));

  const go = (delta: number) => {
    const next = variants[(idx + delta + variants.length) % variants.length];
    const p = new URLSearchParams(params);
    p.set("variant", next.key);
    setParams(p, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-2 py-1.5 text-white shadow-2xl ring-2 ring-fuchsia-500">
      <button className="cursor-pointer rounded-full p-1 hover:bg-white/15" onClick={() => go(-1)} aria-label="Previous variant">
        <ChevronLeft size={16} />
      </button>
      <span className="px-2 font-mono text-xs">
        PROTOTYPE {variants[idx].key} ({variants[idx].name})
      </span>
      <button className="cursor-pointer rounded-full p-1 hover:bg-white/15" onClick={() => go(1)} aria-label="Next variant">
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
