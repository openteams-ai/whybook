"""The sandboxed kernel (whybook/sandbox/), started through jupyter_client as the Jupyter server starts it.

The kernels come from the kernelspec that the package installs,
jupyter-config/kernels/python3-sandboxed, and run under bubblewrap on Linux
and under Seatbelt on macOS. The tests that start one skip when the system's
sandbox cannot run on this machine; the others check the arguments, the
profile and the messages on any system.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from importlib.metadata import EntryPoint
from pathlib import Path
from types import SimpleNamespace

import pytest
import zmq
from jupyter_client import KernelManager, MultiKernelManager
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.provisioning.factory import KernelProvisionerFactory
from traitlets.config import Config

from whybook.sandbox import SandboxUnavailable, bwrap, kernelspec, seatbelt
from whybook.sandbox.policy import Policy, symlink_chain
from whybook.sandbox.provisioner import CHECK_EXECUTABLE, INSIDE_CONNECTION_FILE

REPO = Path(__file__).resolve().parents[3]
KERNELS = REPO / "jupyter-config" / "kernels"
NAME = "python3-sandboxed"
ENTRY_POINT = "whybook.sandbox:SandboxProvisioner"
GROUP = "jupyter_client.kernel_provisioners"


def cannot_sandbox() -> str | None:
    """Why the system's sandbox cannot run on this machine, or None."""
    if sys.platform.startswith("linux"):
        found = shutil.which("bwrap")
        if found is None:
            return "bubblewrap is not installed"
        run = subprocess.run(
            [found, "--unshare-all", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"],
            capture_output=True,
            text=True,
        )
        return f"bubblewrap cannot run here: {run.stderr.strip()}" if run.returncode else None
    if sys.platform == "darwin":
        if not os.access(seatbelt.SANDBOX_EXEC, os.X_OK):
            return "this Mac has no sandbox-exec"
        run = subprocess.run(
            [seatbelt.SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"], capture_output=True, text=True
        )
        return f"sandbox-exec cannot run here: {run.stderr.strip()}" if run.returncode else None
    return "the sandbox runs on Linux and macOS"


def r_kernelspec() -> tuple[str, Path] | None:
    """An installed R kernelspec that runs without a provisioner, such as xeus-r's xr, and its folder; None without one.

    On this machine xeus-r's kernelspec is found through JUPYTER_PATH (TESTING.md).
    """
    for name, folder in sorted(KernelSpecManager().find_kernel_specs().items()):
        try:
            spec = json.loads((Path(folder) / "kernel.json").read_text())
        except (OSError, ValueError):
            continue
        if (spec.get("language") or "").lower() == "r" and "kernel_provisioner" not in (spec.get("metadata") or {}):
            return name, Path(folder)
    return None


CANNOT = cannot_sandbox()
needs_sandbox = pytest.mark.skipif(CANNOT is not None, reason=f"No sandbox: {CANNOT}")
R_KERNEL = r_kernelspec()
needs_r = pytest.mark.skipif(
    CANNOT is not None or R_KERNEL is None,
    reason=f"No sandbox: {CANNOT}" if CANNOT else "No R kernelspec: see TESTING.md for xeus-r and JUPYTER_PATH",
)
macos = pytest.mark.skipif(sys.platform != "darwin" or CANNOT is not None, reason="Seatbelt runs on macOS")
linux = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="bubblewrap runs on Linux")


@pytest.fixture(scope="module", autouse=True)
def provisioner():
    """The provisioner by its entry point's name, also in an install whose metadata predates it.

    `pip install -e .` registers it; test_pyproject_registers_the_provisioner
    checks that pyproject.toml gives the same name the same class.
    """
    factory = KernelProvisionerFactory.instance()
    added = not factory._check_availability("whybook-sandbox")
    if added:
        factory.provisioners["whybook-sandbox"] = EntryPoint("whybook-sandbox", ENTRY_POINT, GROUP)
    yield
    if added:
        factory.provisioners.pop("whybook-sandbox", None)


@pytest.fixture(scope="module")
def folders():
    """A notebook's folder inside the real home folder, beside a file that the kernel must not read.

    The runtime folder, where the private folders go, and the cache folder
    are temporary ones with short paths, so that no test writes to the user's
    own folders.
    """
    base = Path.home() / ".cache"
    base.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(dir=base, prefix="whybook-sandbox-test-"))
    runtime = Path(tempfile.mkdtemp(prefix="wbrt"))
    cache = Path(tempfile.mkdtemp(prefix="wbcache"))
    notebook = root / "analysis"
    notebook.mkdir()
    (root / "secret.txt").write_text("not for the kernel")
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("JUPYTER_RUNTIME_DIR", str(runtime))
        yield SimpleNamespace(root=root, notebook=notebook, runtime=runtime, cache=cache)
    for folder in (root, runtime, cache):
        shutil.rmtree(folder, ignore_errors=True)


