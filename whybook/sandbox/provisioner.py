"""The kernel provisioner `whybook-sandbox`: the kernelspec's command, run under the system's own sandbox.

jupyter_client finds it by its entry point in the group
`jupyter_client.kernel_provisioners` (pyproject.toml), and starts it for a
kernelspec whose `metadata.kernel_provisioner.provisioner_name` names it, as
"Python 3 (sandboxed)" does (jupyter-config/kernels/python3-sandboxed), and as
the copies of other kernelspecs that `python -m whybook.sandbox` writes do
(kernelspec.py).

Before each start, and each restart, it:

1. finds the system's sandbox: bubblewrap on Linux, sandbox-exec on macOS;
2. moves the connection file and the kernel's sockets into a private folder of
   its own, with the IPC transport, so that the kernel needs no network and
   cannot read other kernels' connection files or the server's token;
3. finds where the kernel lives, which becomes the read-only part of the
   sandbox. A kernel that runs Python gives its prefixes and its import path,
   editable installs included. Any other kernel gives the environment around
   its executable, the folder above its `bin` folder, where conda and pixi
   keep the libraries, and an R kernel also gives the folders that R names as
   its home and its libraries. The absolute paths in the kernel's argv and in
   the kernelspec's `env`, and the provisioner's `read_only` setting, add to
   them;
4. clears the environment down to a short list, which drops every key or
   token of the server. jupyter_client then adds JPY_PARENT_PID. On Linux,
   bubblewrap's --clearenv drops it too: in a new PID namespace the kernel's
   parent is process 1, and ipykernel would take the server for gone and
   exit. On macOS there is no PID namespace, and the variable lets the kernel
   exit with the server, as --die-with-parent does on Linux;
5. runs the kernel's Python once in the sandbox, or for another kernel checks
   that its executable is there, so that a sandbox that cannot start raises
   an error with the cause and the fix, where the kernel would otherwise die
   at once.

A kernelspec's argv may start with "python": jupyter_client replaces that word
with the Jupyter server's own interpreter (KernelManager.format_kernel_cmd), as
it does for ipykernel's own kernelspec, so the kernel runs in the environment
that Whybook is installed in.

An interrupt by signal reaches the kernel inside the sandbox: on Linux the
provisioner sends it to the sandbox's own process group, since a SIGINT to
bubblewrap would end bubblewrap and the kernel with it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from jupyter_client.provisioning import LocalProvisioner
from traitlets import List, Unicode, default

from . import bwrap, seatbelt
from .policy import OTHER_KERNEL, Policy, SandboxUnavailable, is_within, resolved, shared_folders

# The environment the kernel keeps from the server's, besides what the
# kernelspec's own "env" sets: the language, the time zone, the user's name,
# and the notebook's path, which the Jupyter server passes.
PASSED = ("LANG", "LANGUAGE", "TZ", "USER", "LOGNAME", "JPY_SESSION_NAME")
PASSED_PREFIXES = ("LC_",)

# A Unix socket's path holds at most 107 bytes on Linux and 103 on macOS.
SOCKET_PATH_LIMIT = 103 if sys.platform == "darwin" else 107

# Asks the kernel's Python where it lives. It runs outside the sandbox, in "/",
# so that no file that a kernel wrote can take the place of a module it imports.
PROBE = (
    "import importlib.util, json, sys\n"
    "print(json.dumps({'prefixes': [sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix],"
    " 'path': sys.path, 'ipykernel': importlib.util.find_spec('ipykernel') is not None}))"
)

OTHER_SYSTEMS = (
    "The sandboxed kernel runs on Linux, with bubblewrap, and on macOS, with sandbox-exec. On Windows, run "
    f"JupyterLab inside WSL2, where the Linux sandbox applies. {OTHER_KERNEL}"
)

# A kernel whose command starts with one of these runs Python, and the probe
# above can ask it where it lives: python, python3, python3.12.
PYTHON_NAME = re.compile(r"python(\d+(\.\d+)?)?")

# Asks R where it lives: its home and its libraries, the user's own library
# in the home folder among them when it exists. Rscript runs outside the
# sandbox, in "/", and reads neither ~/.Rprofile nor ~/.Renviron, which the
# kernel does not see in the sandbox either.
R_PROBE = 'cat(R.home(), .libPaths(), sep = "\\n")'

# The kernel's own connection file, in the private folder, where the sandbox
# mounts that folder at another path (bwrap.PRIVATE_INSIDE).
INSIDE_CONNECTION_FILE = "kernel-in-sandbox.json"

# What checks, in the sandbox, that the kernel's executable is there and can run.
CHECK_EXECUTABLE = 'test -x "$0" || { echo "$0 is not in the sandbox, or cannot run there" >&2; exit 1; }'


def runs_python(executable: str) -> bool:
    """Whether the kernel's command starts with a Python interpreter."""
    return PYTHON_NAME.fullmatch(os.path.basename(executable)) is not None


