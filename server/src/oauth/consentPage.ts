/**
 * The agent-OAuth approval page. Server-rendered, because it lives on the MCP listener, which
 * serves no SPA — and it has to work on a public hostname where the admin UI isn't reachable.
 */

export interface ConsentView {
  /** Self-asserted by the client at registration — anyone can call themselves "Claude". */
  clientName: string | null;
  /** Where the approval is sent: the one part of the request an attacker can't dress up. */
  redirectHost: string;
  redirectIsLoopback: boolean;
  /** The agent named by the client's `resource` parameter, when it sent one. */
  agentSlug: string | null;
  /** Every authorize parameter, echoed back as hidden fields so the POST can re-validate them. */
  params: Record<string, string>;
  error?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --panel: #fff; --fg: #1d1d1b; --muted: #6b6b66;
  --border: #e3e3df; --primary: #2f6fed; --err: #c2382f; --code: #f1f1ee; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --panel: #1b1b1b; --fg: #ececea;
  --muted: #9a9a95; --border: #2c2c2a; --primary: #6c9bff; --err: #ff7b70; --code: #222220; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--fg); padding: 16px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 440px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 24px; }
h1 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
p { margin: 0 0 14px; color: var(--muted); }
b, code { color: var(--fg); }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code);
  padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere; }
label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
input[type=text] { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--bg); color: var(--fg); font: 15px ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.08em; text-transform: uppercase; }
.dest { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 14px; }
.dest span { display: block; font-size: 12px; color: var(--muted); }
.dest code { font-size: 13.5px; background: none; padding: 0; }
.warn { font-size: 13px; }
.err { color: var(--err); font-size: 13px; margin: 10px 0 0; }
/* Approve comes first in the DOM so Enter submits it; row-reverse still shows it on the right. */
.actions { display: flex; flex-direction: row-reverse; gap: 8px; margin-top: 18px; }
button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--fg); }
button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
`;

export function renderConsentPage(view: ConsentView): string {
  const client = view.clientName ? `A client calling itself <b>${esc(view.clientName)}</b>` : "An unnamed client";
  const target = view.agentSlug ? ` as agent <code>${esc(view.agentSlug)}</code>` : "";
  const loopbackNote = view.redirectIsLoopback
    ? `<p class="warn">This sends access to a program running on the computer you are using right now.</p>`
    : "";
  const hidden = Object.entries(view.params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve connection · MCP Switchboard</title><style>${STYLE}</style></head>
<body><main>
<h1>Connect to MCP Switchboard</h1>
<p>${client} wants to connect${target}.</p>
<div class="dest"><span>Access will be sent to</span><code>${esc(view.redirectHost)}</code></div>
${loopbackNote}
<p>Only continue if you started this connection yourself. To approve, enter a pairing code from the switchboard: <b>Agents → Connection instructions → Claude Desktop</b>.</p>
<form method="post" autocomplete="off">${hidden}
<label for="pairing_code">Pairing code</label>
<input id="pairing_code" name="pairing_code" type="text" placeholder="XXXX-XXXX" autofocus autocapitalize="characters" spellcheck="false">
${view.error ? `<p class="err">${esc(view.error)}</p>` : ""}
<div class="actions">
<button type="submit" name="decision" value="approve" class="primary">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
</main></body></html>`;
}

/** Shown when the request can't safely be bounced back to the client (bad client_id / redirect_uri). */
export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization error · MCP Switchboard</title><style>${STYLE}</style></head>
<body><main><h1>Can't authorize this request</h1><p>${esc(message)}</p></main></body></html>`;
}