class Sandboxed:
    """A kernel of a sandboxed kernelspec, started as the Jupyter server starts one, and a blocking client.

    By default the kernelspec is "Python 3 (sandboxed)"; `kernels` and `name`
    give another one, such as the sandboxed copy of an R kernelspec.
    """

    def __init__(self, folders, kernels: Path = KERNELS, name: str = NAME, **config):
        spec = KernelSpecManager(kernel_dirs=[str(kernels)])
        settings = Config({"SandboxProvisioner": {"cache_dir": str(folders.cache), **config}})
        self.manager = MultiKernelManager(kernel_spec_manager=spec, config=settings)
        self.log = (folders.runtime / "kernel.log").open("ab")
        # What a Jupyter server passes: its own environment and the notebook's path.
        env = {**os.environ, "OPENAI_API_KEY": "sk-not-a-real-key", "JPY_SESSION_NAME": str(folders.notebook / "a.ipynb")}
        kernel_id = self.manager.start_kernel(
            kernel_name=name, cwd=str(folders.notebook), env=env, stdout=self.log, stderr=self.log
        )
        self.km = self.manager.get_kernel(kernel_id)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)

    def control(self, msg_type: str, content: dict) -> dict:
        msg = self.kc.session.msg(msg_type, content)
        self.kc.control_channel.send(msg)
        while True:
            reply = self.kc.control_channel.get_msg(timeout=30)
            if reply["parent_header"].get("msg_id") == msg["header"]["msg_id"]:
                return reply["content"]

    def send(self, code: str, subshell: str | None = None) -> str:
        content = {"code": code, "silent": False, "store_history": False, "user_expressions": {}, "allow_stdin": False}
        msg = self.kc.session.msg("execute_request", content)
        msg["header"]["subshell_id"] = subshell
        self.kc.shell_channel.send(msg)
        return msg["header"]["msg_id"]

    def collect(self, msg_ids: list[str], timeout: float = 30) -> dict[str, dict]:
        out = {m: {"stdout": "", "status": None, "idle": False, "error": None} for m in msg_ids}
        deadline = time.monotonic() + timeout
        poller = zmq.Poller()
        poller.register(self.kc.iopub_channel.socket, zmq.POLLIN)
        poller.register(self.kc.shell_channel.socket, zmq.POLLIN)
        while any(o["status"] is None or not o["idle"] for o in out.values()):
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"No reply in {timeout} s")
            for sock, _ in poller.poll(left * 1000):
                while True:
                    _, msg = self.kc.session.recv(sock, mode=zmq.NOBLOCK)
                    if msg is None:
                        break
                    o = out.get(msg["parent_header"].get("msg_id"))
                    if o is None:
                        continue
                    kind = msg["msg_type"]
                    if kind == "stream" and msg["content"]["name"] == "stdout":
                        o["stdout"] += msg["content"]["text"]
                    elif kind == "error":
                        o["error"] = msg["content"]["ename"]
                    elif kind == "status" and msg["content"]["execution_state"] == "idle":
                        o["idle"] = True
                    elif kind == "execute_reply":
                        o["status"] = msg["content"]["status"]
        return out

    def run(self, code: str, timeout: float = 30) -> dict:
        (only,) = self.collect([self.send(code)], timeout).values()
        return only

    def json(self, code: str) -> dict:
        """Runs code whose last line prints JSON, and returns it."""
        result = self.run(code)
        assert result["status"] == "ok", result
        return json.loads(result["stdout"].strip().splitlines()[-1])

    def close(self) -> None:
        self.kc.stop_channels()
        self.manager.shutdown_all(now=True)
        self.log.close()


@pytest.fixture(scope="module")
def kernel(folders):
    if CANNOT is not None:
        pytest.skip(f"No sandbox: {CANNOT}")
    started = Sandboxed(folders)
    yield started
    started.close()


def private_folders(folders) -> set[Path]:
    return set((folders.runtime / "whybook-sandbox").glob("k*"))


def attempt(code: str) -> str:
    """Code that runs a statement and prints what happened, as ok or the error's name."""
    return f"try:\n    {code}\n    print('ok')\nexcept OSError as e:\n    print(type(e).__name__)"


@needs_sandbox
def test_runs_code_in_the_notebooks_folder_and_writes_there(kernel, folders):
    result = kernel.run("import os\nprint(os.getcwd())\nopen('from-kernel.txt', 'w').write('written in the sandbox')")
    assert result["status"] == "ok"
    # The same path for the kernel and for the Jupyter server.
    assert result["stdout"].strip() == str(folders.notebook)
    assert (folders.notebook / "from-kernel.txt").read_text() == "written in the sandbox"


@needs_sandbox
def test_sees_no_other_part_of_the_home_folder(kernel, folders):
    secret = folders.root / "secret.txt"
    assert kernel.run(attempt(f"open({str(secret)!r}).read()"))["stdout"].strip() in (
        "FileNotFoundError",
        "PermissionError",
    )
    # A write beside the notebook's folder never reaches the home folder: on
    # Linux it goes to the sandbox's own home folder, in memory; on macOS it is denied.
    kernel.run(attempt(f"open({str(folders.root / 'beside.txt')!r}, 'w').write('x')"))
    kernel.run(attempt(f"open({str(secret)!r}, 'a').write('changed')"))
    assert not (folders.root / "beside.txt").exists()
    assert secret.read_text() == "not for the kernel"
    # Folders that hold keys, when this home folder has them.
    private = [name for name in (".ssh", ".claude", ".gnupg", ".config", ".bash_history") if (Path.home() / name).exists()]
    seen = kernel.json(f"import json, os\nprint(json.dumps([os.path.exists(os.path.expanduser('~/' + n)) for n in {private!r}]))")
    assert not any(seen)


@needs_sandbox
def test_the_python_environment_is_read_only(kernel):
    result = kernel.run("import os, sysconfig\n" + attempt("open(os.path.join(sysconfig.get_paths()['purelib'], 'x.txt'), 'w')"))
    assert result["stdout"].strip() in ("OSError", "PermissionError"), result