def environment_of(executable: str) -> list[str]:
    """The kernel's executable and the environment around it: the folder above its bin folder.

    A conda or pixi environment keeps a kernel's libraries there, and R keeps
    R_HOME there: `<env>/bin/xr` gives `<env>`. The executable's real place
    counts too, when it is a link into another environment.
    """
    found = [executable]
    for path in (Path(executable), resolved(executable)):
        if path.parent.name == "bin" and str(path.parent.parent) not in found:
            found.append(str(path.parent.parent))
    return found


def _default_cache_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "whybook" / "kernel-sandbox"


def _private_roots() -> list[Path]:
    """Where the private folders go: Jupyter's runtime folder, else a folder of this user's in the temporary folder."""
    from jupyter_core.paths import jupyter_runtime_dir

    return [
        Path(jupyter_runtime_dir()) / "whybook-sandbox",
        Path(tempfile.gettempdir()) / f"whybook-sandbox-{os.getuid()}",
    ]


def make_private_folder() -> Path:
    """A new folder, readable by this user alone, for one kernel's connection file and sockets."""
    for root in _private_roots():
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = root.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            continue  # a folder that someone else owns or can write
        folder = resolved(tempfile.mkdtemp(prefix="k", dir=root))
        # The sockets are named <folder>/k-1 to k-5, or higher while old ones are left.
        if len(os.fsencode(str(folder / "k-99"))) <= SOCKET_PATH_LIMIT:
            for name in ("ipython", "tmp"):
                (folder / name).mkdir(mode=0o700)
            return folder
        folder.rmdir()
    raise SandboxUnavailable(
        f"The sandboxed kernel cannot start: the path of its sockets would be longer than {SOCKET_PATH_LIMIT} "
        f"bytes in {_private_roots()[0]}. Set JUPYTER_RUNTIME_DIR to a shorter folder."
    )


