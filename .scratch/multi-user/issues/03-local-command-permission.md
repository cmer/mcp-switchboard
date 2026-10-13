# Who may run local commands

Type: grilling
Status: resolved

## Question

A stdio server runs an arbitrary command as the switchboard's OS user, which can read `secret.key` and decrypt every user's secrets. Who may add one?

## Answer

Resolved 2026-10-12 while charting the map.

- A per-user **"can run local commands"** flag, only settable by the Admin. The Admin always has it.
- A user without it who adds a stdio server (by hand, by paste-import, or via an agent) files it to the Admin's approval queue instead, reusing the existing server-request flow.
- This is an acknowledged trust boundary, not a sandbox: granting the flag is equivalent to granting access to every user's secrets. Hard isolation is out of scope (trusted household).
