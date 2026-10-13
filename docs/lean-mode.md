# Lean mode

By default an agent's `tools/list` proxies every tool of every server enabled for it, full JSON
Schemas included. With many servers that can be 100+ definitions and tens of thousands of context
tokens per session.

Set an agent's **Tool exposure** to **Lean** (Agents page) and it instead sees a constant-size set of
meta-tools, and discovers what it needs on demand:

1. `switchboard__search_tools { query: "send email" }`: ranked matches over the agent's enabled catalog.
2. `switchboard__describe_tools { names: ["gmail__send_email"] }`: full descriptions, with input and
   output shapes as compact TypeScript.
3. `switchboard__call_tool { name, arguments }`: invoke the tool.

Full mode remains the default and is unchanged. Lean is worth it for agents with large catalogs or
many enabled servers. The per-agent switch matrix still controls what is visible and callable either
way, including servers other users have shared with you (they appear under the alias you gave them),
and the toggle applies to live sessions immediately.
