# Local server sandbox

A local (stdio) server is a program the switchboard starts on its own host: usually an npm or PyPI
package fetched by `npx` or `uvx`. Without a sandbox it runs as the switchboard's own user. It could
read `secret.key` and the database, which together decrypt every user's stored credentials, and it
could read the environment of every other local server.

So every local server runs in an OS sandbox. Inside it, the server sees:

- the system directories (`/usr`, `/etc`, and the Node and `uv` installs), read-only
- its own folder, read-write. This is its `HOME` and `TMPDIR`, where npm and uv keep their caches
- any host paths the Admin listed for it
- nothing else: no data directory, no other server's folder, no switchboard code

The network is left alone. Servers reach the APIs they wrap exactly as before, and so can still reach
your LAN and services on the host.

## Platforms

| Where the switchboard runs | Sandbox | What it hides |
| --- | --- | --- |
| Docker (the provided `docker-compose.yml`) | bubblewrap | Everything above. Each server also gets its own process, IPC and hostname namespaces, so it can't see the switchboard or other servers' processes. |
| Linux, installed with npm | bubblewrap (`apt install bubblewrap`) | Same as Docker. |
| macOS, installed with npm | Seatbelt (`sandbox-exec`, built in) | The data directory, the other servers' folders and your home directory. A server can still read other files your user can read, and the command line and environment of other processes running as you. |
| Anything else | none | Local servers only start with the sandbox turned off. |

If the sandbox is on but unavailable, local servers don't start. Each one shows the reason as its
error, and so does **Settings → Local servers**. They never quietly run unsandboxed.

## Docker

bubblewrap needs a user namespace. Docker's defaults refuse one, so `docker-compose.yml` sets three
security options:

```yaml
security_opt:
  - seccomp=./docker/seccomp.json
  - systempaths=unconfined
  - apparmor=unconfined
```

- `docker/seccomp.json` is Docker's default seccomp profile plus only the syscalls bubblewrap uses
  (`clone` with namespace flags, `unshare`, `mount`, `umount2`, `pivot_root`). Every other default
  restriction stays. `scripts/seccomp-profile.mjs` regenerates it from a newer Docker default.
- `systempaths=unconfined` lifts Docker's masks on parts of `/proc`. The kernel won't let bubblewrap
  mount a fresh `/proc` for a server while they're in place.
- `apparmor=unconfined`: Docker's default AppArmor profile blocks the mounts bubblewrap makes.

The container starts as root only to hand the data directory to the `node` user. The switchboard
then runs as `node` with no capabilities.

If you run the image yourself, pass the same three options, for example
`--security-opt seccomp=docker/seccomp.json --security-opt systempaths=unconfined --security-opt apparmor=unconfined`.

### Ubuntu 23.10 and later

These releases also restrict user namespaces at the host level, which stops bubblewrap even inside
the container. Debian doesn't. Check on the host:

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns
```

If it prints `1`, turn the restriction off and keep it off after a reboot:

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-mcp-switchboard-userns.conf
sudo sysctl --system
```

## Host paths

Some servers need files on the host, for example a filesystem or git server. On the Admin's own local
servers, **Edit** shows a **Host paths** box, with one directory per line:

```
/srv/projects
/srv/notes:rw
```

Each one is mounted at the same path inside the server's sandbox: read-only, or writable with `:rw`. A
host path can't be `/`, and it can't overlap the data directory or the sandbox folders. A server's
**working directory**, if set, has to be inside one of its host paths.

Under Docker, a host directory first has to be mounted into the container, in your compose override,
before you can list it here.

## Turning it off

- **For one server:** on the Admin's own servers, **Edit → Run without the sandbox**. This is for the
  rare server that can't work sandboxed. Prefer host paths.
- **For everyone:** **Settings → Local servers**. Running servers restart into the new setting.

Both are the Admin's alone. Running without the sandbox means trusting the software with every user's
credentials, so servers that run that way show a **no sandbox** badge.

## Where the server folders live

`SANDBOX_DIR` sets where each server's folder is created as `server-<id>`. It defaults to
`$XDG_CACHE_HOME/mcp-switchboard/sandboxes` (or `~/.cache/mcp-switchboard/sandboxes`), and the Docker
image sets it to `/app/sandboxes`. The folders hold caches and whatever state a server keeps for
itself. In Docker they're rebuilt with the container, as they were before; mount a volume at
`/app/sandboxes` if a server's own state matters to you.

## What the sandbox doesn't do

- **It doesn't restrict the network.** A server can reach anything the switchboard can, including
  your LAN and abstract Unix sockets in the same network namespace (with `network_mode: host`, the
  host's).
- **It doesn't hide a server's own secrets.** A server needs its own environment variables to work.
- **It isn't a separate kernel.** A kernel exploit reachable from inside a user namespace could still
  escape it.