@needs_sandbox
def test_has_no_network(kernel):
    # A port on the host's loopback, where a Jupyter server or a model server may listen.
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        code = "import socket\n" + attempt(f"socket.create_connection(('127.0.0.1', {port}), timeout=3)")
        assert kernel.run(code)["stdout"].strip() in ("ConnectionRefusedError", "PermissionError")
    finally:
        listener.close()
    if sys.platform.startswith("linux"):
        interfaces = kernel.json("import json, socket\nprint(json.dumps([n for _, n in socket.if_nameindex()]))")
        assert interfaces == ["lo"]


@needs_sandbox
def test_has_none_of_the_servers_variables(kernel, folders):
    env = kernel.json("import json, os\nprint(json.dumps(dict(os.environ)))")
    assert "OPENAI_API_KEY" not in env
    # ipykernel exits when JPY_PARENT_PID names a process that is not its parent,
    # as the server's process is not inside a PID namespace.
    if sys.platform.startswith("linux"):
        assert "JPY_PARENT_PID" not in env
    assert env["JPY_SESSION_NAME"] == str(folders.notebook / "a.ipynb")
    kept = {"HOME", "PATH", "LANG", "USER", "LOGNAME", "TZ", "JPY_SESSION_NAME", "JPY_PARENT_PID", "IPYTHONDIR"}
    kept |= {"MPLCONFIGDIR", "XDG_CACHE_HOME", "TMPDIR", "PWD"}  # PWD from bubblewrap
    # What ipykernel sets itself.
    kept |= {"CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "GIT_PAGER", "MPLBACKEND", "PAGER", "PYDEVD_USE_FRAME_EVAL", "TERM"}
    assert set(env) - kept - {key for key in env if key.startswith("LC_")} == set()


@needs_sandbox
def test_matplotlib_keeps_its_cache_in_the_cache_folder(kernel, folders):
    code = "import os\nd = os.environ['MPLCONFIGDIR']\nprint(d)\nopen(os.path.join(d, 'check'), 'w').write('x')"
    result = kernel.run(code)
    assert result["stdout"].strip() == str(folders.cache / "matplotlib")
    assert (folders.cache / "matplotlib" / "check").exists()


@needs_sandbox
def test_two_subshells_run_at_once(kernel):
    info = kernel.kc.kernel_info(reply=True, timeout=30)["content"]
    assert "kernel subshells" in info.get("supported_features", [])
    first = kernel.control("create_subshell_request", {})["subshell_id"]
    second = kernel.control("create_subshell_request", {})["subshell_id"]
    try:
        code = "import threading, time\ntime.sleep(1)\nprint(threading.current_thread() is threading.main_thread())"
        start = time.perf_counter()
        replies = kernel.collect([kernel.send(code, first), kernel.send(code, second)])
        took = time.perf_counter() - start
    finally:
        for subshell in (first, second):
            kernel.control("delete_subshell_request", {"subshell_id": subshell})
    assert [reply["status"] for reply in replies.values()] == ["ok", "ok"]
    assert [reply["stdout"].strip() for reply in replies.values()] == ["False", "False"]
    assert took < 1.8, f"two sleeps of 1 s took {took:.2f} s"


@needs_sandbox
def test_an_interrupt_stops_a_running_cell(kernel):
    msg_id = kernel.send("import time\ntime.sleep(30)")
    time.sleep(1)
    start = time.perf_counter()
    kernel.km.interrupt_kernel()
    result = kernel.collect([msg_id], timeout=15)[msg_id]
    assert (result["status"], result["error"]) == ("error", "KeyboardInterrupt")
    assert time.perf_counter() - start < 5
    assert kernel.km.is_alive()
    assert kernel.run("print(6 * 7)")["stdout"].strip() == "42"


@needs_sandbox
def test_a_restart_keeps_the_sandbox_and_a_shutdown_removes_its_folder(folders):
    started = Sandboxed(folders)
    try:
        connection = started.km.connection_file
        private = Path(connection).parent
        assert private.parent == folders.runtime / "whybook-sandbox"
        assert started.run("x = 1")["status"] == "ok"
        started.km.restart_kernel(now=True)
        started.kc.wait_for_ready(timeout=60)
        # The same private folder and connection file; the variables are gone.
        assert started.km.connection_file == connection
        assert started.run(attempt("x"))["error"] == "NameError"
        after = started.json("import json, os, socket\nprint(json.dumps([os.getcwd(), 'OPENAI_API_KEY' in os.environ]))")
        assert after == [str(folders.notebook), False]
    finally:
        started.close()
    assert not private.exists()


@needs_sandbox
def test_refuses_a_notebook_in_the_home_folder_itself(folders):
    spec = KernelSpecManager(kernel_dirs=[str(KERNELS)])
    manager = MultiKernelManager(kernel_spec_manager=spec)
    before = private_folders(folders)
    with pytest.raises(SandboxUnavailable, match="Move the notebook into a folder of its own"):
        manager.start_kernel(kernel_name=NAME, cwd=str(Path.home()))
    assert private_folders(folders) == before


@needs_sandbox
def test_refuses_a_notebooks_folder_that_holds_jupyters_runtime_folder(tmp_path, monkeypatch):
    # The server's token and other kernels' connection files would be in the sandbox.
    project = tmp_path / "project"
    runtime = project / ".jupyter" / "runtime"
    runtime.mkdir(parents=True)
    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(runtime))
    manager = MultiKernelManager(kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(KERNELS)]))
    with pytest.raises(SandboxUnavailable, match="holds Jupyter's runtime folder"):
        manager.start_kernel(kernel_name=NAME, cwd=str(project))
    assert list(runtime.iterdir()) == []


