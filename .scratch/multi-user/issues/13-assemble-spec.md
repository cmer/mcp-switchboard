# Assemble the multi-user spec

Type: task
Status: resolved
Blocked by: 06, 09, 10, 11, 12, 14, 15, 16

## Question

Fold every resolved ticket in this map into one implementation-ready spec at `.scratch/multi-user/spec.md`: data model changes, auth and routing, sharing, runtime partitioning, migration, UI, and the CHANGELOG-worthy user-visible changes. Nothing is decided here; anything found missing goes back on the map as a new ticket.

## Comments

- 2026-10-12: Draft written to [spec.md](../spec.md) from every resolved ticket. Assembly surfaced one gap, filed as [Admin role and user onboarding](16-admin-role-and-onboarding.md); spec sections marked "⚠ open" wait on it. Close this ticket once that resolves and the ⚠ markers are replaced.

## Answer

Resolved 2026-10-13. The spec is at [spec.md](../spec.md): 15 sections, each citing the ticket that holds its decision. The one gap found during assembly became [Admin role and user onboarding](16-admin-role-and-onboarding.md) and is folded in. The final read-through only tightened consequences of existing decisions:
- persisted setup-code hash and expiry on `users` (a 24h code must survive restarts)
- `role` as a text value
- disabled users can't sign in
- rename added to the Admin's permissions
- the CLI `reset-password` sets a password directly, because shell access is already full access

No open markers remain.
