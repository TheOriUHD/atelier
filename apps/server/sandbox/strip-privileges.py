#!/usr/bin/env python3
"""Run once while the sandbox image is built (apps/server/Dockerfile, target sandbox).

The accounts' Unix users are kept apart by the operating system, which only holds if a login cannot become another user.
Nothing in the image may therefore carry the setuid or setgid bit or file capabilities (su, mount, passwd, ssh-agent and
the like come with them by default). This removes them and fails the build if any is left.
"""
import os
import stat
import sys

SKIP = ("/proc", "/sys", "/dev")
CAPABILITY = "security.capability"
root_dev = os.lstat("/").st_dev
stripped = []
left = []

for top, dirs, files in os.walk("/"):
    dirs[:] = [d for d in dirs if not os.path.join(top, d).startswith(SKIP) and os.lstat(os.path.join(top, d)).st_dev == root_dev]
    for name in files:
        path = os.path.join(top, name)
        mode = os.lstat(path).st_mode
        if not stat.S_ISREG(mode):
            continue
        if mode & (stat.S_ISUID | stat.S_ISGID):
            os.chmod(path, mode & ~(stat.S_ISUID | stat.S_ISGID))
            stripped.append(path)
        try:
            if CAPABILITY in os.listxattr(path, follow_symlinks=False):
                os.removexattr(path, CAPABILITY, follow_symlinks=False)
                stripped.append(path)
        except OSError:
            pass

for top, dirs, files in os.walk("/"):
    dirs[:] = [d for d in dirs if not os.path.join(top, d).startswith(SKIP) and os.lstat(os.path.join(top, d)).st_dev == root_dev]
    for name in files:
        path = os.path.join(top, name)
        mode = os.lstat(path).st_mode
        if stat.S_ISREG(mode) and mode & (stat.S_ISUID | stat.S_ISGID):
            left.append(path)
        try:
            if CAPABILITY in os.listxattr(path, follow_symlinks=False):
                left.append(path)
        except OSError:
            pass

print("removed setuid, setgid or file capabilities from %d programs" % len(stripped))
if left:
    print("still privileged: " + ", ".join(left), file=sys.stderr)
    sys.exit(1)