@linux
def test_missing_bubblewrap_says_how_to_install_it(folders):
    spec = KernelSpecManager(kernel_dirs=[str(KERNELS)])
    settings = Config({"SandboxProvisioner": {"bwrap_path": "/nonexistent/bwrap"}})
    manager = MultiKernelManager(kernel_spec_manager=spec, config=settings)
    with pytest.raises(SandboxUnavailable, match="sudo apt install bubblewrap") as raised:
        manager.start_kernel(kernel_name=NAME, cwd=str(folders.notebook))
    assert "\n" not in str(raised.value)


@linux
def test_ubuntus_restriction_says_what_to_set(folders, tmp_path, monkeypatch):
    # bubblewrap as it fails on Ubuntu 24.04 without a profile: the namespace
    # is made, without the capabilities to set it up.
    fake = tmp_path / "bwrap"
    fake.write_text("#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setattr(bwrap, "_sysctl", lambda name: {"kernel.apparmor_restrict_unprivileged_userns": "1"}.get(name))
    spec = KernelSpecManager(kernel_dirs=[str(KERNELS)])
    settings = Config({"SandboxProvisioner": {"bwrap_path": str(fake), "cache_dir": str(folders.cache)}})
    manager = MultiKernelManager(kernel_spec_manager=spec, config=settings)
    before = private_folders(folders)
    with pytest.raises(SandboxUnavailable) as raised:
        manager.start_kernel(kernel_name=NAME, cwd=str(folders.notebook))
    message = str(raised.value)
    assert "as Ubuntu 24.04 does" in message
    assert f"profile bwrap {fake} flags=(unconfined) {{ userns, }}" in message
    assert "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0" in message
    assert "bubblewrap's error: bwrap: setting up uid map: Permission denied" in message
    assert "\n" not in message
    # The failed start leaves no private folder behind.
    assert private_folders(folders) == before


def test_other_settings_that_stop_bubblewrap(monkeypatch):
    for setting, command in [
        ("kernel.unprivileged_userns_clone", "sudo sysctl -w kernel.unprivileged_userns_clone=1"),
        ("user.max_user_namespaces", "sudo sysctl -w user.max_user_namespaces=15000"),
    ]:
        monkeypatch.setattr(bwrap, "_sysctl", lambda name, setting=setting: "0" if name == setting else None)
        assert command in bwrap.diagnose("bwrap: No permissions to create new namespace", "/usr/bin/bwrap")
    # A failure that is not about namespaces does not blame AppArmor.
    monkeypatch.setattr(bwrap, "_sysctl", lambda name: "1")
    message = bwrap.diagnose("bwrap: Can't find source path /x: No such file or directory", "/usr/bin/bwrap")
    assert message == "bubblewrap could not start the sandboxed kernel: bwrap: Can't find source path /x: No such file or directory"


def test_missing_sandbox_exec_says_so():
    with pytest.raises(SandboxUnavailable, match="this Mac does not have it"):
        seatbelt.find("/nonexistent/sandbox-exec")
    nested = seatbelt.diagnose("sandbox-exec: sandbox_apply: Operation not permitted", seatbelt.SANDBOX_EXEC)
    assert "macOS does not nest them" in nested


def test_the_kernelspec_names_the_provisioner_and_interrupts_by_message():
    spec = json.loads((KERNELS / NAME / "kernel.json").read_text())
    assert spec["display_name"] == "Python 3 (sandboxed)"
    # jupyter_client replaces "python" with the Jupyter server's interpreter.
    assert spec["argv"] == ["python", "-m", "ipykernel_launcher", "-f", "{connection_file}"]
    # The provisioner passes a signal into the sandbox too; the shipped spec
    # keeps message interrupts, and a copy keeps the original's mode.
    assert spec["interrupt_mode"] == "message"
    assert spec["metadata"]["kernel_provisioner"] == {"provisioner_name": "whybook-sandbox"}


def test_pyproject_registers_the_provisioner_and_installs_the_kernelspec():
    tomllib = pytest.importorskip("tomllib")
    project = tomllib.loads((REPO / "pyproject.toml").read_text())
    assert project["project"]["entry-points"][GROUP] == {"whybook-sandbox": ENTRY_POINT}
    shared = project["tool"]["hatch"]["build"]["targets"]["wheel"]["shared-data"]
    assert shared[f"jupyter-config/kernels/{NAME}"] == f"share/jupyter/kernels/{NAME}"


def policy(tmp_path: Path) -> Policy:
    """A notebook's folder with a .venv inside it, reached through a link, and a Python environment elsewhere."""
    home = tmp_path / "home"
    work = home / "work"
    notebook = work / "analysis"
    (notebook / ".venv" / "lib").mkdir(parents=True)
    (home / "link").symlink_to(work)
    env = tmp_path / "python"
    (env / "bin").mkdir(parents=True)
    (env / "bin" / "python").touch()
    private = tmp_path / "runtime" / "k1"
    private.mkdir(parents=True)
    cache = home / ".cache" / "whybook"
    cache.mkdir(parents=True)
    return Policy(
        workdir=home / "link" / "analysis",
        read_write=[home / "link" / "analysis", cache, private],
        read_only=[env, notebook / ".venv"],
        private=private,
        home=home,
        env={"HOME": str(home), "PATH": f"{env}/bin:/usr/bin:/bin"},
        executable=str(env / "bin" / "python"),
    )


def test_bubblewrap_arguments(tmp_path):
    rules = policy(tmp_path)
    argv = bwrap.command("/usr/bin/bwrap", rules)
    assert argv[:6] == ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
    assert "--share-net" not in argv and argv[-1] == "--"
    triples = [argv[i : i + 3] for i in range(len(argv) - 2)]
    notebook = str(tmp_path / "home" / "work" / "analysis")
    home = str(tmp_path / "home")
    # The home folder is empty, in memory, and is never bound itself.
    assert ["--tmpfs", home] == argv[argv.index(home) - 1 : argv.index(home) + 1]
    assert ["--bind", home, home] not in triples and ["--ro-bind", home, home] not in triples
    # The notebook's folder read-write at its real path, and the .venv inside it read-only, after it.
    rw = triples.index(["--bind", notebook, notebook])
    ro = triples.index(["--ro-bind", notebook + "/.venv", notebook + "/.venv"])
    assert rw < ro
    assert ["--ro-bind", str(tmp_path / "python"), str(tmp_path / "python")] in triples
    # The link on the way to the notebook's folder, so that its path works in the kernel too.
    assert ["--symlink", str(tmp_path / "home" / "work"), str(tmp_path / "home" / "link")] in triples
    assert ["--chdir", str(rules.workdir), "--clearenv"] in triples
    assert ["--setenv", "HOME", home] in triples


def top_level_forms(text: str) -> list[str]:
    """The first word of each top-level form of a Seatbelt profile. Fails on unbalanced parentheses or strings."""
    heads: list[str] = []
    depth = i = 0
    while i < len(text):
        if text[i] == ";":
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        if text[i] == '"' or text.startswith('#"', i):
            i = text.index('"', i) + 1
            while text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif text[i] == "(":
            if depth == 0:
                heads.append(text[i + 1 :].split(maxsplit=1)[0].rstrip(")"))
            depth += 1
        elif text[i] == ")":
            depth -= 1
            assert depth >= 0, f"a closing parenthesis too many at {i}"
        i += 1
    assert depth == 0, "a parenthesis left open"
    return heads


def test_seatbelt_profile(tmp_path):
    rules = policy(tmp_path)
    text, params = seatbelt.profile(rules)
    base = (seatbelt.CODEX / "seatbelt_base_policy.sbpl").read_text()
    assert text.startswith(base)
    assert "(deny default)" in text
    # Nobody has run this profile: at least its parentheses and strings close,
    # and each form is a rule. Every parameter it names is passed.
    heads = top_level_forms(text)
    assert heads[0] == "version" and set(heads[1:]) == {"allow", "deny"}
    assert set(re.findall(r'\(param "(\w+)"\)', text)) == set(params)

    def named(path: Path, prefix: str) -> str:
        """The parameter that holds this path in rules of this kind."""
        (name,) = [key for key, value in params.items() if value == str(path) and key.startswith(prefix)]
        return name

    notebook = tmp_path / "home" / "work" / "analysis"
    assert params["PRIVATE_0"] == str(rules.private)
    # Unix sockets only in the private folder, and the system log's socket, which
    # Codex's platform defaults allow; no other network rule.
    network = [line for line in text.splitlines() if line.startswith("(allow network")]
    assert network == [
        '(allow network-outbound (literal "/private/var/run/syslog"))',
        '(allow network-bind network-inbound (local unix-socket (subpath (param "PRIVATE_0"))))',
        '(allow network-outbound (remote unix-socket (subpath (param "PRIVATE_0"))))',
    ]
    # Writes in the notebook's folder, none in the .venv inside it, which stays readable and executable.
    write = named(notebook, "WRITE_")
    venv = named(notebook / ".venv", "READ_")
    deny = text.index("(deny file-write*")
    assert text.index(f'(subpath (param "{venv}"))', deny) > deny > text.index(f'(subpath (param "{write}"))')
    # The home folder is never readable itself: only its metadata, as a folder on the way.
    home = tmp_path / "home"
    assert [key.split("_")[0] for key, value in params.items() if value == str(home)] == ["ANCESTOR"]
    # The link on the way to the notebook's folder can be read.
    assert f'(literal (param "{named(home / "link", "LINK_")}"))' in text
    argv = seatbelt.command(seatbelt.SANDBOX_EXEC, rules)
    assert argv[:3] == [seatbelt.SANDBOX_EXEC, "-p", text] and argv[-1] == "--"
    assert f"-DPRIVATE_0={rules.private}" in argv


def test_symlink_chain_names_each_link_at_its_real_place(tmp_path):
    real = tmp_path / "versions" / "3.12" / "envs" / "env"
    (real / "bin").mkdir(parents=True)
    (tmp_path / "versions" / "3.12" / "bin").mkdir()
    (tmp_path / "versions" / "3.12" / "bin" / "python3.12").touch()
    (tmp_path / "versions" / "env").symlink_to(real)
    (real / "bin" / "python").symlink_to(tmp_path / "versions" / "3.12" / "bin" / "python3.12")
    links, end = symlink_chain(tmp_path / "versions" / "env" / "bin" / "python")
    assert [location for _, location in links] == [tmp_path / "versions" / "env", real / "bin" / "python"]
    assert end == tmp_path / "versions" / "3.12" / "bin" / "python3.12"


@macos
def test_the_profile_compiles_and_runs_python(tmp_path):
    rules = policy(tmp_path)
    rules.executable = sys.executable
    rules.read_only.append(Path(sys.prefix))
    argv = seatbelt.command(seatbelt.SANDBOX_EXEC, rules)
    run = subprocess.run([*argv, sys.executable, "-I", "-S", "-c", ""], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr


# Kernels that do not run Python: their environment, their signals, and the
# sandboxed copy of their kernelspec (whybook/sandbox/kernelspec.py).


def executable(path: Path, text: str) -> Path:
    path.write_text(text)
    path.chmod(0o755)
    return path


@linux
def test_the_command_of_a_kernel_that_is_not_python(folders, tmp_path, monkeypatch):
    # An R kernel in an environment of its own, named by its name alone, as
    # IRkernel's kernelspec names R; its Rscript lists a library outside it.
    env = tmp_path / "r-env"
    (env / "lib" / "R" / "lib").mkdir(parents=True)
    (env / "bin").mkdir()
    kernel = executable(env / "bin" / "fake-r-kernel", "#!/bin/sh\nexit 0\n")
    library = tmp_path / "R" / "x86_64-pc-linux-gnu-library" / "4.4"
    library.mkdir(parents=True)
    executable(env / "bin" / "Rscript", f'#!/bin/sh\necho "$R_HOME"\necho {library}\n')
    depot = tmp_path / "depot"
    depot.mkdir()
    # A folder that holds Jupyter's runtime folder is never mounted, even when a kernelspec names it.
    holder = Path(tempfile.mkdtemp(prefix="wbh"))
    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(holder / "rt"))
    spec_dir = tmp_path / "kernels" / "r-fake"
    spec_dir.mkdir(parents=True)
    r_home, r_lib = f"{env}/lib/R", f"{env}/lib/R/lib"
    (spec_dir / "kernel.json").write_text(
        json.dumps(
            {
                "argv": ["fake-r-kernel", "-f", "{connection_file}"],
                "display_name": "R (fake)",
                "language": "R",
                "env": {"R_HOME": r_home, "LD_LIBRARY_PATH": r_lib},
                "metadata": {
                    "kernel_provisioner": {
                        "provisioner_name": "whybook-sandbox",
                        "config": {"read_only": [str(depot), str(holder)]},
                    }
                },
            }
        )
    )
    # bubblewrap as a script that notes its arguments and lets the check pass.
    record = tmp_path / "bwrap-calls.jsonl"
    fake = executable(
        tmp_path / "bwrap",
        f"#!{sys.executable}\nimport json, sys\nopen({str(record)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n",
    )
    settings = Config({"SandboxProvisioner": {"bwrap_path": str(fake), "cache_dir": str(folders.cache)}})
    manager = KernelManager(
        kernel_name="r-fake", kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(tmp_path / "kernels")]), config=settings
    )
    server_env = {**os.environ, "PATH": f"{env / 'bin'}:{os.environ['PATH']}", "OPENAI_API_KEY": "sk-not-a-real-key"}
    cmd, _ = manager.pre_start_kernel(cwd=str(folders.notebook), env=server_env)
    try:
        private = Path(manager.connection_file).parent
        # The kernel's command, from its full path, with a connection file of its own.
        inside = bwrap.PRIVATE_INSIDE
        assert cmd[-3:] == [str(kernel), "-f", str(inside / INSIDE_CONNECTION_FILE)]
        own = json.loads((private / INSIDE_CONNECTION_FILE).read_text())
        servers = json.loads((private / "kernel.json").read_text())
        assert (own["ip"], servers["ip"]) == (str(inside / "k"), str(private / "k"))
        assert own["key"] == servers["key"] and own["transport"] == "ipc"
        argv = cmd[: cmd.index("--") + 1]
        triples = [argv[i : i + 3] for i in range(len(argv) - 2)]
        # R's environment and the library that Rscript lists, read-only; the
        # notebook's folder read-write; the private folder at a short path.
        assert ["--ro-bind", str(env), str(env)] in triples
        assert ["--ro-bind", str(library), str(library)] in triples
        assert ["--ro-bind", str(depot), str(depot)] in triples
        assert ["--bind", str(folders.notebook), str(folders.notebook)] in triples
        assert ["--bind", str(private), str(inside)] in triples
        assert ["--ro-bind", str(holder), str(holder)] not in triples
        assert "--unshare-all" in argv and "--share-net" not in argv
        # R_HOME and LD_LIBRARY_PATH pass; the server's keys do not.
        assert ["--setenv", "R_HOME", r_home] in triples
        assert ["--setenv", "LD_LIBRARY_PATH", r_lib] in triples
        assert ["--setenv", "PATH", f"{env / 'bin'}:/usr/local/bin:/usr/bin:/bin"] in triples
        assert ["--setenv", "XDG_CACHE_HOME", str(folders.cache)] in triples
        assert "OPENAI_API_KEY" not in argv and "JPY_PARENT_PID" not in argv
        # The check before the start looked for the kernel's executable in the sandbox.
        (check,) = [json.loads(line) for line in record.read_text().splitlines()]
        assert check[-4:] == ["/bin/sh", "-c", CHECK_EXECUTABLE, str(kernel)]
    finally:
        manager.cleanup_resources()
        shutil.rmtree(holder, ignore_errors=True)
    assert not private.exists()


