"""The plot hooks of whybook/server/kernel_code/plot_hooks.py, run as the view runs them.

An in-process IPython shell gets the figure formatters that ipykernel's inline
backend sets up (PNG or retina, ``bbox_inches="tight"``), then the hooks. A
figure's display bundle is what ``DisplayFormatter.format`` returns, which is
what the inline backend publishes at the end of a cell.

One test starts an ipykernel through jupyter_client, as the Jupyter server
starts one, and sends the view's programs to a subshell while a cell runs in
the main shell: the inline backend shows the open figures in a callback after
each request, in the thread of that request.
"""

import base64
import io
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import IPython.display
import numpy as np
import pytest

matplotlib = pytest.importorskip("matplotlib")
Image = pytest.importorskip("PIL.Image")

KERNEL_CODE = Path(__file__).resolve().parents[1] / "kernel_code"
RESULT_MIME = "application/vnd.whybook.result+json"
AXES_MIME = "application/vnd.whybook.axes+json"


def call(name, args):
    """The code that the view sends for a kernel program (PYTHON.call in src/model/languages.ts)."""
    source = (KERNEL_CODE / f"{name}.py").read_text()
    return f"{source}\ntry:\n    _whybook_{name}(__import__('json').loads({json.dumps(json.dumps(args))}))\nfinally:\n    del _whybook_{name}\n"


def hooks(shell, args=None):
    """Run the kernel program as the view does, and return its report."""
    shown = []
    original = IPython.display.display
    IPython.display.display = lambda data, raw=False, **kw: shown.append(data)
    try:
        code = call("plot_hooks", args or {})
        result = shell.run_cell(code, silent=True)
        assert result.success, result.error_in_exec
    finally:
        IPython.display.display = original
    return next(item[RESULT_MIME] for item in reversed(shown) if RESULT_MIME in item)["hooks"]


@pytest.fixture
def shell():
    from IPython.core.interactiveshell import InteractiveShell
    from IPython.core.pylabtools import select_figure_formats
    from traitlets.config import Config

    matplotlib.use("agg")
    # History in memory, as for the demo's shell: the file is the user's.
    config = Config()
    config.HistoryManager.hist_file = ":memory:"
    shell = InteractiveShell.instance(config=config)
    select_figure_formats(shell, {"png"}, bbox_inches="tight")
    before = set(shell.user_ns)
    yield shell
    hooks(shell, {"uninstall": True})
    import matplotlib.pyplot as plt

    plt.close("all")
    for name in set(shell.user_ns) - before:
        del shell.user_ns[name]
    select_figure_formats(shell, {"png"}, bbox_inches="tight")


def run(shell, code, value=None):
    """Run code as a cell that shows nothing, and return the value of an expression after it."""
    result = shell.run_cell(code, silent=True)
    assert result.success, result.error_in_exec
    return shell.ev(value) if value else None


# Pure colours, one per point, found again in the PNG.
COLOURS = [(255, 0, 0), (0, 160, 0), (0, 0, 255), (255, 0, 255)]


def at(axes, x, y):
    """The pixel of a data point in the PNG, from the hook's box, limits and scales."""
    left, top, right, bottom = axes["box"]

    def fraction(axis, value):
        low, high = axis["limits"]
        if axis["scale"] == "log":
            low, high, value = np.log10(low), np.log10(high), np.log10(value)
        return (value - low) / (high - low)

    return left + fraction(axes["x"], x) * (right - left), bottom - fraction(axes["y"], y) * (bottom - top)


def centre(image, box, colour):
    """The centre of the pixels of one colour inside a box of the image."""
    left, top, right, bottom = (int(value) for value in box)
    part = image[top : bottom + 1, left : right + 1]
    rows, columns = np.nonzero(np.abs(part - np.array(colour)).sum(axis=2) < 40)
    assert len(rows) > 20, f"no marker of colour {colour}"
    # A pixel's centre is half a pixel from its corner.
    return columns.mean() + 0.5 + left, rows.mean() + 0.5 + top


