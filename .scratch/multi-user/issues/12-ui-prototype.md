# Multi-user UI prototype

Type: prototype
Status: resolved
Blocked by: 06

## Question

What should the multi-user UI look like? Rough screens to react to: login (password and Cloudflare Access modes), Admin's user management (create, disable, delete, reset password, local-commands flag), the share dialog on a server (pick user, see per-recipient usage, revoke), the recipient's "shared with me" list with accept-and-alias, how shared servers sit in the agent switch matrix, the per-user vs instance split on the Settings page, and the Admin's approval queue for stdio requests from other users.

## Answer

Resolved 2026-10-12. Prototype (three `?variant=` takes on `/servers`, in-memory fake users/shares) archived in [prototype/](../prototype/) with screenshots: [A: one list](../prototype/sb-proto-A.png), [B: tabs](../prototype/sb-proto-B.png), [C: people grid](../prototype/sb-proto-C2.png). Removed from `web/src`.

**Servers page: variant A ("One list") wins**
- Pending share offers are banners at the top: "<owner> shared <name> with you", alias field prefilled `<owner>-<slug>`, Accept / Decline.
- One list: own servers first, then received shares. Received rows show the alias, a "from <owner>" badge, status in the recipient's terms ("Waiting for <owner>" when the owner must re-authorize), and Remove. No Edit, Restart, Authorize, or stderr.
- Own servers show a "shared with <users>" badge (hover: per-user call counts) and a **Share** button opening a dialog: one row per other user with usage ("N calls · last used …" / "offered, not accepted yet" / "not shared") and Share / Revoke.
- **Change from the prototype: received shares get an on/off switch too.** It belongs to the recipient and means "offer this share to none of my agents" (the same meaning as the owner's switch on their own servers). It never stops the owner's connection or affects other recipients. Turning it back on restores the recipient's per-agent switches as they were. See the note added to [Share rules](05-share-rules.md).

**Agents page**
- Received shares appear in each agent card's server list under their alias with a "from <owner>" badge, after the user's own servers, switched per agent like any other server. A share the recipient switched off (above) shows as off for every agent.

**Users (Admin only)**
- New sidebar item **Users**, visible to the Admin only: list with role, "can run local commands" toggle, Disable, Delete, Reset password. Per-user detail is names and counts only.

**Other screens**
- Login: username above password; in Cloudflare Access mode no form, just "signed in as <email>".
- Settings: two sections, **Yours** (auto-enable new servers, agent server requests, payload capture) and **Instance** (Admin only: instance name, login mode, log retention, max payload size).
- Approval queue: stdio requests escalated from other users appear in the same request panel with a "from <user>" label, showing command, args, and env var names only.
- Sidebar footer: signed-in username and Log out.