@linux
def test_a_kernel_that_is_not_on_the_path_says_so(folders, tmp_path):
    spec_dir = tmp_path / "kernels" / "gone"
    spec_dir.mkdir(parents=True)
    (spec_dir / "kernel.json").write_text(
        json.dumps(
            {
                "argv": ["no-such-kernel-anywhere", "{connection_file}"],
                "display_name": "Gone",
                "language": "gone",
                "metadata": {"kernel_provisioner": {"provisioner_name": "whybook-sandbox"}},
            }
        )
    )
    manager = MultiKernelManager(
        kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(tmp_path / "kernels")]),
        config=Config({"SandboxProvisioner": {"cache_dir": str(folders.cache)}}),
    )
    before = private_folders(folders)
    with pytest.raises(SandboxUnavailable, match='runs "no-such-kernel-anywhere", which is not on the PATH'):
        manager.start_kernel(kernel_name="gone", cwd=str(folders.notebook))
    assert private_folders(folders) == before


@needs_sandbox
@linux
def test_an_interrupt_by_signal_reaches_the_kernel_inside_bubblewrap(folders, tmp_path):
    # A signal to bubblewrap would end it, and the kernel with it.
    kernels = tmp_path / "kernels"
    shutil.copytree(KERNELS / NAME, kernels / "python3-signal")
    spec_file = kernels / "python3-signal" / "kernel.json"
    spec_file.write_text(json.dumps({**json.loads(spec_file.read_text()), "interrupt_mode": "signal"}))
    started = Sandboxed(folders, kernels=kernels, name="python3-signal")
    try:
        assert started.km.kernel_spec.interrupt_mode == "signal"
        msg_id = started.send("import time\ntime.sleep(30)")
        time.sleep(1)
        start = time.perf_counter()
        started.km.interrupt_kernel()
        result = started.collect([msg_id], timeout=15)[msg_id]
        assert (result["status"], result["error"]) == ("error", "KeyboardInterrupt")
        assert time.perf_counter() - start < 5
        assert started.km.is_alive()
        assert started.run("print(6 * 7)")["stdout"].strip() == "42"
    finally:
        started.close()