@pytest.mark.parametrize("formats", [{"png"}, {"retina"}])
def test_the_box_maps_known_points_to_their_pixels(shell, formats):
    from IPython.core.pylabtools import select_figure_formats

    select_figure_formats(shell, formats, bbox_inches="tight")
    assert hooks(shell)["matplotlib"]["state"] == "on"
    figure = run(
        shell,
        "\n".join(
            [
                "import matplotlib.pyplot as plt",
                "_fig, (_left, _right) = plt.subplots(1, 2, figsize=(7, 3), dpi=72)",
                "_fig.suptitle('A title that moves the tight box')",
                f"_colours = [tuple(c / 255 for c in rgb) for rgb in {COLOURS}]",
                "_left.scatter([1, 4, 7, 9], [2, 8, 3, 6], c=_colours, s=80, marker='s', linewidths=0)",
                "_left.set_ylabel('a long label\\nover two lines')",
                "_right.scatter([2, 30, 300, 900], [0.5, 1.5, 2.5, 3.5], c=_colours, s=80, marker='s', linewidths=0)",
                "_right.set_xscale('log')",
            ]
        ),
        "_fig",
    )
    data, metadata = shell.display_formatter.format(figure)
    payload = data[AXES_MIME]
    image = np.asarray(Image.open(io.BytesIO(base64.b64decode(data["image/png"]))).convert("RGB")).astype(int)
    scale = 2 if formats == {"retina"} else 1
    # The PNG's own size, and the retina factor that halves it on screen.
    assert (payload["image"]["width"], payload["image"]["height"]) == (image.shape[1], image.shape[0])
    assert payload["image"]["scale"] == scale
    if scale == 2:
        assert metadata["image/png"] == {"width": image.shape[1] // 2, "height": image.shape[0] // 2}
    left, right = payload["axes"]
    assert (left["x"]["scale"], right["x"]["scale"]) == ("linear", "log")
    for axes, points in ((left, zip([1, 4, 7, 9], [2, 8, 3, 6])), (right, zip([2, 30, 300, 900], [0.5, 1.5, 2.5, 3.5]))):
        for colour, (x, y) in zip(COLOURS, points):
            expected = at(axes, x, y)
            found = centre(image, axes["box"], colour)
            assert found == pytest.approx(expected, abs=1.0)


def test_a_frame_plotted_by_pandas_is_named_with_its_columns(shell):
    run(shell, "import pandas as pd\nhooks_visits = pd.DataFrame({'hook_age': [20, 30, 40, 50], 'hook_pain': [1.0, 3.0, 2.0, 5.0]})")
    assert hooks(shell)["pandas"]["state"] == "on"
    figure = run(shell, "_ax = hooks_visits.plot.scatter(x='hook_age', y='hook_pain')", "_ax.figure")
    (axes,) = shell.display_formatter.format(figure)[0][AXES_MIME]["axes"]
    assert axes["frame"] == "hooks_visits"
    assert (axes["x"]["column"], axes["y"]["column"]) == ("hook_age", "hook_pain")
    assert axes["marks"] == 4
    # The kind of the pandas plot, which the map shows as an icon.
    assert axes["kind"] == "scatter"
    # A line plot names its y column in the legend only: the note of the call gives it.
    figure = run(shell, "_ax = hooks_visits.plot(x='hook_age', y='hook_pain')", "_ax.figure")
    (axes,) = shell.display_formatter.format(figure)[0][AXES_MIME]["axes"]
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == ("hooks_visits", "hook_age", "hook_pain")
    assert axes["kind"] == "line"
    # Bars stand at positions, not at values of a column.
    figure = run(shell, "_ax = hooks_visits.plot.bar(x='hook_age', y='hook_pain')", "_ax.figure")
    (axes,) = shell.display_formatter.format(figure)[0][AXES_MIME]["axes"]
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == ("hooks_visits", None, None)
    assert axes["kind"] == "bar"


def test_labels_that_name_columns_find_the_frame(shell):
    hooks(shell)
    run(shell, "import pandas as pd\nimport matplotlib.pyplot as plt\nhooks_a = pd.DataFrame({'hook_u': range(5), 'hook_v': range(5)})")
    plot = "_fig, _ax = plt.subplots(figsize=(3, 2))\n_ax.scatter(range(5), range(5))\n_ax.set_xlabel({x!r})\n_ax.set_ylabel({y!r})"

    def axes_of(x, y):
        (axes,) = shell.display_formatter.format(run(shell, plot.format(x=x, y=y), "_fig"))[0][AXES_MIME]["axes"]
        return axes

    axes = axes_of("hook_u", "hook_v")
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == ("hooks_a", "hook_u", "hook_v")
    # Without a pandas call, the kind comes from what the Axes draws.
    assert axes["kind"] == "scatter"
    # A y label that is no column: the x column alone.
    axes = axes_of("hook_u", "Count")
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == ("hooks_a", "hook_u", None)
    # Two frames with the columns: the one with a row per mark.
    run(shell, "hooks_b = pd.DataFrame({'hook_u': range(9), 'hook_v': range(9)})")
    axes = axes_of("hook_u", "hook_v")
    assert axes["frame"] == "hooks_a"
    # Labels that name no column: the view asks about the picture instead.
    axes = axes_of("Time (s)", "")
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == (None, None, None)
    assert axes["x"]["label"] == "Time (s)"


def test_axes_whose_pixels_are_not_values_are_left_out(shell):
    hooks(shell)
    figure = run(
        shell,
        "\n".join(
            [
                "import datetime",
                "import matplotlib.pyplot as plt",
                "_fig = plt.figure(figsize=(12, 3))",
                "_plain = _fig.add_subplot(1, 6, 1)",
                "_plain.plot([1, 2, 3], [4, 5, 6])",
                "_symlog = _fig.add_subplot(1, 6, 2)",
                "_symlog.plot([1, 2, 3], [4, 5, 6])",
                "_symlog.set_yscale('symlog')",
                "_dates = _fig.add_subplot(1, 6, 3)",
                "_dates.plot([datetime.date(2026, 9, day) for day in (1, 2, 3)], [1, 2, 3])",
                "_categories = _fig.add_subplot(1, 6, 4)",
                "_categories.bar(['a', 'b'], [1, 2])",
                "_polar = _fig.add_subplot(1, 6, 5, projection='polar')",
                "_polar.plot([0, 1], [1, 2])",
                "_image = _fig.add_subplot(1, 6, 6)",
                "_fig.colorbar(_image.imshow([[1, 2], [3, 4]]), ax=_image)",
            ]
        ),
        "_fig",
    )
    payload = shell.display_formatter.format(figure)[0][AXES_MIME]
    # The line plot and the image stay; the colorbar goes with the others.
    assert len(payload["axes"]) == 2
    assert [axes["marks"] for axes in payload["axes"]] == [3, None]
    assert [axes["kind"] for axes in payload["axes"]] == ["line", None]


def test_a_hook_that_cannot_register_is_skipped_and_the_bundle_is_upstreams(shell, monkeypatch, capsys):
    figure = run(shell, "import matplotlib.pyplot as plt\n_fig, _ax = plt.subplots(figsize=(3, 2))\n_ax.plot([1, 2], [3, 4])", "_fig")
    # The PNG names the version of matplotlib that drew it.
    monkeypatch.setattr(matplotlib, "__version__", "3.4.0")
    upstream = shell.display_formatter.format(figure)
    capsys.readouterr()
    report = hooks(shell)
    assert report["matplotlib"] == {"state": "skipped", "reason": "RuntimeError: matplotlib 3.4.0 is older than 3.6"}
    assert AXES_MIME not in shell.display_formatter.formatters
    assert shell.display_formatter.format(figure) == upstream
    assert capsys.readouterr().out == ""


def test_a_hook_that_raises_on_display_removes_itself_and_the_bundle_is_upstreams(shell, monkeypatch, capsys):
    from matplotlib.axes import Axes
    from matplotlib.figure import Figure

    figure = run(shell, "import matplotlib.pyplot as plt\n_fig, _ax = plt.subplots(figsize=(3, 2))\n_ax.plot([1, 2], [3, 4])\n_ax.set_xlabel('x')", "_fig")
    upstream = shell.display_formatter.format(figure)
    assert hooks(shell)["matplotlib"]["state"] == "on"
    assert AXES_MIME in shell.display_formatter.format(figure)[0]

    # A matplotlib whose Axes answer differently than the hook expects.
    def broken(self):
        raise AttributeError("get_xlabel moved")

    monkeypatch.setattr(Axes, "get_xlabel", broken)
    capsys.readouterr()
    assert shell.display_formatter.format(figure) == upstream
    assert capsys.readouterr().out == ""
    report = hooks(shell)
    assert report["matplotlib"] == {"state": "failed", "reason": "AttributeError: get_xlabel moved"}
    # The hook is gone: its formatter, its printer, and its draw callbacks.
    assert AXES_MIME not in shell.display_formatter.formatters
    with pytest.raises(KeyError):
        shell.display_formatter.mimebundle_formatter.lookup_by_type(Figure)
    assert not figure._canvas_callbacks.callbacks.get("draw_event")
    monkeypatch.undo()
    assert shell.display_formatter.format(figure) == upstream


def test_a_library_found_incompatible_at_display_is_left_as_it_ships(shell, monkeypatch):
    # matplotlib not imported yet when the hooks install: the check waits for
    # the first figure.
    monkeypatch.delitem(sys.modules, "matplotlib.figure")
    assert hooks(shell)["matplotlib"]["state"] == "on"
    monkeypatch.undo()
    monkeypatch.setattr(matplotlib, "__version__", "3.5.3")
    figure = run(shell, "import matplotlib.pyplot as plt\n_fig, _ax = plt.subplots(figsize=(3, 2))\n_ax.plot([1, 2], [3, 4])", "_fig")
    # The first figure shown runs the check, which fails.
    data, _ = shell.display_formatter.format(figure)
    assert sorted(data) == ["image/png", "text/plain"]
    assert hooks(shell)["matplotlib"] == {"state": "failed", "reason": "RuntimeError: matplotlib 3.5.3 is older than 3.6"}


def test_two_threads_that_show_one_figure_at_once_each_read_their_own_draw(shell, monkeypatch):
    from matplotlib.axes import Axes

    assert hooks(shell)["matplotlib"]["state"] == "on"
    figure = run(shell, "import matplotlib.pyplot as plt\n_fig, _ax = plt.subplots(figsize=(3, 2))\n_ax.plot([1, 2], [3, 4])\n_ax.set_xlabel('x')", "_fig")
    alone = shell.display_formatter.format(figure)[0][AXES_MIME]
    formatters = shell.display_formatter.formatters
    printer, png, axes = shell.display_formatter.mimebundle_formatter, formatters["image/png"], formatters[AXES_MIME]

    def shown_twice():
        # What IPython does to show the figure, in two threads at once: the
        # printer, then the PNG, then the Axes. The second thread calls the
        # printer after the first drew its PNG, and draws its own PNG after
        # the first read the Axes.
        with ThreadPoolExecutor(1) as first, ThreadPoolExecutor(1) as second:
            first.submit(printer, figure).result()
            first.submit(png, figure).result()
            second.submit(printer, figure).result()
            one = first.submit(axes, figure).result()
            second.submit(png, figure).result()
            return one, second.submit(axes, figure).result()

    assert shown_twice() == (alone, alone)

    # Axes that raise: the first thread to read them removes the hook.
    def broken(self):
        raise AttributeError("get_xlabel moved")

    monkeypatch.setattr(Axes, "get_xlabel", broken)
    assert shown_twice() == (None, None)
    assert hooks(shell)["matplotlib"] == {"state": "failed", "reason": "AttributeError: get_xlabel moved"}


class Kernel:
    """An ipykernel with matplotlib's inline backend, started through jupyter_client, and a client that keeps every message."""

    def __init__(self, folder):
        import zmq
        from jupyter_client import KernelManager

        self.zmq = zmq
        # The inline backend, as a kernel that a Jupyter server starts has it,
        # and an IPython folder of its own: no profile of the user's loads.
        env = {**os.environ, "MPLBACKEND": "module://matplotlib_inline.backend_inline", "IPYTHONDIR": str(folder / "ipython")}
        self.km = KernelManager(kernel_name="python3")
        self.km.start_kernel(cwd=str(folder), env=env)
        self.kc = self.km.client()
        self.kc.start_channels()
        try:
            self.kc.wait_for_ready(timeout=60)
            self.info = self.kc.kernel_info(reply=True, timeout=30)["content"]
        except BaseException:
            self.close()
            raise
        self.outputs = defaultdict(list)
        self.stdout = defaultdict(str)
        self.replies = {}
        self.idle = set()

    def control(self, msg_type, content):
        msg = self.kc.session.msg(msg_type, content)
        self.kc.control_channel.send(msg)
        while True:
            reply = self.kc.control_channel.get_msg(timeout=30)
            if reply["parent_header"].get("msg_id") == msg["header"]["msg_id"]:
                return reply["content"]

    def send(self, code, subshell=None, silent=False):
        """Send an execute request: a cell of the notebook, or with ``silent`` as the view sends its programs."""
        content = {"code": code, "silent": silent, "store_history": not silent, "user_expressions": {}, "allow_stdin": False, "stop_on_error": True}
        msg = self.kc.session.msg("execute_request", content)
        if subshell is not None:
            msg["header"]["subshell_id"] = subshell
        self.kc.shell_channel.send(msg)
        return msg["header"]["msg_id"]

    def pump(self, done, timeout=60):
        """Read the kernel's messages until ``done()`` holds."""
        zmq = self.zmq
        poller = zmq.Poller()
        poller.register(self.kc.iopub_channel.socket, zmq.POLLIN)
        poller.register(self.kc.shell_channel.socket, zmq.POLLIN)
        deadline = time.monotonic() + timeout
        while not done():
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"No end in {timeout} s")
            for socket, _ in poller.poll(left * 1000):
                while True:
                    _, msg = self.kc.session.recv(socket, mode=zmq.NOBLOCK)
                    if msg is None:
                        break
                    parent = msg["parent_header"].get("msg_id")
                    kind = msg["msg_type"]
                    if kind == "execute_reply":
                        self.replies[parent] = msg["content"]
                    elif kind == "status" and msg["content"]["execution_state"] == "idle":
                        self.idle.add(parent)
                    elif kind in ("display_data", "execute_result"):
                        self.outputs[parent].append(msg["content"]["data"])
                    elif kind == "error":
                        self.outputs[parent].append({"error": f"{msg['content']['ename']}: {msg['content']['evalue']}"})
                    elif kind == "stream":
                        self.stdout[parent] += msg["content"]["text"]

    def wait(self, msg_id):
        self.pump(lambda: msg_id in self.replies and msg_id in self.idle)
        return msg_id

    def mimes(self, msg_id):
        return [sorted(data) for data in self.outputs[msg_id]]

    def close(self):
        self.kc.stop_channels()
        self.km.shutdown_kernel(now=True)


