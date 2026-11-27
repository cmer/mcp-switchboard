# Lean mode

In full mode an agent's `tools/list` proxies every tool of every server enabled for it, full JSON
Schemas included. With many servers that can be 100+ definitions and tens of thousands of context
tokens per session.

In lean mode (**Tool exposure** on the Agents page) it instead sees a constant-size set of
meta-tools, and discovers what it needs on demand:

1. `switchboard__search_tools { query: "send email" }`: ranked matches over the agent's enabled catalog.
2. `switchboard__describe_tools { names: ["gmail__send_email"] }`: full descriptions, with input and
   output shapes as compact TypeScript.
3. `switchboard__call_tool { name, arguments }`: invoke the tool.

New agents start in lean mode; agents created before lean became the default keep full mode until
you switch them. Pick Full for an agent that needs every schema up front. The per-agent switch
matrix still controls what is visible and callable either way, including servers other users have
shared with you (they appear under the alias you gave them), and the toggle applies to live sessions
immediately.
