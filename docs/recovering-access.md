# Recovering access

If you've lost a password, or sign-in is broken, fix it from the host. Shell access to the machine
already means full access to the data, so these commands need no existing login.

Run them with the same data directory as the server (`DATA_DIR`, see [Configuration](configuration.md#data-directory)).
They are safe to run while the switchboard is running.

Start with `status`: it shows the login mode, the Access config and whether the `admin` user has a
password and an email, which is most of what you need to know about why sign-in is failing.

| What | npx / global install | Docker |
| --- | --- | --- |
| Check the state | `npx @cmer/mcp-switchboard status` | `docker compose exec switchboard node dist/index.js status` |
| Reset a password | `npx @cmer/mcp-switchboard reset-password <username>` | `docker compose exec switchboard node dist/index.js reset-password <username>` |
| Back to password login | `npx @cmer/mcp-switchboard login-mode password` | `docker compose exec switchboard node dist/index.js login-mode password` |
| Help | `npx @cmer/mcp-switchboard --help` | `docker compose exec switchboard node dist/index.js --help` |

With a global install, replace `npx @cmer/mcp-switchboard` with `mcp-switchboard`.

## Reset a password

```bash
npx @cmer/mcp-switchboard reset-password admin
```

It asks for the new password twice, without echoing it, and signs that user out of every browser. In
Docker, `docker compose exec` allocates a terminal by default, which the prompt needs. In a script, pipe the
password in instead:

```bash
printf '%s\n' "$NEW_PASSWORD" | npx @cmer/mcp-switchboard reset-password admin --password-stdin
```

The command fails with a clear message if the username doesn't exist, or if no database is found in the
data directory (which usually means a wrong `DATA_DIR`).

### Another user's password

The Admin doesn't need the command for other people. On the **Users** page, **Reset password** issues a
new one-time setup code (valid 24 hours). The person enters it under **I have a setup code** on the
login page and chooses their own password. The old password stops working and their sessions end, and
the Admin never learns the new password.

### Upgrading from 1.x with sign-in turned off

1.x let you turn sign-in off; 2.0 always requires it. The first start after upgrading prints a line
saying so and removes the old setting. Sign in as `admin` with the password you had before turning
sign-in off. If you've forgotten it, run `reset-password admin` as above.

## Switch back to password login

If [Cloudflare Access](cloudflare-access.md) is misconfigured (wrong team domain, a hostname that
bypasses Access, an email that doesn't match any user), nobody can sign in through the UI. From the host:

```bash
npx @cmer/mcp-switchboard login-mode password
```

Users sign in with a username and password again. Anyone who never chose a password needs a setup code
from the Users page, or `reset-password` above.

In the UI, Settings only switches *to* Cloudflare Access from a request that carries a live Access token,
to catch typos. From the host, `login-mode cloudflare` does it with the values straight from Cloudflare;
see [Command line](configuration.md#command-line).
