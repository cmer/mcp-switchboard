# Agent endpoints and slug namespaces

Type: grilling
Status: resolved

## Question

How are agents and servers addressed once there are several users: are agent and server slugs unique per instance or per user, what URL does an agent connect to, and how is a shared server named on the recipient's side so it can't clash with the recipient's own servers?

## Answer

Resolved 2026-10-12 while charting the map.

- Endpoint is `/mcp/<username>/<agent-slug>`. Agent slugs are unique **per user**.
- The old `/mcp/<agent-slug>` URL stays working permanently and resolves to the **Default user**'s agent; existing tokens are unchanged.
- Server slugs are unique per user. A shared server gets an **alias** on the recipient's side, defaulting to `<owner-username>-<server-slug>` (e.g. `carl-gmail`, so tools read `carl-gmail__send`), editable by the recipient when accepting. Single dash, not `--`: `__` is already the tool separator and the alias stays within the existing slug rule `^[a-z0-9-]{1,64}$`.
- Consequence: a slug collision between an owner's server and a recipient's server cannot happen, since the alias is the recipient's to choose.
- Usernames therefore need the same slug rule (they appear in the URL and in default aliases).
