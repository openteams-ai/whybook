"""The kernel under Seatbelt, on macOS, through /usr/bin/sandbox-exec.

It was written from Codex's profiles and research/kernel-sandbox.md; its
tests run on macOS in .github/workflows/sandbox.yml.

The profile is Codex's base profile and its read-only platform defaults
(codex/, Apache-2.0, at a pinned commit): everything is denied, then the
system's libraries and settings may be read. Whybook's rules follow. The
kernel may read the Python environment and map its libraries, read and write
the notebook's folder, the cache folder and the private folder, and bind and
reach Unix sockets in the private folder only. No rule allows the network, so
the kernel reaches no address, 127.0.0.1 included. Seatbelt applies the last
rule that matches, so the denies come after the allows.

Paths go into the profile as parameters (`-DNAME=path`), as Codex passes them,
so that no path needs quoting in the profile's language.
"""

from __future__ import annotations

import os
from pathlib import Path

from .policy import OTHER_KERNEL, Policy, SandboxUnavailable, is_within, plan_binds, symlink_chain

NAME = "Seatbelt"
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
# A profile mounts nothing: the kernel sees the private folder at its own path.
PRIVATE_INSIDE = None
CODEX = Path(__file__).with_name("codex")
CODEX_PROFILES = ("seatbelt_base_policy.sbpl", "seatbelt_read_only_platform_defaults.sbpl")

# Reads of the system beyond Codex's platform defaults: /usr/local and Homebrew
# hold libraries that environments link to, matplotlib reads the system's fonts,
# and /bin/sh reads its link in /private/var/select.
SYSTEM_READ = ("/usr", "/opt/homebrew", "/System/Library/Fonts", "/Library/Fonts", "/private/var/select")
# Where the kernel may map native code from, besides the frameworks and
# /usr/lib of Codex's defaults, and the Python environment.
SYSTEM_EXEC = ("/usr", "/opt/homebrew")


def find(configured: str) -> str:
    """The sandbox-exec executable, or SandboxUnavailable when it is missing."""
    if os.access(configured, os.X_OK):
        return configured
    raise SandboxUnavailable(
        f"The sandboxed kernel needs {configured}, the command that runs a program under a macOS sandbox "
        f"profile, and this Mac does not have it. {OTHER_KERNEL}"
    )