VISITS = 'import pandas as pd\nimport matplotlib.pyplot as plt\nvisits = pd.DataFrame({"week": list(range(20)), "pain": [float(i % 5) for i in range(20)]})'
PLOT = 'fig, ax = plt.subplots()\nax.scatter(visits.week, visits.pain)\nax.set_xlabel("week")\nax.set_ylabel("pain");'
BROKEN = f'import matplotlib.axes\n_shipped = matplotlib.axes.Axes.get_xlabel\ndef _moved(self):\n    raise AttributeError("get_xlabel moved")\nmatplotlib.axes.Axes.get_xlabel = _moved\n{PLOT}'
RESTORED = f"matplotlib.axes.Axes.get_xlabel = _shipped\n{PLOT}"


def test_a_figure_drawn_while_the_view_reads_the_kernel_in_a_subshell_shows_in_its_cell(tmp_path, monkeypatch):
    pytest.importorskip("jupyter_client")
    pytest.importorskip("pandas")
    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(tmp_path / "runtime"))
    kernel = Kernel(tmp_path)
    try:
        if "kernel subshells" not in kernel.info.get("supported_features", []):
            pytest.skip("this ipykernel has no subshells")
        subshell = kernel.control("create_subshell_request", {})["subshell_id"]

        def view(code):
            """A request of the view: silent, in its subshell, one at a time."""
            return kernel.wait(kernel.send(code, subshell, silent=True))

        requests = [view(call("plot_hooks", {}))]
        kernel.wait(kernel.send(VISITS))
        # The cells of the UI test in ui-tests/tests/plots.spec.ts. The second
        # breaks the Axes for the hook, draws, and waits while the view reads
        # the kernel, as it does 300 ms after the cell before.
        waits = '\nprint("drawn", flush=True)\nimport time\nwhile not globals().get("_whybook_test_go"):\n    time.sleep(0.01)'
        cell = kernel.send(BROKEN + waits)
        kernel.pump(lambda: "drawn" in kernel.stdout[cell])
        requests.append(view(call("inspect_variables", {"known": {}})))
        sources = [VISITS, BROKEN + waits, RESTORED]
        requests.append(view(call("analyze_cells", {"cells": [{"id": f"cell-{i}", "source": s} for i, s in enumerate(sources)]})))
        requests.append(view("_whybook_test_go = True"))
        kernel.wait(cell)
        after = kernel.wait(kernel.send(RESTORED))
        requests.append(view(call("plot_hooks", {})))
        # Each figure shows in its cell, as matplotlib ships it: the hook
        # raised on the first and removed itself.
        assert kernel.mimes(cell) == [["image/png", "text/plain"]]
        assert kernel.mimes(after) == [["image/png", "text/plain"]]
        report = kernel.outputs[requests[-1]][-1][RESULT_MIME]
        assert report["hooks"]["matplotlib"] == {"state": "failed", "reason": "AttributeError: get_xlabel moved"}
        # The view's requests got their results, and no figure.
        for request in requests:
            assert all(mimes == [RESULT_MIME] for mimes in kernel.mimes(request)), kernel.mimes(request)
    finally:
        kernel.close()