@pytest.fixture(scope="module")
def r_kernels(tmp_path_factory):
    """A folder of kernelspecs with the sandboxed copy of the installed R kernelspec, r-sandboxed.

    The copy interrupts by signal, whatever the original sets, so that the
    tests see a signal reach R in the sandbox.
    """
    if CANNOT is not None or R_KERNEL is None:
        pytest.skip("No sandbox or no R kernelspec")
    name, source = R_KERNEL
    spec = kernelspec.sandboxed_spec(json.loads((source / "kernel.json").read_text()))
    spec["interrupt_mode"] = "signal"
    kernels = tmp_path_factory.mktemp("kernels")
    kernelspec.write_copy(source, kernels / "r-sandboxed", spec, name)
    return kernels


@pytest.fixture(scope="module")
def r_kernel(folders, r_kernels):
    started = Sandboxed(folders, kernels=r_kernels, name="r-sandboxed")
    yield started
    started.close()


def r_text(r_kernel, code: str) -> str:
    result = r_kernel.run(code)
    assert result["status"] == "ok" and result["error"] is None, result
    return result["stdout"].strip()


@needs_r
def test_an_r_kernel_writes_in_the_notebooks_folder_alone(r_kernel, folders):
    assert r_text(r_kernel, "cat(getwd(), '\\n'); writeLines('written by R', 'from-r.txt')") == str(folders.notebook)
    assert (folders.notebook / "from-r.txt").read_text() == "written by R\n"
    # The file beside the notebook's folder, and the keys of the home folder, are not there.
    secret = folders.root / "secret.txt"
    private = [name for name in (".ssh", ".claude", ".config") if (Path.home() / name).exists()]
    names = ", ".join(f"'~/{name}'" for name in [*private, "."])
    seen = r_text(r_kernel, f"cat(file.exists('{secret}'), file.exists(c({names})), '\\n')").split()
    assert seen == ["FALSE", *["FALSE"] * len(private), "TRUE"]
    # R's own library is read-only.
    assert r_text(r_kernel, "cat(file.create(file.path(R.home('library'), 'x.txt'), showWarnings = FALSE), '\\n')") == "FALSE"


