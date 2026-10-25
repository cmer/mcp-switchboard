# MCP Switchboard

A self-hosted hub where MCP servers are configured once and handed out to coding agents, each of which sees only the servers switched on for it.

## Language

### People

**User**:
A person with their own login and their own servers and agents, invisible to other users; identified by a username, and optionally an email the Admin sets.
_Avoid_: Account, tenant, member

**Admin**:
The Default user's role: managing the other users and the instance-wide settings, without seeing the contents of other users' servers, agents or logs. There is exactly one.
_Avoid_: Superuser, root, owner

**Default user**:
The first user of an install, and on an upgraded install the one all existing data belongs to; it can never be disabled or deleted.
_Avoid_: Legacy user, first user

**Setup code**:
A one-time code the Admin hands to a person so they can choose their own password, both when the user is created and when their password is reset.
_Avoid_: Invite, temporary password, reset link

### Things a user has

**Server**:
An upstream MCP server (local command or remote URL) together with the credentials used to reach it.
_Avoid_: Upstream, integration, connector

**Agent**:
A coding client (Claude Code, Codex, …) that connects to the switchboard with its own endpoint and token.
_Avoid_: Client, consumer

**Manager agent**:
An agent allowed to change its owner's setup itself: register servers and switch servers on or off for its owner's agents.
_Avoid_: Admin agent, privileged agent

**Server request**:
An agent's ask for a server, waiting in a person's queue for approval; it goes to the Admin instead when it would run a local command the owner isn't allowed to run.
_Avoid_: Ticket, proposal

**Owner**:
The user a server or agent belongs to; only the owner can edit it, delete it or change its credentials.
_Avoid_: Creator, author

**Share**:
An owner's grant letting another user's agents use one of the owner's servers through the same connection and with the owner's credentials; the recipient accepts it and can switch it off for their own agents without affecting the owner.
_Avoid_: Copy, clone, template

**Alias**:
The name a recipient gives a server shared with them, used in place of the owner's server name on the recipient's side.
_Avoid_: Nickname, display name, local slug