def test_a_pandas_hook_that_raises_removes_itself_and_the_plot_is_as_before(shell, monkeypatch):
    import pandas as pd
    from pandas.plotting._core import PlotAccessor

    shipped = PlotAccessor.__call__

    def forgetful(self, *args, **kwargs):
        # A pandas that keeps no frame on its accessor once it plotted.
        result = shipped(self, *args, **kwargs)
        del self._parent
        return result

    monkeypatch.setattr(PlotAccessor, "__call__", forgetful)
    assert hooks(shell)["pandas"]["state"] == "on"
    assert PlotAccessor.__call__ is not forgetful
    shell.user_ns["hooks_c"] = pd.DataFrame({"hook_p": [1, 2, 3], "hook_q": [3, 1, 2]})
    ax = run(shell, "_ax = hooks_c.plot.scatter(x='hook_p', y='hook_q', figsize=(3, 2))", "_ax")
    assert ax.get_xlabel() == "hook_p"
    report = hooks(shell)
    assert report["pandas"] == {"state": "failed", "reason": "AttributeError: 'PlotAccessor' object has no attribute '_parent'"}
    assert PlotAccessor.__call__ is forgetful
    # The matplotlib hook stays, and finds the frame by its columns.
    (axes,) = shell.display_formatter.format(ax.figure)[0][AXES_MIME]["axes"]
    assert (axes["frame"], axes["x"]["column"]) == ("hooks_c", "hook_p")


