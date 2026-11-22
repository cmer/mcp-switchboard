import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Minus, RotateCw, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { TestFix, TestReport, TestStep } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

/** What to test: the form as a create/patch body, an edit of a server, or one entry of a paste. */
export interface TestBody {
  server?: Record<string, unknown>;
  serverId?: number;
  import?: { text: string; index: number };
}

const POLL_MS = 1500;

/**
 * One connection test's lifecycle: run it, and for OAuth carry it through the consent popup and
 * test again once the draft is authorized. The draft id is what a save hands back so the new
 * server adopts those tokens.
 */
export function useConnectionTest() {
  const [report, setReport] = useState<TestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const draftRef = useRef<string | null>(null);
  const bodyRef = useRef<TestBody | null>(null);
  const popupRef = useRef<Window | null>(null);
  const runId = useRef(0);

  const exec = useCallback(async (body: TestBody, popup: Window | null) => {
    const id = ++runId.current;
    bodyRef.current = body;
    setRunning(true);
    setStartedAt(Date.now());
    setError(null);
    try {
      const res = await api<TestReport>("/api/servers/test", {
        method: "POST",
        json: { ...body, ...(draftRef.current ? { oauthDraftId: draftRef.current } : {}) },
      });
      if (id !== runId.current) return;
      setReport(res);
      setTestedKey(JSON.stringify(body));
      if (res.oauthDraftId) {
        draftRef.current = res.oauthDraftId;
        setDraftId(res.oauthDraftId);
      }
      setAuthorizeUrl(res.authorizeUrl ?? null);
      if (res.authorizeUrl && popup && !popup.closed) {
        popup.location.href = res.authorizeUrl;
        popupRef.current = popup;
      } else {
        popup?.close();
      }
    } catch (err) {
      if (id !== runId.current) return;
      popup?.close();
      setReport(null);
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      if (id === runId.current) setRunning(false);
    }
  }, []);

  /**
   * Call from the click itself: for OAuth the popup has to open now, before the request, or the
   * browser blocks it. It's pointed at the consent page once the server returns one.
   */
  const run = useCallback(
    (body: TestBody, opts: { oauth?: boolean } = {}) => {
      let popup: Window | null = null;
      if (opts.oauth) {
        popup = window.open("", "switchboard-oauth", "popup,width=560,height=720");
        try {
          if (popup) popup.document.body.textContent = "Contacting the server…";
        } catch {
          // cross-origin leftover from an earlier run; it's navigated anyway
        }
      }
      void exec(body, popup);
    },
    [exec],
  );

  const waiting = !running && !!report?.steps.some((s) => s.status === "waiting");

  // While the consent popup is open: poll the draft; the popup's last page also pings us.
  useEffect(() => {
    if (!waiting || !draftId) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await api<{ status: string; error: string | null }>(`/api/servers/test/oauth/${draftId}`);
        if (stopped) return;
        if (res.status === "authorized" && bodyRef.current) {
          stopped = true;
          popupRef.current?.close();
          void exec(bodyRef.current, null);
        } else if (res.status === "failed") {
          stopped = true;
          setReport((r) =>
            r && {
              ...r,
              headline: "Authorization failed",
              authorizeUrl: undefined,
              steps: r.steps.map((s) => (s.status === "waiting" ? { ...s, status: "fail", detail: res.error ?? undefined } : s)),
            },
          );
          setAuthorizeUrl(null);
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) {
          stopped = true;
          setError(err.message);
          setReport(null);
        }
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { type?: string })?.type === "switchboard-oauth-test") void check();
    };
    window.addEventListener("message", onMessage);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [waiting, draftId, exec]);

  /** Forget everything, and the draft's tokens with it (a no-op once a save adopted them). */
  const reset = useCallback(() => {
    runId.current++;
    popupRef.current?.close();
    popupRef.current = null;
    if (draftRef.current) void api(`/api/servers/test/oauth/${draftRef.current}`, { method: "DELETE" }).catch(() => {});
    draftRef.current = null;
    bodyRef.current = null;
    setDraftId(null);
    setReport(null);
    setError(null);
    setRunning(false);
    setTestedKey(null);
    setAuthorizeUrl(null);
  }, []);

  return {
    report,
    running,
    waiting,
    error,
    startedAt,
    authorizeUrl,
    /** Hand this to the save so the server adopts the tokens authorized here. */
    oauthDraftId: report?.ok ? draftId : null,
    /** The tested settings differ from `body`. */
    isStale: (body: TestBody) => testedKey !== null && testedKey !== JSON.stringify(body),
    run,
    reset,
  };
}

export type ConnectionTest = ReturnType<typeof useConnectionTest>;

