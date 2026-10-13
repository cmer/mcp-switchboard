# User lifecycle

Type: grilling
Status: resolved
Blocked by: 02, 05

## Question

How are users created, disabled, and deleted, and what happens to their servers, agents, logs, and shares in each case?

## Answer

Resolved 2026-10-12 while charting the map.

- Only the Admin creates, disables, and deletes users (no self-signup).
- **Disabled**: the user's agents are refused, and the user's servers are shut down entirely, so anything they shared goes dark for recipients too (otherwise their credentials would still be in use).
- **Deleted**: removes their servers, agents, logs, requests, and the shares they received. Servers they had shared disappear for recipients (`list_changed` fan-out).
- Exception (from [Routing and agent OAuth under per-user endpoints](11-routing-and-agent-oauth.md)): the Default user can be neither disabled nor deleted.
