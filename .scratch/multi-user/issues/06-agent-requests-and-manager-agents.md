# Agent-filed requests and manager agents

Type: grilling
Status: resolved
Blocked by: 03

## Question

With several users, how do the agent-facing management paths work? Specifically: whose approval queue does an agent's `request_server` land in (its owner's; and when does it escalate to the Admin because of the local-command flag)? Who owns a server a manager agent registers directly? What can a manager agent see and change (only its owner's servers? shares received?), and what does `list_servers` return for a recipient's agent? How do request approvals appear to the Admin for a stdio request filed by another user's agent, given the Admin must not see that user's other data?

## Answer

Resolved 2026-10-12.

**Where requests go**
- A remote-server or freeform request from a user's agent lands in **that user's** queue.
- A stdio request lands in the user's own queue if they can run local commands; otherwise it goes **straight to the Admin's queue**. The user still sees it as "waiting for Admin" and can cancel it.
- Unchanged rule: a stdio server is never created from a tool call, whatever the agent's role or the user's flag. A person always approves.
- Requests never cross between users (no "ask Carl to share his Home Assistant"); people ask each other directly.

**What the Admin sees in an escalated stdio request**
- Requesting user, agent, reason, and the command, args, cwd, and env var **names only**, never values.
- On approval the server is created **owned by the requesting user** with their values, and switched on for the requesting agent.

**Ownership**
- A server registered by a manager agent (`switchboard__add_server`) is owned by the agent's owner. Agents never own anything; `createdByAgentSlug` stays as provenance.

**What a manager agent can reach**
- `list_agents`: its owner's agents only.
- `assign_server`: its owner's servers **and received shares** (addressed by alias). Switching a share on per agent is the recipient's call; editing the server is not.
- `server_status` on a received share: status and counts only, **never stderr** (it can carry the owner's data).
- Accepting a share is a human act in the UI only.

**`list_servers` for any agent**
- Received shares appear under their alias with a `sharedBy: "<owner-username>"` field, so the model can tell the owner's account from the user's own.

**Implementation notes for the spec**
- `requests.ts` falls back to finding the requester by agent slug when the id is gone; with per-user slugs that lookup must also match the owning user.
