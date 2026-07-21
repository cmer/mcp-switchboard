import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Segmented light / dark / system picker. `compact` drops the labels (sidebar). */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useTheme();
  return (
    <div
      className="inline-flex gap-0.5 rounded-[10px] border border-border-soft bg-panel-2 p-[3px]"
      role="radiogroup"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={mode === value}
          aria-label={label}
          title={label}
          onClick={() => setMode(value)}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium tracking-tight transition-colors",
            compact ? "px-2 py-1" : "px-2.5 py-1",
            mode === value ? "bg-panel font-semibold text-foreground shadow-sm" : "text-muted-fg hover:text-foreground",
          )}
        >
          <Icon size={compact ? 14 : 13} />
          {!compact && label}
        </button>
      ))}
    </div>
  );
}
