# Share rules

Type: grilling
Status: resolved
Blocked by: 01

## Question

When an owner shares a server with another user (same live connection, owner's credentials): what does the recipient see and control, how is a share revoked, who re-authenticates when OAuth lapses, who sees the recipient's calls in logs, and can the recipient re-share?

## Answer

Resolved 2026-10-12 while charting the map.

- A share is owner → **user**, not → agent. The recipient switches it on per agent in their own switch matrix, like their own servers. It starts switched off.
- Recipient sees: name, description, status, tool list. Never URL, command, env, headers, or credentials.
- Recipient cannot edit, re-authenticate, or re-share. If the owner's OAuth lapses the recipient sees "waiting for owner"; the owner gets the usual needs-auth flag.
- Revoking is immediate: the recipient's live sessions get `list_changed`; in-flight calls finish. Deleting the server removes all its shares.
- Request-log rows belong to the user whose agent made the call; the owner cannot read the recipient's payloads. The owner does see call count and last-used time per recipient (it's their credentials being used).
- The recipient's manager agents cannot modify a shared server.
- Recipient-side name is an alias; see [Agent endpoints and slug namespaces](01-endpoints-and-slug-namespaces.md).
- Addendum from [Multi-user UI prototype](12-ui-prototype.md): the recipient has their own on/off switch per received share ("offer to none of my agents"). It is recipient-side only: it never stops the owner's connection or affects other recipients. "Cannot edit" still holds for the server itself.
