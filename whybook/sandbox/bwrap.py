"""The kernel under bubblewrap, on Linux.

bubblewrap starts from an empty root and shows only what its arguments bind
("the level of protection between the sandboxed processes and the host system
is entirely determined by the arguments passed to bubblewrap", its README).
Here that is the system (`/usr`, `/etc`), the Python environment read-only, and
the notebook's folder, the cache folder and the private folder read-write. The
home folder and `/tmp` are empty, in memory. The kernel gets new user, PID,
network, IPC, UTS and cgroup namespaces: its network is its own loopback, so it
reaches the Jupyter server only through the Unix sockets in the private folder.
research/kernel-sandbox.md has the check this follows.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .policy import OTHER_KERNEL, Policy, SandboxUnavailable, is_within, plan_binds, resolved, symlink_chain

NAME = "bubblewrap"

# Folders of the system, read-only in every sandbox; the ones after /usr and
# /etc only when they exist. The top-level folders that merged-/usr systems make
# symbolic links into /usr are recreated as links.
SYSTEM = (Path("/usr"), Path("/etc"))
OPTIONAL_SYSTEM = (Path("/nix/store"),)
MERGED_USR = ("bin", "sbin", "lib", "lib32", "lib64", "libx32")

INSTALL = (
    "sudo apt install bubblewrap on Debian and Ubuntu, sudo dnf install bubblewrap on Fedora, "
    "sudo pacman -S bubblewrap on Arch"
)

# Where the kernel sees its private folder. A kernel of the xeus family
# (xeus-zmq 4.0.0: xeus-r, xeus-python, xeus-cpp) reads each socket's address
# back into 32 bytes, so it stops with "Invalid argument" when "ipc://" and
# the socket's path take more: a path of at most 25 characters works, such as
# /run/kernel/k-1, where Jupyter's runtime folder gives 60 or more.
PRIVATE_INSIDE = Path("/run/kernel")


def find(configured: str) -> str:
    """The bubblewrap executable, or SandboxUnavailable with the commands that install it."""
    found = shutil.which(configured)
    if found is None:
        raise SandboxUnavailable(
            f"The sandboxed kernel needs bubblewrap, and {configured} is not installed. "
            f"Install the package bubblewrap ({INSTALL}), then start the kernel again. {OTHER_KERNEL}"
        )
    return found


def command(bwrap: str, policy: Policy) -> list[str]:
    """The bubblewrap arguments that go before the kernel's own command."""
    argv = [bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
    system = list(SYSTEM)
    made: set[Path] = set()
    argv += ["--ro-bind", "/usr", "/usr"]
    for name in MERGED_USR:
        path = Path("/") / name
        if path.is_symlink():
            argv += ["--symlink", os.readlink(path), str(path)]
            made.add(path)
        elif path.is_dir():
            argv += ["--ro-bind", str(path), str(path)]
            system.append(path)
    argv += ["--ro-bind", "/etc", "/etc"]
    for path in OPTIONAL_SYSTEM:
        if path.is_dir():
            argv += ["--ro-bind", str(path), str(path)]
            system.append(path)
    argv += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    if policy.home != Path("/"):
        argv += ["--tmpfs", str(policy.home)]

    read_write = policy.read_write
    if policy.private_inside is not None:
        read_write = [path for path in read_write if resolved(path) != resolved(policy.private)]
    binds = plan_binds(read_write, policy.read_only, tuple(system))
    for path, mode in binds:
        argv += ["--bind" if mode == "rw" else "--ro-bind", str(path), str(path)]
    if policy.private_inside is not None:
        argv += ["--bind", str(policy.private), str(policy.private_inside)]

    # The links on the way to each path, where no bind shows them: the path of
    # a virtual environment is often a link, and so is the notebook's folder.
    shown = system + [path for path, _ in binds]
    for path in [*policy.read_only, *read_write, policy.workdir, Path(policy.executable)]:
        for target, location in symlink_chain(path)[0]:
            if location in made or any(is_within(location, root) and location != root for root in shown):
                continue
            argv += ["--symlink", target, str(location)]
            made.add(location)

    argv += ["--chdir", str(policy.workdir), "--clearenv"]
    for key, value in policy.env.items():
        argv += ["--setenv", key, value]
    argv.append("--")
    return argv


def sandbox_group(pid: int) -> int | None:
    """The process group in which the kernel runs, inside the sandbox that bubblewrap `pid` started; None before it runs.

    With --unshare-pid, bubblewrap forks a child that is process 1 of the new
    PID namespace, and --new-session makes that child lead a session and a
    process group of its own. The kernel runs in that group, and so do the
    processes it starts. Process 1 of a namespace takes no signal from outside
    it without a handler, which bubblewrap's does not install: a SIGINT to the
    group reaches the kernel alone.
    """
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            stat = Path(entry.path, "stat").read_text()
        except OSError:
            continue
        # The command's name may hold spaces and parentheses: the fields follow the last ")".
        fields = stat[stat.rindex(")") + 2 :].split()
        if int(fields[1]) == pid:
            return int(fields[2])
    return None


def _sysctl(name: str) -> str | None:
    try:
        return Path("/proc/sys", *name.split(".")).read_text().strip()
    except OSError:
        return None


def diagnose(stderr: str, bwrap: str) -> str:
    """Why bubblewrap failed, and what to install or set, from its error and the kernel's settings."""
    sysctl = _sysctl
    error = next((line.strip() for line in stderr.splitlines() if line.strip()), "no message")
    denied = any(word in stderr for word in ("Permission denied", "Operation not permitted", "namespace"))
    if denied and sysctl("kernel.unprivileged_userns_clone") == "0":
        return (
            "The sandboxed kernel cannot start: this system turns off unprivileged user namespaces "
            "(kernel.unprivileged_userns_clone = 0), which bubblewrap needs. An administrator can turn them on: "
            f"sudo sysctl -w kernel.unprivileged_userns_clone=1. bubblewrap's error: {error}. {OTHER_KERNEL}"
        )
    if denied and sysctl("user.max_user_namespaces") == "0":
        return (
            "The sandboxed kernel cannot start: this system allows no user namespaces "
            "(user.max_user_namespaces = 0), which bubblewrap needs. An administrator can allow them: "
            f"sudo sysctl -w user.max_user_namespaces=15000. bubblewrap's error: {error}. {OTHER_KERNEL}"
        )
    if denied and sysctl("kernel.apparmor_restrict_unprivileged_userns") == "1":
        real = os.path.realpath(bwrap)
        return (
            "The sandboxed kernel cannot start: this system restricts unprivileged user namespaces with AppArmor "
            "(kernel.apparmor_restrict_unprivileged_userns = 1), as Ubuntu 24.04 does, so bubblewrap cannot set up "
            "the sandbox. An administrator can allow bubblewrap once, with an AppArmor profile: "
            f'echo "abi <abi/4.0>, profile bwrap {real} flags=(unconfined) {{ userns, }}" '
            "| sudo tee /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap. "
            "Or they can lift the restriction for every program: "
            "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0. "
            f"bubblewrap's error: {error}. {OTHER_KERNEL}"
        )
    return f"bubblewrap could not start the sandboxed kernel: {error}"