@needs_r
def test_an_r_kernel_has_no_network_and_none_of_the_servers_variables(r_kernel, folders):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        code = (
            f"cat(tryCatch({{close(socketConnection('127.0.0.1', {port}, timeout = 3)); 'reached'}}, "
            "error = function(e) 'refused', warning = function(w) 'refused'), '\\n')"
        )
        assert r_text(r_kernel, code) == "refused"
    finally:
        listener.close()
    names = r_text(r_kernel, "cat(names(Sys.getenv()), sep = '\\n')").split()
    assert "OPENAI_API_KEY" not in names and "JPY_PARENT_PID" not in names
    # What the kernelspec's env sets, such as R_HOME and LD_LIBRARY_PATH for xeus-r, passes.
    original = json.loads((R_KERNEL[1] / "kernel.json").read_text()).get("env") or {}
    assert set(original) <= set(names)
    # fontconfig keeps its cache in the sandbox's cache folder, for R's plots.
    assert r_text(r_kernel, "cat(Sys.getenv('XDG_CACHE_HOME'), '\\n')") == str(folders.cache)


@needs_r
def test_an_interrupt_by_signal_reaches_r_inside_the_sandbox(r_kernel):
    r_text(r_kernel, "kept <- 42")
    msg_id = r_kernel.send('cat("sleeping\\n")\ntryCatch(Sys.sleep(30), interrupt = function(e) cat("interrupted\\n"))')
    # Wait until R sleeps: an interrupt before the tryCatch would reach xeus-r's top level, which ends the kernel.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        msg = r_kernel.kc.get_iopub_msg(timeout=30)
        if msg["parent_header"].get("msg_id") == msg_id and "sleeping" in msg["content"].get("text", ""):
            break
    time.sleep(0.5)
    start = time.perf_counter()
    r_kernel.km.interrupt_kernel()
    result = r_kernel.collect([msg_id], timeout=15)[msg_id]
    assert result["stdout"].strip() == "interrupted"
    assert time.perf_counter() - start < 5
    assert r_kernel.km.is_alive()
    assert r_text(r_kernel, "cat(kept, '\\n')") == "42"