def test_a_hook_waits_for_its_library_and_registers_after_a_cell(shell, monkeypatch):
    monkeypatch.delitem(sys.modules, "pandas.plotting._core")
    assert hooks(shell)["pandas"] == {"state": "waiting", "reason": None}
    monkeypatch.undo()
    # After each cell the hooks of libraries imported since register.
    assert shell.run_cell("pass").success
    assert hooks(shell)["pandas"]["state"] == "on"


def test_installing_again_changes_nothing_and_uninstalling_removes_everything(shell):
    from matplotlib.figure import Figure
    from pandas.plotting._core import PlotAccessor

    chart_types = pytest.importorskip("plotly.express._chart_types")
    shipped = PlotAccessor.__call__
    shipped_px = chart_types.make_figure
    formatters = dict(shell.display_formatter.formatters)
    pytest.importorskip("ninejs")
    from ninejs.main import interactive

    first = hooks(shell)
    assert {name: hook["state"] for name, hook in first.items()} == {"matplotlib": "on", "pandas": "on", "plotly": "on", "ninejs": "on"}
    wrapped = PlotAccessor.__call__
    assert wrapped is not shipped
    assert chart_types.make_figure is not shipped_px
    # The guard that runs no pre_execute and post_execute callbacks for the view's requests.
    guard = vars(shell.events)["trigger"]
    assert hooks(shell) == first
    assert PlotAccessor.__call__ is wrapped
    assert vars(shell.events)["trigger"] is guard
    assert list(shell.display_formatter.formatters) == [*formatters, AXES_MIME]
    assert hooks(shell, {"uninstall": True}) == {}
    assert "trigger" not in vars(shell.events)
    assert shell.display_formatter.formatters == formatters
    assert PlotAccessor.__call__ is shipped
    assert chart_types.make_figure is shipped_px
    bundles = shell.display_formatter.mimebundle_formatter
    assert interactive not in bundles.type_printers
    assert ("ninejs.main", "interactive") not in bundles.deferred_printers
    with pytest.raises(KeyError):
        shell.display_formatter.mimebundle_formatter.lookup_by_type(Figure)
    assert not hasattr(shell, "_whybook_plot_hooks")
    assert not [name for name in shell.user_ns if name.startswith("_whybook_")]


