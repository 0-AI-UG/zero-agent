#!/usr/bin/env python3
"""Landlock availability probe — run INSIDE the prod zero-server container.

Landlock is the one filesystem-sandbox primitive that fits zero-server's
constraints: it needs no Linux capabilities and no user namespace (the two
things the capless-root + apparmor-userns-restricted OCD host denies), only
PR_SET_NO_NEW_PRIVS, which the hardened container already sets. See the
project memory `project_bash_sandbox_infeasible` for why bubblewrap can't run.

This probe answers the single gating question: can a process in this exact
container (same kernel, seccomp profile, and caps as the agent's bash) use
Landlock at all? It calls landlock_create_ruleset(NULL, 0, VERSION), which
returns the supported ABI version without changing anything.

Run it where bash actually executes:

    ocd ssh server-2 --server          # real root on the host
    docker exec <zero-server-container> python3 /app/scripts/landlock-probe.py

Interpreting the result:
  - "Landlock ABI vN"        -> WORKS. Implement the Landlock bash wrapper.
                                ABI>=1 covers read/write FS containment (enough
                                to block cross-project access); ABI>=3 adds
                                truncate, ABI>=4 adds TCP rules (not needed here).
  - errno ENOSYS (38)        -> kernel too old / Landlock not compiled in.
  - errno EOPNOTSUPP (95)    -> Landlock present but disabled at boot
                                (lsm= line / CONFIG). Fixable host-side.
  - errno EPERM/EACCES (1/13)-> a seccomp filter is blocking landlock_* syscalls.
                                Needs the OCD seccomp profile to allow them.
"""

import ctypes, ctypes.util, errno, os, sys

# Generic syscall number, identical on x86_64 and arm64.
SYS_landlock_create_ruleset = 444
LANDLOCK_CREATE_RULESET_VERSION = 1  # query-ABI flag

libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)

# Also report whether the LSM is even listed, for a clearer diagnosis.
try:
    with open("/sys/kernel/security/lsm") as f:
        lsms = f.read().strip()
    print(f"active LSMs: {lsms}")
    print(f"landlock listed in LSMs: {'landlock' in lsms.split(',')}")
except OSError as e:
    print(f"could not read /sys/kernel/security/lsm: {e}")

try:
    with open("/proc/version") as f:
        print("kernel:", f.read().split(' (')[0].strip())
except OSError:
    pass

ctypes.set_errno(0)
abi = libc.syscall(SYS_landlock_create_ruleset, None, ctypes.c_size_t(0),
                   ctypes.c_uint(LANDLOCK_CREATE_RULESET_VERSION))
err = ctypes.get_errno()

if abi >= 1:
    print(f"\nRESULT: Landlock ABI v{abi} — USABLE in this container. Proceed.")
    sys.exit(0)

name = errno.errorcode.get(err, str(err))
print(f"\nRESULT: landlock_create_ruleset failed (errno {err} {name}) — NOT usable.")
if err == errno.ENOSYS:
    print("  -> Kernel has no Landlock. Need a newer host kernel (>=5.13).")
elif err == errno.EOPNOTSUPP:
    print("  -> Landlock compiled but disabled. Enable via host lsm= boot param.")
elif err in (errno.EPERM, errno.EACCES):
    print("  -> Likely seccomp-blocked. OCD seccomp profile must allow landlock_*.")
sys.exit(1)
