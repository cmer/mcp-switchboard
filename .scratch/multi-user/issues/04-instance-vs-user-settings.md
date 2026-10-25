# Instance vs per-user settings

Type: grilling
Status: resolved

## Question

Each existing global setting must become either instance-wide (Admin only) or per-user. Which is which?

## Answer

Resolved 2026-10-12 while charting the map.

| Setting | Scope | Why |
|---|---|---|
| `instanceName`, login mode, log retention hours, max payload KB | Instance (Admin) | Govern the host and disk, not anyone's data |
| `autoEnableNewServers` | Per user | Only touches that user's own agent switches |
| `allowServerRequests` | Per user | Each user approves their own agents' requests |
| `capturePayloads` | Per user | Privacy choice about the user's own traffic |
| `authDisabled` | Instance, only while exactly one user exists | No login means no way to know who you are |
- **Revised 2026-10-13 (after implementation): turning sign-in off was removed entirely; sign-in is always required. A 1.x install that had it off gets a startup message to sign in as `admin` with the old password or run `mcp-switchboard reset-password admin`.**
