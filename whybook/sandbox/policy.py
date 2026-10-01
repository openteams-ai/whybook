"""What the sandbox lets the kernel reach, whichever system sandbox enforces it.

The provisioner fills a `Policy`; `bwrap.py` turns it into bubblewrap's
arguments on Linux, and `seatbelt.py` into a Seatbelt profile on macOS.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

# The last sentence of every message about a sandbox that cannot run here.
OTHER_KERNEL = "Pick another kernel to run without a sandbox."


class SandboxUnavailable(RuntimeError):
    """The sandbox cannot start the kernel here; the message gives the cause and what to install or set.

    Each message is one paragraph without line breaks: the Jupyter server shows
    it in the "Error Starting Kernel" dialog, and when a notebook changes its
    kernel it shows the message through repr(), where a line break would read
    as a literal backslash and n.
    """


@dataclass
class Policy:
    """What the kernel reaches. Any other path is out of its sight, or read-only as part of the system."""

    # The notebook's folder, as the Jupyter server gives it: the kernel starts there.
    workdir: Path
    # Read-write: the notebook's folder, the cache folder and the private folder.
    read_write: list[Path]
    # Read-only: the Python environment (its prefixes and its import path).
    read_only: list[Path]
    # The connection file and the kernel's Unix sockets.
    private: Path
    home: Path
    env: dict[str, str]
    # The kernel's command, argv[0].
    executable: str
    # Where the kernel sees the private folder, when the sandbox mounts it at
    # another path than its own; None mounts it at its own path.
    private_inside: Path | None = None


def is_within(path: Path, root: Path) -> bool:
    """Whether `path` is `root` or lies inside it (both absolute and resolved)."""
    return path == root or root in path.parents


def symlink_chain(path: str | os.PathLike[str]) -> tuple[list[tuple[str, Path]], Path]:
    """The symbolic links met on the way to `path`, and the path they lead to.

    Each link is (its target as written, its location). A location is itself
    resolved: a link inside a folder that is reached through another link is
    named by its real place. `/home/me/.pyenv/versions/env/bin/python` gives
    the link `versions/env`, then `bin/python` inside the real folder of the
    environment, and so on to the interpreter.
    """
    links: list[tuple[str, Path]] = []
    current = Path("/")
    pending = list(Path(os.path.abspath(path)).parts[1:])
    hops = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            current = current.parent
            continue
        candidate = current / part
        if not candidate.is_symlink():
            current = candidate
            continue
        hops += 1
        if hops > 40:
            raise OSError(f"Too many symbolic links on the way to {path}")
        target = os.readlink(candidate)
        links.append((target, candidate))
        # The target starts from the folder of the link, which is resolved.
        pending = list((current / target).parts[1:]) + pending
        current = Path("/")
    return links, current


def resolved(path: str | os.PathLike[str]) -> Path:
    return symlink_chain(path)[1]


def plan_binds(
    read_write: list[Path], read_only: list[Path], system: tuple[Path, ...] = ()
) -> list[tuple[Path, str]]:
    """The folders to bind, as (resolved path, "rw" or "ro"), parents before children.

    A path that an earlier bind already shows with the same mode is left out,
    and so is one inside a read-only folder of the system. The Python
    environment stays read-only where it lies inside a writable folder, such as
    a `.venv` inside the notebook's folder, and where it is the same folder:
    a kernel that could write there could change code that the Jupyter server
    imports at its next start.
    """
    wanted: dict[Path, str] = {}
    for path in read_write:
        wanted.setdefault(resolved(path), "rw")
    for path in read_only:
        wanted[resolved(path)] = "ro"
    plan: list[tuple[Path, str]] = []
    for path, mode in sorted(wanted.items(), key=lambda item: (len(item[0].parts), item[0].as_posix())):
        covering = [(root, "ro") for root in system if is_within(path, root)]
        covering += [(root, kind) for root, kind in plan if is_within(path, root)]
        if covering and max(covering, key=lambda item: len(item[0].parts))[1] == mode:
            continue
        plan.append((path, mode))
    return plan


def shared_folders(home: Path) -> list[Path]:
    """Folders that must never be the notebook's folder: the home folder and those that other programs share.

    Mounting one of them would show the kernel the whole home folder, or the
    sockets of other programs, such as an SSH agent's under /tmp.
    """
    folders = [Path("/"), Path("/tmp"), Path("/var/tmp"), Path(tempfile.gettempdir())]
    folders += [home, *home.parents]
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        folders.append(Path(runtime))
    return sorted({resolved(folder) for folder in folders})
