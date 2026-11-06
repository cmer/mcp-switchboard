#!/usr/bin/env node
// Builds docker/seccomp.json: Docker's default seccomp profile plus the handful of syscalls
// bubblewrap needs to build a sandbox inside the container (a user namespace, its own mounts and
// pivot_root). Docker only allows those to containers holding CAP_SYS_ADMIN, which we don't want to
// grant; every other default restriction stays as it is.
//
//   curl -sL https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json -o /tmp/default.json
//   node scripts/seccomp-profile.mjs /tmp/default.json > docker/seccomp.json
import fs from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/seccomp-profile.mjs <moby default.json>");
  process.exit(1);
}
const profile = JSON.parse(fs.readFileSync(source, "utf8"));

const BWRAP = ["clone", "unshare", "mount", "umount2", "pivot_root"];

profile.syscalls = profile.syscalls
  // The flag-masked `clone` rules only exist to refuse namespace flags without CAP_SYS_ADMIN;
  // an unconditional allow below replaces them.
  .filter((rule) => !(rule.names.length === 1 && rule.names[0] === "clone" && rule.args?.length))
  .map((rule) => {
    if (rule.includes?.caps?.includes("CAP_SYS_ADMIN") && rule.action === "SCMP_ACT_ALLOW") {
      return { ...rule, names: rule.names.filter((n) => !BWRAP.includes(n)) };
    }
    return rule;
  });
profile.syscalls.push({
  names: BWRAP,
  action: "SCMP_ACT_ALLOW",
  comment: "mcp-switchboard: bubblewrap sandboxes for stdio servers",
});

process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