def test_plotly_express_names_its_frame_and_columns(shell):
    pytest.importorskip("plotly.express")
    run(shell, "import pandas as pd\nimport plotly.express as px\nhooks_px = pd.DataFrame({'hook_w': [1, 2, 3, 4], 'hook_p': [2.0, 1.0, 4.0, 3.0], 'hook_arm': list('ABAB')})")
    assert hooks(shell)["plotly"]["state"] == "on"
    # Axis titles renamed by labels= name no column: the note still does.
    figure = run(shell, "_fig = px.scatter(hooks_px, x='hook_w', y='hook_p', color='hook_arm', labels={'hook_w': 'Week'})", "_fig")
    assert figure.layout.xaxis.title.text == "Week"
    assert figure.layout.meta == {"whybook": {"x": "hook_w", "y": "hook_p", "color": "hook_arm", "frame": "hooks_px"}}
    # A frame with no name of its own: its columns alone.
    figure = run(shell, "_fig = px.scatter(hooks_px[hooks_px.hook_w > 1], x='hook_w', y='hook_p')", "_fig")
    assert figure.layout.meta == {"whybook": {"x": "hook_w", "y": "hook_p"}}
    # Lists, and a meta of the user's own, stay as they were.
    assert run(shell, "_fig = px.scatter(x=[1, 2], y=[3, 4])", "_fig").layout.meta is None
    figure = run(shell, "_fig = px.scatter(hooks_px, x='hook_w', y='hook_p')\n_fig.update_layout(meta={'mine': 1})", "_fig")
    assert figure.layout.meta == {"mine": 1}