@needs_r
def test_an_r_kernel_restarts_in_its_sandbox(folders, r_kernels):
    started = Sandboxed(folders, kernels=r_kernels, name="r-sandboxed")
    try:
        connection = started.km.connection_file
        r_text(started, "x <- 1")
        started.km.restart_kernel(now=True)
        started.kc.wait_for_ready(timeout=60)
        assert started.km.connection_file == connection
        assert r_text(started, "cat(exists('x'), getwd(), '\\n')").split() == ["FALSE", str(folders.notebook)]
    finally:
        started.close()
    assert not Path(connection).parent.exists()


def test_a_sandboxed_copy_of_a_kernelspec(tmp_path, monkeypatch, capsys):
    data = tmp_path / "data"
    source = data / "kernels" / "xr"
    source.mkdir(parents=True)
    original = {
        "display_name": "R 4.4.3 (xr)",
        "argv": ["/opt/r/bin/xr", "-f", "{connection_file}"],
        "language": "R",
        "metadata": {"debugger": False},
        "env": {"R_HOME": "/opt/r/lib/R"},
    }
    (source / "kernel.json").write_text(json.dumps(original))
    logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
    (source / "logo-svg.svg").write_text(logo)
    (source / "logo-64x64.png").write_bytes(b"\x89PNG not a real one")
    monkeypatch.setenv("JUPYTER_PATH", str(data))
    assert kernelspec.main(["xr", "--path", str(tmp_path / "out")]) == 0
    copy = tmp_path / "out" / "kernels" / "r-sandboxed"
    assert f'Installed "R 4.4.3 (xr, sandboxed)" in {copy}' in capsys.readouterr().out
    spec = json.loads((copy / "kernel.json").read_text())
    assert spec["display_name"] == "R 4.4.3 (xr, sandboxed)"
    assert spec["metadata"] == {"debugger": False, "kernel_provisioner": {"provisioner_name": "whybook-sandbox"}}
    # The same command, language and environment; the original's interrupt mode, here the default.
    assert {key: spec[key] for key in ("argv", "language", "env")} == {key: original[key] for key in ("argv", "language", "env")}
    assert "interrupt_mode" not in spec
    # Its own logo in the box; its PNG as it was.
    icon = (copy / "logo-svg.svg").read_text()
    assert f'stroke="{kernelspec.EDGE}"' in icon
    assert f"data:image/svg+xml;base64,{base64.b64encode(logo.encode()).decode()}" in icon
    assert (copy / "logo-64x64.png").read_bytes() == b"\x89PNG not a real one"
    # A copy runs in the sandbox already, and cannot be copied again.
    monkeypatch.setenv("JUPYTER_PATH", os.pathsep.join([str(data), str(tmp_path / "out")]))
    assert kernelspec.main(["r-sandboxed", "--path", str(tmp_path / "again")]) == 1
    assert "runs in the sandbox already" in capsys.readouterr().err
    assert kernelspec.main(["no-such-kernel", "--path", str(tmp_path / "again")]) == 1
    assert 'No kernelspec is named "no-such-kernel". Installed:' in capsys.readouterr().err


def test_the_names_and_settings_of_a_sandboxed_copy():
    assert kernelspec.sandboxed_name("R") == "r-sandboxed"
    assert kernelspec.sandboxed_name("C++17") == "c-17-sandboxed"
    assert kernelspec.sandboxed_display_name("Python 3 (ipykernel)") == "Python 3 (ipykernel, sandboxed)"
    assert kernelspec.sandboxed_display_name("Julia 1.11") == "Julia 1.11 (sandboxed)"
    spec = kernelspec.sandboxed_spec({"display_name": "Julia 1.11", "language": "julia"}, read_only=["~/.julia"])
    assert spec["metadata"]["kernel_provisioner"] == {
        "provisioner_name": "whybook-sandbox",
        "config": {"read_only": ["~/.julia"]},
    }
    other = {"display_name": "Remote", "metadata": {"kernel_provisioner": {"provisioner_name": "docker-provisioner"}}}
    with pytest.raises(kernelspec.KernelspecError, match="through the provisioner docker-provisioner"):
        kernelspec.sandboxed_spec(other)


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def test_the_python_icon_is_ipykernels_logo_in_the_box():
    icon = (KERNELS / NAME / "logo-svg.svg").read_text()
    assert f'stroke="{kernelspec.EDGE}"' in icon and "python.org/psf/trademarks" in icon
    found = importlib.util.find_spec("ipykernel")
    logo = Path(found.origin).parent / "resources" / "logo-svg.svg" if found else None
    if logo is not None and logo.exists():
        # The logo unaltered, as ipykernel ships it.
        assert kernelspec.logo_href(logo) in icon
    for size in (32, 64):
        assert png_size(KERNELS / NAME / f"logo-{size}x{size}.png") == (size, size)
