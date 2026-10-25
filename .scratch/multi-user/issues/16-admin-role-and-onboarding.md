# Admin role and user onboarding

Type: grilling
Status: resolved

## Question

Surfaced while assembling the spec: three gaps no ticket decided. (1) Is there exactly one Admin (the Default user), or can the Admin grant the Admin role to other users (and then: can the Default user's Admin role be removed, and must at least one Admin always exist)? (2) How does a newly created user get their first credential in password mode: the Admin types an initial password and passes it on, or a one-time setup code/link the Admin hands over (no email flows)? In Access mode creation needs only username + email. (3) Who can change what about an existing user: can a user change their own password (today's change-password form) and their own username (renaming breaks their agent URLs), or is renaming Admin-only?

## Answer

Resolved 2026-10-13.

- **Exactly one Admin: the Default user.** The Admin role can't be granted to anyone else. "Can run local commands" stays the one delegable power (a separate per-user flag). Store the role as a value, not a hard-coded identity check, so more Admins could be allowed later without a migration.
- **First credential (password mode): a one-time setup code.** Creating a user produces a single-use code that expires in 24 hours, using the same mechanism as agent pairing codes. The Admin hands it over, and the new user chooses "I have a setup code" on the login page and picks their own password. The Admin never knows anyone's password. **Reset password** on the Users page issues a new setup code the same way, which invalidates the old password and that user's sessions. One flow covers both. In Cloudflare Access mode, creating a user takes only a username and email.
- **Who changes what:**
  - Users change their own password in Settings (password mode).
  - Only the Admin renames a username, with the warning listing the agent URLs that will break.
  - Email stays Admin-only ([Cloudflare Access user provisioning and exposure](14-cloudflare-access-provisioning.md)).