class _Params:
    """The -D parameters of the profile, one name per path."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def __call__(self, prefix: str, path: Path) -> str:
        for name, value in self.values.items():
            if value == str(path) and name.startswith(prefix + "_"):
                return f'(param "{name}")'
        name = f"{prefix}_{sum(key.startswith(prefix + '_') for key in self.values)}"
        self.values[name] = str(path)
        return f'(param "{name}")'


def _rule(head: str, filters: list[str]) -> str:
    if not filters:
        return ""
    return "\n".join([f"({head}", *(f"  {item}" for item in filters)]) + ")"


def profile(policy: Policy) -> tuple[str, dict[str, str]]:
    """The profile's text and its parameters."""
    param = _Params()
    binds = plan_binds(policy.read_write, policy.read_only)
    writable = [path for path, mode in binds if mode == "rw"]
    readable = [path for path, mode in binds if mode == "ro"]

    # The folders above each path: their metadata only, so that the kernel can
    # resolve its paths (os.path.realpath stats every folder on the way).
    ancestors = sorted(
        {parent for path in readable + writable for parent in path.parents if parent != Path("/")},
        key=lambda path: (len(path.parts), path.as_posix()),
    )
    links = sorted(
        {
            location
            for path in [*policy.read_only, *policy.read_write, policy.workdir, Path(policy.executable)]
            for _, location in symlink_chain(path)[0]
        },
        key=lambda path: path.as_posix(),
    )

    # Parts of the Python environment inside a writable folder, such as a .venv
    # in the notebook's folder: no writes there, and the folders between the two
    # cannot be renamed, which would carry the environment out of its rule.
    protected: list[Path] = []
    unmovable: set[Path] = set()
    for path in readable:
        roots = [root for root in writable if is_within(path, root)]
        if not roots:
            continue
        protected.append(path)
        root = max(roots, key=lambda item: len(item.parts))
        unmovable.update(parent for parent in path.parents if root in parent.parents)

    private = param("PRIVATE", policy.private)
    home = param("ANCESTOR", policy.home)
    sections = [(CODEX / name).read_text() for name in CODEX_PROFILES]
    sections += [
        "; Whybook: the kernel's sandbox, from whybook/sandbox/seatbelt.py.",
        "; Codex's rule for /System/Volumes/Data/Users lists two filters, and a rule",
        "; applies when any of its filters matches: it allows the metadata of every",
        "; directory. Nothing in the home folder: the rules below allow what the kernel needs.",
        f"(deny file-read-metadata file-test-existence (subpath {home}))",
        "; The system.",
        _rule("allow file-read* file-test-existence", [f'(subpath "{path}")' for path in SYSTEM_READ]),
        _rule("allow file-map-executable", [f'(subpath "{path}")' for path in SYSTEM_EXEC]),
        "; The Python environment: read, and map its native libraries.",
        _rule(
            "allow file-read* file-test-existence file-map-executable",
            [f"(subpath {param('READ', path)})" for path in readable],
        ),
        "; The notebook's folder, the cache folder and the private folder.",
        _rule(
            "allow file-read* file-test-existence file-write*",
            [f"(subpath {param('WRITE', path)})" for path in writable],
        ),
        "; The folders above those paths, and the links on the way to them.",
        _rule(
            "allow file-read-metadata file-test-existence",
            [f"(literal {param('ANCESTOR', path)})" for path in ancestors],
        ),
        _rule("allow file-read*", [f"(literal {param('LINK', path)})" for path in links]),
        "; The Python environment stays read-only inside a writable folder.",
        _rule("deny file-write*", [f"(subpath {param('READ', path)})" for path in protected]),
        *(
            "(deny file-write-unlink (require-all (vnode-type DIRECTORY) "
            f"(literal {param('UNMOVABLE', path)})))"
            for path in sorted(unmovable, key=lambda item: item.as_posix())
        ),
        "; Unix sockets in the private folder, where the kernel listens; no other network.",
        "(allow system-socket (socket-domain AF_UNIX))",
        f"(allow network-bind network-inbound (local unix-socket (subpath {private})))",
        f"(allow network-outbound (remote unix-socket (subpath {private})))",
        "; As Codex ends its profile (codex-rs/sandboxing/src/seatbelt.rs at the same commit):",
        "; no XPC services, and no fcntl that writes through a read-only descriptor.",
        '(deny mach-lookup (xpc-service-name-prefix ""))',
        "(deny system-fcntl (fcntl-command 80 110))",
    ]
    return "\n".join(section for section in sections if section) + "\n", param.values


def command(sandbox_exec: str, policy: Policy) -> list[str]:
    """The sandbox-exec arguments that go before the kernel's own command."""
    text, params = profile(policy)
    return [sandbox_exec, "-p", text, *(f"-D{name}={value}" for name, value in params.items()), "--"]


def diagnose(stderr: str, sandbox_exec: str) -> str:
    """Why sandbox-exec failed, from its error."""
    error = next((line.strip() for line in stderr.splitlines() if line.strip()), "no message")
    if "sandbox_apply" in stderr:
        return (
            "The sandboxed kernel cannot start: macOS refused to apply the sandbox profile. It refuses when the "
            "Jupyter server itself runs in a sandbox, because macOS does not nest them: start JupyterLab from a "
            f"terminal outside other sandboxes. sandbox-exec's error: {error}. {OTHER_KERNEL}"
        )
    return f"sandbox-exec could not start the sandboxed kernel: {error}"