/** Button label for a fix the form can apply. */
export function fixLabel(fix: TestFix): string {
  switch (fix.kind) {
    case "use_oauth":
      return "Switch to OAuth";
    case "use_http":
      return "Switch to HTTP";
    case "use_sse":
      return "Switch to SSE";
    case "set_token":
      return "Use a bearer token";
    case "add_env":
      return `Add ${fix.name}`;
  }
}

function useElapsed(since: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return since && active ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

const ms = (n?: number) => (n === undefined ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

function StepRow({ step, authorizeUrl }: { step: TestStep; authorizeUrl: string | null }) {
  return (
    <div className="grid grid-cols-[16px_1fr_auto] items-baseline gap-2 text-[12.5px]">
      <span className="flex justify-center self-center">
        {step.status === "ok" ? (
          <Check size={13} strokeWidth={3} className="text-ok" />
        ) : step.status === "fail" ? (
          <X size={13} strokeWidth={3} className="text-err" />
        ) : step.status === "waiting" ? (
          <span className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        ) : (
          <Minus size={12} className="text-faint" />
        )}
      </span>
      <span className={cn("min-w-0", step.status === "skip" && "text-faint")}>
        {step.label}
        {step.detail && <span className="block text-xs break-words text-muted-fg">{step.detail}</span>}
        {step.status === "waiting" && authorizeUrl && (
          <span className="block text-xs text-muted-fg">
            Popup blocked or closed?{" "}
            <a href={authorizeUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              Open the consent page
            </a>
          </span>
        )}
      </span>
      <span className="font-mono text-[11px] text-faint">{ms(step.ms)}</span>
    </div>
  );
}

/**
 * The result panel: header, the steps as they went, the tools found, and on failure stderr and
 * the likely fix. `onFix` applies a fix to the form; without one the hint stands alone.
 */
export function TestPanel({
  test,
  stale,
  onFix,
  slowHint,
}: {
  test: ConnectionTest;
  stale?: boolean;
  onFix?: (fix: TestFix) => void;
  /** Said while a long test runs (local servers may be downloading). */
  slowHint?: string;
}) {
  const { report, running, waiting, error, authorizeUrl } = test;
  const elapsed = useElapsed(test.startedAt, running || waiting);

  if (error) {
    return <p className="rounded-[10px] bg-err-bg px-3 py-2 text-xs text-err">{error}</p>;
  }
  if (!report && !running) return null;

  const tone = running && !waiting ? "run" : waiting ? "run" : report?.ok ? "ok" : "bad";
  const headline = running ? "Testing…" : report!.headline;
  const shown = running ? null : report;

  return (
    <div
      className={cn("overflow-hidden rounded-[10px] border border-border-soft transition-opacity", stale && !running && "opacity-60")}
      aria-live="polite"
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 text-[12.5px] font-semibold",
          tone === "ok" && "bg-ok-bg text-ok",
          tone === "bad" && "bg-err-bg text-err",
          tone === "run" && "bg-primary-soft text-primary",
        )}
      >
        {tone === "run" ? (
          <RotateCw size={12} className="animate-spin motion-reduce:animate-none" />
        ) : (
          <span className="size-[7px] rounded-full bg-current" />
        )}
        <span className="min-w-0 flex-1 truncate">{headline}</span>
        <span className="font-mono text-[11px] font-normal text-faint">
          {stale && !running ? "settings changed since" : running || waiting ? `${elapsed}s` : ms(report?.ms)}
        </span>
      </div>

      {running && slowHint && elapsed >= 4 && <p className="px-3 pt-2 text-xs text-muted-fg">{slowHint}</p>}

      {shown && (
        <>
          <div className="flex flex-col gap-1.5 px-3 pt-2 pb-2.5">
            {shown.steps.map((s) => (
              <StepRow key={s.key} step={s} authorizeUrl={authorizeUrl} />
            ))}
          </div>

          {shown.tools && shown.tools.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pb-2.5 pl-9">
              {shown.tools.slice(0, 8).map((t) => (
                <span key={t} className="rounded-md border border-border-soft px-1.5 py-px font-mono text-[11px] text-muted-fg">
                  {t}
                </span>
              ))}
              {(shown.counts?.tools ?? 0) > 8 && (
                <span className="px-1 py-px font-mono text-[11px] text-faint">+{(shown.counts?.tools ?? 0) - 8} more</span>
              )}
            </div>
          )}

          {shown.stderr && shown.stderr.length > 0 && (
            <pre className="mx-3 mb-2.5 max-h-40 overflow-auto rounded-lg bg-code-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-fg">
              {shown.stderr.join("\n")}
            </pre>
          )}

          {(shown.hint || shown.fix) && (
            <div className="mx-3 mb-2.5 flex items-center gap-3 rounded-lg bg-panel-2 px-2.5 py-2 text-xs leading-relaxed">
              <span className="min-w-0 flex-1">{shown.hint}</span>
              {shown.fix && onFix && (
                <Button size="sm" onClick={() => onFix(shown.fix!)}>
                  {fixLabel(shown.fix)}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
