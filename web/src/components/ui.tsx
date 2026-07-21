import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export function Button({
  variant = "outline",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[9px] font-semibold tracking-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-[11.5px]" : "px-3.5 py-1.5 text-[12.5px]",
        variant === "primary" &&
          "bg-gradient-to-b from-primary-2 to-primary text-primary-fg shadow-sm hover:brightness-110",
        variant === "outline" && "border border-border bg-panel text-foreground hover:bg-panel-2",
        variant === "ghost" && "text-muted-fg hover:text-foreground",
        variant === "danger" && "border border-border bg-panel text-err hover:bg-err-bg",
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Input / Label / Field ---------- */

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-[9px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[12.5px] text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-[9px] border border-border bg-panel px-2.5 py-1.5 font-mono text-[12.5px] text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold">
        {label}
        {hint && <span className="ml-1.5 font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full appearance-none rounded-[9px] border border-border bg-panel px-2.5 py-1.5 text-[13px] font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Badge ---------- */

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-muted-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------- Switch ---------- */

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className={cn("relative inline-block shrink-0", disabled && "opacity-40")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <i
        className={cn(
          "block h-[21px] w-9 rounded-full transition-colors motion-reduce:transition-none",
          checked ? "bg-gradient-to-b from-primary-2 to-primary" : "bg-off/45",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary",
        )}
      >
        <i
          className={cn(
            "absolute top-0.5 left-0.5 block size-[17px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
            checked && "translate-x-[15px]",
          )}
        />
      </i>
    </span>
  );
}

/* ---------- Dialog ---------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "w-full rounded-2xl border border-border bg-panel shadow-2xl",
          wide ? "max-w-xl" : "max-w-md",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-faint">{description}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-md p-1 text-faint hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 pb-5 pt-3">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-0.5 rounded-[10px] border border-border-soft bg-panel-2 p-[3px]" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "flex-1 cursor-pointer rounded-lg py-1 text-[12.5px] font-medium tracking-tight transition-colors",
            value === opt.value ? "bg-panel font-semibold text-foreground shadow-sm" : "text-muted-fg hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Code block with copy ---------- */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        toast.success("Copied");
      }}
    >
      {label}
    </Button>
  );
}