class SandboxProvisioner(LocalProvisioner):
    """Runs the kernelspec's command under bubblewrap on Linux and under Seatbelt on macOS.

    The kernel reads and writes the notebook's folder at its own path, reads
    its own environment (Python's, or R's), and writes a cache folder of its
    own, where matplotlib keeps its font cache. It cannot read any other part
    of the home folder, has no network, and gets a short environment. The
    connection file and the kernel's Unix sockets live in a private folder,
    kept across a restart and removed when the kernel stops.
    """

    cache_dir = Unicode(
        config=True,
        help="A folder that sandboxed kernels read and write, kept between kernels: matplotlib's font cache.",
    )
    bwrap_path = Unicode("bwrap", config=True, help="The bubblewrap executable, a name on the PATH or a path.")
    sandbox_exec_path = Unicode(seatbelt.SANDBOX_EXEC, config=True, help="macOS's sandbox-exec.")
    read_only = List(
        Unicode(),
        config=True,
        help=(
            "More paths that the kernel reads, besides the environment that the provisioner finds, such as a "
            "Julia depot. A kernelspec sets them in metadata.kernel_provisioner.config.read_only; ~ is the home folder."
        ),
    )

    @default("cache_dir")
    def _cache_dir_default(self) -> str:
        return str(_default_cache_dir())

    _private: Path | None = None

    def _backend(self):
        """The module of this system's sandbox and its executable."""
        if sys.platform.startswith("linux"):
            return bwrap, bwrap.find(self.bwrap_path)
        if sys.platform == "darwin":
            return seatbelt, seatbelt.find(self.sandbox_exec_path)
        raise SandboxUnavailable(OTHER_SYSTEMS)

    async def pre_launch(self, **kwargs: Any) -> dict[str, Any]:
        backend, tool = self._backend()
        home = Path.home()
        workdir = Path(os.path.abspath(kwargs.get("cwd") or os.getcwd()))
        if resolved(workdir) in shared_folders(home):
            raise SandboxUnavailable(
                f"The sandboxed kernel mounts the notebook's folder, and this notebook is directly in {workdir}, "
                "which holds the home folder or files of other programs. Move the notebook into a folder of its own."
            )
        runtime = _private_roots()[0].parent
        if is_within(resolved(runtime), resolved(workdir)):
            raise SandboxUnavailable(
                f"The sandboxed kernel mounts the notebook's folder, and {workdir} holds Jupyter's runtime folder "
                f"{runtime}, with the server's token and the connection files of other kernels. "
                "Move the notebook into a folder of its own."
            )
        created = self._private is None
        if self._private is None:
            self._private = make_private_folder()
        try:
            return await self._prepare(backend, tool, home, workdir, kwargs)
        except BaseException:
            if created:
                self._remove_private()
            raise

    async def _prepare(self, backend, tool: str, home: Path, workdir: Path, kwargs: dict[str, Any]) -> dict[str, Any]:
        private = self._private
        assert private is not None
        km = self.parent
        if km is not None:
            km.transport = "ipc"
            km.cache_ports = False
            km.connection_file = str(private / "kernel.json")
            km.ip = str(private / "k")
        kwargs = await super().pre_launch(**kwargs)
        cmd: list[str] = kwargs["cmd"]
        server_env: dict[str, str] = kwargs.get("env") or {}
        # The sandbox has a PATH of its own, so the command starts from its full path.
        executable = cmd[0] = self._executable(cmd[0], server_env)
        # Where the kernel sees the private folder: at a short path under bubblewrap.
        inside = backend.PRIVATE_INSIDE or private

        cache = Path(self.cache_dir).expanduser()
        (cache / "matplotlib").mkdir(mode=0o700, parents=True, exist_ok=True)
        env = self._kernel_env(server_env, home, executable, inside, cache)

        python = runs_python(executable)
        if python:
            runs_ipykernel = any(arg in ("ipykernel", "ipykernel_launcher") for arg in cmd)
            where = await self._probe(executable, env, runs_ipykernel)
            found = [*where["prefixes"], *where["path"], executable]
        else:
            found = environment_of(executable)
            if (self.kernel_spec.language or "").lower() == "r":
                found += await self._probe_r(executable, env)
        found += self._named_paths(cmd[1:], env, private)
        found += [os.path.expanduser(path) for path in self.read_only]
        read_only = self._readable(found, home)
        if resolved(workdir) in {resolved(path) for path in read_only}:
            self.log.warning(
                "The notebook's folder %s is on the kernel's import path, so the sandbox mounts it read-only: "
                "a kernel that could write there could change code that the Jupyter server imports.",
                workdir,
            )

        if inside != private:
            cmd = self._connect_inside(cmd, private, inside)

        policy = Policy(
            workdir=workdir,
            read_write=[workdir, cache, private],
            read_only=read_only,
            private=private,
            home=home,
            env=env,
            executable=executable,
            private_inside=None if inside == private else inside,
        )
        prefix = backend.command(tool, policy)
        if python:
            check = [executable, "-I", "-S", "-c", ""]
        else:
            check = ["/bin/sh", "-c", CHECK_EXECUTABLE, executable]
        await self._check(backend, tool, prefix, check, env, workdir)
        self.log.info(
            "Starting the kernel in a sandbox (%s), with the notebook's folder %s read-write",
            backend.NAME,
            workdir,
        )
        kwargs["cmd"] = prefix + cmd
        kwargs["env"] = env
        return kwargs

    def _connect_inside(self, cmd: list[str], private: Path, inside: Path) -> list[str]:
        """The kernel's command with a connection file of its own, which names the sockets where the kernel sees them.

        jupyter_client's connection file, kernel.json, keeps the paths of the
        host, for the Jupyter server and any other client outside the sandbox.
        A Unix socket is found by its file, so the kernel's socket at
        /run/kernel/k-1 is the server's at <private folder>/k-1.
        """
        host = private / "kernel.json"
        info = json.loads(host.read_text())
        info["ip"] = str(inside / Path(info["ip"]).name)
        own = private / INSIDE_CONNECTION_FILE
        descriptor = os.open(own, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as file:
            json.dump(info, file, indent=2)
        seen = str(inside / INSIDE_CONNECTION_FILE)
        return [arg.replace(os.path.realpath(host), seen).replace(str(host), seen) for arg in cmd]

    def _executable(self, command: str, server_env: dict[str, str]) -> str:
        """The full path of the kernel's command, found on the server's PATH when the kernelspec names it alone."""
        if os.path.isabs(command):
            return command
        found = shutil.which(command, path=server_env.get("PATH"))
        if found is None:
            raise SandboxUnavailable(
                f'The sandboxed kernel runs "{command}", which is not on the PATH of the Jupyter server. '
                f"Give its full path in the kernelspec's argv. {OTHER_KERNEL}"
            )
        return os.path.abspath(found)

    def _named_paths(self, argv: list[str], env: dict[str, str], private: Path) -> list[str]:
        """The absolute paths in the kernel's arguments and in what the kernelspec's env sets, R_HOME among them.

        The connection file, in the private folder, is left out: that folder is read-write.
        """
        paths = [arg for arg in argv if os.path.isabs(arg)]
        for key in self.kernel_spec.env:
            paths += [part for part in env.get(key, "").split(os.pathsep) if os.path.isabs(part)]
        return [path for path in paths if not is_within(resolved(path), resolved(private))]

    def _readable(self, found: list[str], home: Path) -> list[Path]:
        """The paths that exist, less those that would show the home folder, Jupyter's runtime folder or other programs' files."""
        shared = shared_folders(home)
        runtime = resolved(_private_roots()[0].parent)
        read_only: list[Path] = []
        for entry in found:
            if not entry or not os.path.isabs(entry) or not os.path.exists(entry):
                continue
            real = resolved(entry)
            if real in shared or is_within(runtime, real):
                self.log.warning(
                    "The sandboxed kernel does not mount %s: it holds the home folder, Jupyter's runtime folder "
                    "or files of other programs.",
                    entry,
                )
                continue
            read_only.append(Path(entry))
        return read_only

    def _kernel_env(
        self, server_env: dict[str, str], home: Path, executable: str, private: Path, cache: Path
    ) -> dict[str, str]:
        """The kernel's environment: a short list, and no other variable of the server's.

        `private` is the private folder where the kernel sees it.
        """
        env = {
            key: value
            for key, value in server_env.items()
            if key in PASSED or key.startswith(PASSED_PREFIXES)
        }
        # What the kernelspec itself sets, after jupyter_client filled it in.
        env.update({key: server_env[key] for key in self.kernel_spec.env if key in server_env})
        system_path = "/usr/bin:/bin:/usr/sbin:/sbin" if sys.platform == "darwin" else "/usr/local/bin:/usr/bin:/bin"
        env.update(
            {
                "HOME": str(home),
                "PATH": f"{os.path.dirname(executable)}:{system_path}",
                "IPYTHONDIR": str(private / "ipython"),
                "MPLCONFIGDIR": str(cache / "matplotlib"),
                # fontconfig keeps its cache there, which R's first plot and
                # matplotlib's text need: 1.0 to 1.6 s at each start without it.
                "XDG_CACHE_HOME": str(cache),
            }
        )
        if sys.platform == "darwin":
            # There is no private /tmp as on Linux: temporary files go to the private folder.
            env["TMPDIR"] = str(private / "tmp")
        else:
            env.setdefault("LANG", "C.UTF-8")
        return env

    async def _probe(self, python: str, env: dict[str, str], needs_ipykernel: bool = True) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [python, "-c", PROBE],
                env=env,
                cwd="/",
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SandboxUnavailable(f"The sandboxed kernel runs Python kernels, and {python} did not run: {error}") from error
        try:
            where = json.loads(result.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            error = (result.stderr.strip().splitlines() or ["no output"])[-1]
            raise SandboxUnavailable(
                f"The sandboxed kernel runs Python kernels, and {python} did not run as Python: {error}"
            ) from None
        if needs_ipykernel and not where["ipykernel"]:
            raise SandboxUnavailable(
                f"The sandboxed kernel runs ipykernel, which is not installed for {python}: "
                f"install it with {python} -m pip install ipykernel."
            )
        return where

    async def _probe_r(self, executable: str, env: dict[str, str]) -> list[str]:
        """R's home and libraries, as the Rscript next to the kernel gives them; none when no Rscript answers.

        The user's own library, such as ~/R/x86_64-pc-linux-gnu-library/4.4,
        is where install.packages() puts IRkernel on a system R, and R lists
        it only when it exists. The kernel still starts without the probe
        when its environment holds everything, as a pixi or conda one does.
        """
        candidates = [Path(env["R_HOME"]) / "bin" / "Rscript"] if env.get("R_HOME") else []
        candidates.append(Path(executable).parent / "Rscript")
        on_path = shutil.which("Rscript", path=env.get("PATH"))
        if on_path:
            candidates.append(Path(on_path))
        rscript = next((path for path in candidates if os.access(path, os.X_OK)), None)
        if rscript is None:
            self.log.warning("The sandboxed kernel found no Rscript beside %s to ask R for its libraries.", executable)
            return []
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [str(rscript), "--no-init-file", "--no-environ", "-e", R_PROBE],
                env=env,
                cwd="/",
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            self.log.warning("The sandboxed kernel could not ask %s for R's libraries: %s", rscript, error)
            return []
        if result.returncode != 0:
            self.log.warning("The sandboxed kernel could not ask %s for R's libraries: %s", rscript, result.stderr.strip())
            return []
        return [line for line in result.stdout.splitlines() if os.path.isabs(line)]

    async def _check(
        self, backend, tool: str, prefix: list[str], check: list[str], env: dict[str, str], workdir: Path
    ) -> None:
        """Run the check in the sandbox once, and turn a failure into a message with what to install or set."""
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [*prefix, *check],
                env=env,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SandboxUnavailable(f"{backend.NAME} could not start the sandboxed kernel: {error}") from error
        if result.returncode != 0:
            raise SandboxUnavailable(backend.diagnose(result.stderr, tool))

    async def send_signal(self, signum: int) -> None:
        """Send a signal to the kernel inside the sandbox; SIGTERM and SIGKILL end the sandbox itself.

        jupyter_client signals the process group of the process it started,
        which on Linux is bubblewrap. bubblewrap handles no SIGINT, so an
        interrupt would end it, and --die-with-parent would end the kernel.
        So a signal other than those two goes to the sandbox's own process
        group, where the kernel runs. On macOS, sandbox-exec becomes the
        kernel's own process, and a signal goes as for any kernel.
        """
        group = None
        if signum not in (signal.SIGTERM, signal.SIGKILL) and self.pid and sys.platform.startswith("linux"):
            group = bwrap.sandbox_group(self.pid)
        if group is None:
            await super().send_signal(signum)
            return
        os.killpg(group, signum)

    async def cleanup(self, restart: bool = False) -> None:
        await super().cleanup(restart=restart)
        if not restart:
            self._remove_private()

    def _remove_private(self) -> None:
        if self._private is not None:
            shutil.rmtree(self._private, ignore_errors=True)
            self._private = None