def test_a_plotly_hook_that_raises_leaves_the_figure_as_plotly_makes_it(shell, monkeypatch):
    pytest.importorskip("plotly.express")
    from plotly.graph_objs import Layout

    run(shell, "import pandas as pd\nimport plotly.express as px\nhooks_px = pd.DataFrame({'hook_w': [1, 2, 3], 'hook_p': [2.0, 1.0, 4.0]})")
    call = "_fig = px.scatter(hooks_px, x='hook_w', y='hook_p')"
    upstream = run(shell, call, "_fig").to_dict()
    assert hooks(shell)["plotly"]["state"] == "on"

    # A Plotly whose layout refuses the hook's meta.
    def refuse(self, value):
        raise ValueError("meta refused")

    monkeypatch.setattr(Layout, "meta", property(lambda self: None, refuse))
    assert run(shell, call, "_fig").to_dict() == upstream
    assert hooks(shell)["plotly"] == {"state": "failed", "reason": "ValueError: meta refused"}
    import plotly.express._chart_types as chart_types
    from plotly.express._core import make_figure

    assert chart_types.make_figure is make_figure


def test_a_plotly_express_it_cannot_wrap_is_left_alone(shell, monkeypatch):
    pytest.importorskip("plotly.express")
    import plotly.express._chart_types as chart_types

    shipped = chart_types.make_figure
    monkeypatch.setattr(chart_types, "make_figure", lambda *given, **named: shipped(*given, **named))
    report = hooks(shell)
    assert report["plotly"] == {"state": "skipped", "reason": "RuntimeError: plotly.express's make_figure takes no args"}
    run(shell, "import pandas as pd\nimport plotly.express as px\nhooks_px = pd.DataFrame({'hook_w': [1, 2], 'hook_p': [2.0, 1.0]})")
    assert run(shell, "_fig = px.scatter(hooks_px, x='hook_w', y='hook_p')", "_fig").layout.meta is None


NINEJS_FRAME = "import numpy as np\nimport pandas as pd\nfrom plotnine import aes, geom_point, ggplot\nfrom ninejs import interactive\nhooks_nine = pd.DataFrame({'hook_age': [20, 35, 50, 65], 'hook_pain': [2.0, 7.5, 4.0, 5.5], 'hook_arm': list('ABAB')})"
NINEJS_CHART = "_chart = interactive(ggplot(hooks_nine, aes('hook_age', 'hook_pain', color='hook_arm')) + geom_point())"


def svg_points(html):
    """The centres of the points that matplotlib wrote into the SVG of a ninejs frame, in order: each is a path of its own."""
    import html as markup
    import re

    document = markup.unescape(re.search(r'srcdoc="([^"]*)"', html).group(1))
    collection = document[document.index('<g id="PathCollection_1">') :]
    collection = collection[: collection.index("</g>")]
    centres = []
    for path in re.findall(r'<path d="([^"]+)"', collection):
        numbers = [float(value) for value in re.findall(r"[-\d.]+", path)]
        xs, ys = numbers[0::2], numbers[1::2]
        centres.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
    return centres


def test_a_ninejs_chart_gets_the_axes_of_its_figure_in_the_points_of_its_svg(shell):
    pytest.importorskip("ninejs")
    pytest.importorskip("plotnine")
    run(shell, NINEJS_FRAME)
    assert hooks(shell)["ninejs"]["state"] == "on"
    data, _ = shell.display_formatter.format(run(shell, NINEJS_CHART, "_chart"))
    assert "ninejs interactive plot" in data["text/html"]
    payload = data[AXES_MIME]
    assert payload["library"] == "ninejs"
    # The SVG's own size: 6.4 by 4.8 inches of plotnine, at 72 points to the inch.
    assert payload["image"] == {"width": 460.8, "height": 345.6, "scale": 1}
    (axes,) = payload["axes"]
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"], axes["kind"]) == ("hooks_nine", "hook_age", "hook_pain", "scatter")
    # The box and the limits put each row's point where the SVG draws it.
    frame = shell.user_ns["hooks_nine"]
    drawn = svg_points(data["text/html"])
    assert len(drawn) == len(frame)
    for (x, y), found in zip(zip(frame.hook_age, frame.hook_pain), drawn):
        assert at(axes, x, y) == pytest.approx(found, abs=0.5)
    # A chart the reader can zoom gets no Axes: a box would not map to it.
    zoomable = run(shell, NINEJS_CHART.replace("geom_point())", "geom_point(), zoomable=True)"), "_chart")
    assert AXES_MIME not in shell.display_formatter.format(zoomable)[0]


def test_a_ninejs_that_changed_leaves_its_charts_as_it_ships_them(shell, monkeypatch):
    pytest.importorskip("ninejs")
    pytest.importorskip("plotnine")
    run(shell, NINEJS_FRAME)
    assert hooks(shell)["ninejs"]["state"] == "on"
    # A later ninejs that keeps its figure under another name.
    chart = run(shell, NINEJS_CHART, "_chart")
    monkeypatch.delattr(chart, "fig")
    data, _ = shell.display_formatter.format(chart)
    assert AXES_MIME not in data
    assert "ninejs interactive plot" in data["text/html"]
    assert hooks(shell)["ninejs"] == {"state": "failed", "reason": "RuntimeError: this ninejs keeps no plot or figure on its charts"}
    from ninejs.main import interactive

    bundles = shell.display_formatter.mimebundle_formatter
    assert interactive not in bundles.type_printers
    assert ("ninejs.main", "interactive") not in bundles.deferred_printers


def test_a_ninejs_chart_of_a_frame_the_view_cannot_tell_names_no_columns(shell):
    pytest.importorskip("ninejs")
    pytest.importorskip("plotnine")
    run(shell, NINEJS_FRAME)
    hooks(shell)
    # A copy has the same points: either frame could be the one plotted.
    run(shell, "hooks_copy = hooks_nine.copy()")
    data, _ = shell.display_formatter.format(run(shell, NINEJS_CHART, "_chart"))
    (axes,) = data[AXES_MIME]["axes"]
    assert (axes["frame"], axes["x"]["column"], axes["y"]["column"]) == (None, None, None)

