"""Hooks that add what the view needs to the outputs of plotting libraries.

The view runs this in each Python kernel before it runs a cell there, and again
after a restart. A second run changes nothing: the hooks keep their state on the
shell, away from the user's namespace. ``{"uninstall": true}`` removes them all.

Each library has one hook, and each hook registers inside its own try/except. A
hook that cannot register (the library is too old, or another hook already holds
the place this one needs) is skipped, and the library's outputs stay as the
library ships them. A hook that raises while an output is displayed removes
itself for that library and adds nothing to that output, so IPython shows the
output as the library ships it. Neither case prints anything in the cell.

matplotlib: the display bundle of a figure drawn as a PNG gets one more entry,
``application/vnd.whybook.axes+json``. For each Axes it gives the box of the Axes in
the PNG (in the PNG's pixels, from the top left), the limits and scales of its
axes, their labels, and the columns and the frame that the labels name when a
cheap check tells. The box is read during the draw that makes the PNG, so it
follows ``bbox_inches="tight"`` and its pad, the dpi and the retina factor, and
the figure is not drawn once more. pandas' ``.plot`` and seaborn draw on Axes,
so their figures get the same entry.

pandas: ``DataFrame.plot`` notes on each Axes it returns the frame it plotted
and the columns it put on x and y, so that the matplotlib hook names the frame.

ninejs: a chart that ``ninejs.interactive`` makes gets the same entry as a
matplotlib figure, for the figure it drew as SVG, in the SVG's points: its
Axes and their limits, and the frame and the two columns whose values are the
points it draws, in order, when exactly one frame of the namespace has them.
The printer is registered by the name of the chart's class, so it applies from
the first chart, also in the cell that imports ninejs. A chart the reader can
zoom (``zoomable=True``) gets none, since a box on it would no longer map to
the figure.

Plotly Express: each figure it makes gets ``layout.meta["whybook"]``, with the name
of the frame it plotted and the columns on x, y and colour, which the view
reads in place of the axis titles. The hooks of pandas and Plotly Express wait
for their library: they register after the first cell that imports it.

The view's own requests: the view sends this program and its other programs,
such as the listing of the variables and the analysis of the cells, as silent
requests to a subshell, which runs them in a thread of its own while a cell
may run in the main shell. IPython calls the pre_execute and post_execute
callbacks of every request, silent ones too, in the thread that runs it.
matplotlib's inline backend flushes its figures in a post_execute callback: it
shows every figure that pyplot holds open, in the output of that request, and
closes them all. A request of the view that ended while a cell drew in the
main shell showed that cell's figure in the view's request, which the view
does not show, and closed it: the cell ended with no figure. So the
pre_execute and post_execute callbacks do not run for a silent request in a
subshell. This stays when a hook removes itself, and goes with
``{"uninstall": true}``.

The frontend bundle holds the text of this file and runs it in the kernel, so it
must not import the whybook package.
"""


def _whybook_plot_hooks(args):
    import math
    import re
    import sys
    import threading
    import weakref

    from IPython import get_ipython
    from IPython.display import display

    result_mime = "application/vnd.whybook.result+json"
    axes_mime = "application/vnd.whybook.axes+json"
    # Version 2 runs no pre_execute and post_execute callbacks for the view's
    # requests: a kernel that has version 1 gets the hooks again.
    version = 2

    shell = get_ipython()
    state = getattr(shell, "_whybook_plot_hooks", None)

    def report(hooks):
        return {"version": version, "hooks": {name: {"state": hook["state"], "reason": hook["reason"]} for name, hook in hooks.items()}}

    if state is not None and (args.get("uninstall") or state["version"] != version):
        # An older version of the hooks, or a request to remove them.
        for hook in state["hooks"].values():
            if hook["remove"] is not None:
                try:
                    hook["remove"]()
                except Exception:
                    pass
        if state.get("quiet") is not None:
            try:
                state["quiet"]()
            except Exception:
                pass
        try:
            shell.events.unregister("post_run_cell", state["pending"])
        except ValueError:
            pass
        del shell._whybook_plot_hooks
        state = None
    if args.get("uninstall"):
        display({result_mime: report({})}, raw=True)
        return
    if state is not None:
        state["pending"]()
        display({result_mime: report(state["hooks"])}, raw=True)
        return

    # Axes that pandas plotted, with the frame and the columns: the pandas hook
    # writes them, and the matplotlib hook reads them.
    notes = weakref.WeakKeyDictionary()
    state = {"version": version, "hooks": {}, "notes": notes, "pending": None, "quiet": None}
    # Cells in subshells run in threads of their own, and each runs the hooks
    # of newly imported libraries after it.
    lock = threading.Lock()

    def describe_error(error):
        return f"{type(error).__name__}: {error}"

    def fail(name, error):
        """Remove the hook of a library after it raised while an output was displayed."""
        hook = state["hooks"].get(name)
        if hook is None or hook["state"] != "on":
            return
        hook["state"] = "failed"
        hook["reason"] = describe_error(error)
        remove, hook["remove"] = hook["remove"], None
        try:
            remove()
        except Exception:
            pass

    def register(name, install):
        """Register one library's hook; a hook that raises is skipped and leaves nothing behind."""
        with lock:
            hook = state["hooks"].setdefault(name, {"state": "waiting", "reason": None, "remove": None})
            if hook["state"] != "waiting":
                return
            try:
                remove = install()
            except Exception as error:
                hook["state"] = "skipped"
                hook["reason"] = describe_error(error)
                return
            if remove is not None:
                hook["state"] = "on"
                hook["remove"] = remove

    # The view's own requests.

    def quiet_request():
        """Whether this thread runs a silent request in a subshell, as the view's programs are."""
        try:
            parent = shell.get_parent()
            header = parent.get("header") or {}
            content = parent.get("content") or {}
        except Exception:
            # A shell outside a kernel has no request.
            return False
        return header.get("msg_type") == "execute_request" and bool(header.get("subshell_id")) and bool(content.get("silent"))

    def keep_quiet():
        """Run no pre_execute and post_execute callbacks for a silent request in a subshell.

        A subshell runs its requests in a thread of its own, while a cell may
        run in the main shell, and the callbacks work on the whole kernel:
        matplotlib's inline backend shows and closes every open figure.
        """
        events = shell.events
        own = "trigger" in vars(events)
        shipped = events.trigger

        def trigger(event, *args, **kwargs):
            if event in ("pre_execute", "post_execute") and quiet_request():
                return None
            return shipped(event, *args, **kwargs)

        events.trigger = trigger

        def remove():
            if vars(events).get("trigger") is trigger:
                if own:
                    events.trigger = shipped
                else:
                    del events.trigger

        return remove

    # What the hooks share: the frames of the user's namespace, found cheaply.

    def name_of(value):
        for name, candidate in list(shell.user_ns.items()):
            if candidate is value and not name.startswith("_"):
                return name
        return None

    def frames_in_namespace():
        pandas = sys.modules.get("pandas")
        if pandas is None:
            return []
        frame_type = pandas.DataFrame
        return [(name, value) for name, value in list(shell.user_ns.items()) if not name.startswith("_") and isinstance(value, frame_type)]

    def is_column(frame, label):
        if not isinstance(label, str) or not label:
            return False
        try:
            return bool(label in frame.columns)
        except Exception:
            return False

    # matplotlib.

    def check_matplotlib():
        import matplotlib
        from matplotlib.backend_bases import FigureCanvasBase
        from matplotlib.figure import Figure

        release = tuple(int(part) for part in re.findall(r"\d+", str(matplotlib.__version__))[:2])
        if release < (3, 6):
            raise RuntimeError(f"matplotlib {matplotlib.__version__} is older than 3.6")
        if not isinstance(vars(FigureCanvasBase).get("callbacks"), property):
            # Callbacks kept on each canvas do not reach the canvas that saves the PNG.
            raise RuntimeError("the canvas of this matplotlib keeps its own callbacks")
        if hasattr(Figure, "_repr_mimebundle_"):
            # The hook's printer would take the place of the figure's own.
            raise RuntimeError("matplotlib figures have a _repr_mimebundle_ of their own")

    def figure_printer(bundles):
        """The mime-bundle printer registered for matplotlib figures, if any."""
        printer = bundles.deferred_printers.get(("matplotlib.figure", "Figure"))
        if printer is not None:
            return printer
        for cls, printer in list(bundles.type_printers.items()):
            if (getattr(cls, "__module__", None), getattr(cls, "__name__", None)) == ("matplotlib.figure", "Figure"):
                return printer
        return None

    def count_marks(ax):
        """The points a scatter draws, or else the points of its lines."""
        count = 0
        for collection in ax.collections:
            if type(collection).__name__ == "PathCollection":
                count += len(collection.get_offsets())
        if not count:
            for line in ax.lines:
                count += len(line.get_xdata())
        return count or None

    def columns_of(ax, xlabel, ylabel, marks, frames):
        """The frame and the columns on x and y: from the pandas note, or else from the labels."""
        note = notes.get(ax)
        if note is not None:
            frame = note["frame"]()
            name = name_of(frame) if frame is not None else None
            if name is not None:
                if note["kind"] in ("bar", "barh", "box", "pie"):
                    # Bars and boxes stand at positions, not at values of a column.
                    return name, None, None
                along = note["kind"] in ("line", "scatter", "area")

                def pick(preferred, label):
                    if along and is_column(frame, preferred):
                        return preferred
                    return label if is_column(frame, label) else None

                return name, pick(note["x"], xlabel), pick(note["y"], ylabel)
        having_x = [(name, frame) for name, frame in frames if is_column(frame, xlabel)]
        if not having_x:
            return None, None, None
        having_both = [(name, frame) for name, frame in having_x if is_column(frame, ylabel)]
        candidates = having_both or having_x
        if len(candidates) == 1:
            frame = candidates[0][0]
        else:
            # Several frames have the columns: the one with a row per mark, if only one has.
            same = [name for name, value in candidates if marks is not None and len(value) == marks]
            frame = same[0] if len(same) == 1 else None
        return frame, xlabel, ylabel if having_both else None

    def kind_of(ax):
        """What the Axes draws: the kind of a pandas plot, or else scatter, bar or line."""
        note = notes.get(ax)
        if note is not None and note.get("kind"):
            return note["kind"]
        if any(type(collection).__name__ == "PathCollection" for collection in ax.collections):
            return "scatter"
        if ax.patches and all(type(patch).__name__ == "Rectangle" for patch in ax.patches):
            return "bar"
        if ax.lines:
            return "line"
        return None

    def describe_axes(ax, box, frames):
        """One Axes of the figure, or None when a range of its pixels is not a range of values."""
        if getattr(ax, "name", None) != "rectilinear" or not ax.get_visible() or hasattr(ax, "_colorbar"):
            return None
        scales = (ax.get_xscale(), ax.get_yscale())
        if any(scale not in ("linear", "log") for scale in scales):
            return None
        if ax.xaxis.have_units() or ax.yaxis.have_units():
            # Dates or categories.
            return None
        xlim, ylim = ax.get_xlim(), ax.get_ylim()
        if not all(math.isfinite(value) for value in (*xlim, *ylim)):
            return None
        xlabel, ylabel = str(ax.get_xlabel()), str(ax.get_ylabel())
        marks = count_marks(ax)
        frame, xcolumn, ycolumn = columns_of(ax, xlabel, ylabel, marks, frames)
        return {
            "box": [round(float(value), 2) for value in box],
            "x": {"limits": [float(xlim[0]), float(xlim[1])], "scale": scales[0], "label": xlabel, "column": xcolumn},
            "y": {"limits": [float(ylim[0]), float(ylim[1])], "scale": scales[1], "label": ylabel, "column": ycolumn},
            "title": str(ax.get_title()),
            "frame": frame,
            "marks": marks,
            "kind": kind_of(ax),
        }

    def install_matplotlib():
        from IPython.core.formatters import BaseFormatter
        from traitlets import ObjectName, Unicode

        formatter = shell.display_formatter
        bundles = formatter.mimebundle_formatter
        if axes_mime in formatter.formatters:
            raise RuntimeError(f"another hook already adds {axes_mime}")
        if figure_printer(bundles) is not None:
            raise RuntimeError("another printer is registered for matplotlib figures")
        checked = []
        if "matplotlib.figure" in sys.modules:
            check_matplotlib()
            checked.append(True)
        # Per figure being displayed, and per thread that displays it: the draw
        # it was last drawn with. A cell in a subshell and one in the main shell
        # can show one figure at the same time, each drawing its own PNG.
        captures = weakref.WeakKeyDictionary()

        def on_draw(event, capture, raster):
            # A draw callback that raised would stop the PNG, so it keeps the error.
            try:
                if threading.get_ident() != capture["thread"]:
                    # Another thread draws the figure for an output of its own.
                    return
                renderer = event.renderer
                if not isinstance(renderer, raster):
                    return
                height = int(renderer.height)
                boxes = []
                for ax in event.canvas.figure.axes:
                    left, bottom, right, top = ax.bbox.extents
                    boxes.append((ax, (left, height - top, right, height - bottom)))
                # A tight box draws twice, and the last draw is the one saved.
                capture["draw"] = {"width": int(renderer.width), "height": height, "dpi": float(renderer.dpi), "boxes": boxes}
            except Exception as error:
                capture["error"] = error

        def before(figure):
            # IPython calls mime-bundle printers first, then the PNG formatter:
            # the callback sees the draw that makes the PNG.
            try:
                if not checked:
                    check_matplotlib()
                    checked.append(True)
                from matplotlib.backends.backend_agg import RendererAgg

                thread = threading.get_ident()
                mine = captures.setdefault(figure, {})
                old = mine.pop(thread, None)
                if old is not None:
                    figure.canvas.mpl_disconnect(old["cid"])
                capture = {"dpi": float(figure.dpi), "draw": None, "error": None, "cid": None, "thread": thread}
                capture["cid"] = figure.canvas.mpl_connect("draw_event", lambda event: on_draw(event, capture, RendererAgg))
                mine[thread] = capture
            except Exception as error:
                fail("matplotlib", error)
            return None

        def after(obj):
            # Called for every object displayed, so anything but a figure goes quickly.
            figure_module = sys.modules.get("matplotlib.figure")
            try:
                if figure_module is None or not isinstance(obj, figure_module.Figure):
                    return None
            except Exception:
                return None
            mine = captures.get(obj)
            capture = mine.pop(threading.get_ident(), None) if mine is not None else None
            if capture is None:
                return None
            try:
                obj.canvas.mpl_disconnect(capture["cid"])
                if capture["error"] is not None:
                    raise capture["error"]
                draw = capture["draw"]
                if draw is None:
                    # No PNG or JPEG was drawn: an SVG or PDF figure.
                    return None
                frames = frames_in_namespace()
                axes = [entry for entry in (describe_axes(ax, box, frames) for ax, box in draw["boxes"]) if entry is not None]
                if not axes:
                    return None
                return {
                    "version": 1,
                    "library": "matplotlib",
                    "image": {"width": draw["width"], "height": draw["height"], "scale": round(draw["dpi"] / capture["dpi"], 3)},
                    "axes": axes,
                }
            except Exception as error:
                fail("matplotlib", error)
                return None

        class AxesFormatter(BaseFormatter):
            """The geometry of a figure's Axes, after its PNG was drawn."""

            format_type = Unicode(axes_mime)
            print_method = ObjectName("_repr_whybook_axes_")

            def __call__(self, obj):
                return after(obj) if self.enabled else None

        added = AxesFormatter(parent=formatter)
        bundles.for_type_by_name("matplotlib.figure", "Figure", before)
        # IPython loops over this dict while it formats an object, maybe in
        # another thread: a new dict takes its place, and the loop goes on
        # over the old one. A key added or deleted in place would stop it.
        try:
            formatter.formatters = {**formatter.formatters, axes_mime: added}
        except Exception:
            bundles.pop("matplotlib.figure.Figure", None)
            raise

        def remove():
            kept = list(formatter.formatters.items())
            if any(value is added for _, value in kept):
                formatter.formatters = {key: value for key, value in kept if value is not added}
            if figure_printer(bundles) is before:
                bundles.pop("matplotlib.figure.Figure", None)
            try:
                for figure, mine in list(captures.items()):
                    for capture in list(mine.values()):
                        figure.canvas.mpl_disconnect(capture["cid"])
            except Exception:
                pass
            captures.clear()

        return remove

    # pandas.

    def note_plot(accessor, args, kwargs, result):
        frame = accessor._parent
        if not isinstance(frame, sys.modules["pandas"].DataFrame):
            return
        # DataFrame.plot takes x, y and kind in this order.
        x = kwargs.get("x", args[0] if len(args) > 0 else None)
        y = kwargs.get("y", args[1] if len(args) > 1 else None)
        kind = kwargs.get("kind", args[2] if len(args) > 2 else "line")
        if hasattr(result, "get_xlim"):
            axes = [result]
        elif hasattr(result, "flat"):
            axes = list(result.flat)
        else:
            axes = list(result) if isinstance(result, (list, tuple)) else []
        reference = weakref.ref(frame)
        for ax in axes:
            if hasattr(ax, "get_xlim"):
                notes[ax] = {
                    "frame": reference,
                    "x": x if isinstance(x, str) else None,
                    "y": y if isinstance(y, str) else None,
                    "kind": kind if isinstance(kind, str) else None,
                }

    def install_pandas():
        core = sys.modules.get("pandas.plotting._core")
        if core is None:
            # pandas is not imported yet: the hook registers after a later cell.
            return None
        import functools

        accessor = core.PlotAccessor
        original = vars(accessor).get("__call__")
        if not callable(original):
            raise RuntimeError("pandas' plot accessor has no __call__ of its own")
        if getattr(original, "_whybook_plot_hooks", False):
            raise RuntimeError("pandas' plot accessor is already wrapped")

        @functools.wraps(original)
        def plot(self, *args, **kwargs):
            result = original(self, *args, **kwargs)
            try:
                note_plot(self, args, kwargs, result)
            except Exception as error:
                fail("pandas", error)
            return result

        plot._whybook_plot_hooks = True
        accessor.__call__ = plot

        def remove():
            if vars(accessor).get("__call__") is plot:
                accessor.__call__ = original
            notes.clear()

        return remove

    # Plotly Express.

    def plotly_note(args):
        """The frame and the columns of a Plotly Express call, before Plotly builds a frame of its own."""
        pandas = sys.modules.get("pandas")
        frame = args.get("data_frame") if isinstance(args, dict) else None
        if pandas is None or not isinstance(frame, pandas.DataFrame):
            return None
        note = {channel: args[channel] for channel in ("x", "y", "color") if is_column(frame, args.get(channel))}
        name = name_of(frame)
        if name is not None:
            note["frame"] = name
        return note or None

    def install_plotly():
        chart_types = sys.modules.get("plotly.express._chart_types")
        if chart_types is None:
            # Plotly Express is not imported yet: the hook registers after a later cell.
            return None
        import functools
        import inspect

        original = vars(chart_types).get("make_figure")
        if not callable(original):
            raise RuntimeError("plotly.express has no make_figure")
        if getattr(original, "_whybook_plot_hooks", False):
            raise RuntimeError("plotly.express is already wrapped")
        taken = inspect.signature(original).parameters.get("args")
        if taken is None or taken.kind not in (taken.POSITIONAL_OR_KEYWORD, taken.KEYWORD_ONLY):
            raise RuntimeError("plotly.express's make_figure takes no args")

        @functools.wraps(original)
        def make_figure(*positional, **keywords):
            note = None
            try:
                note = plotly_note(keywords["args"] if "args" in keywords else positional[0])
            except Exception as error:
                fail("plotly", error)
            figure = original(*positional, **keywords)
            if note is not None:
                try:
                    meta = figure.layout.meta
                    if meta is None or isinstance(meta, dict):
                        # One assignment: a value Plotly refuses leaves the figure as it was.
                        figure.layout.meta = {**(meta or {}), "whybook": note}
                except Exception as error:
                    fail("plotly", error)
            return figure

        make_figure._whybook_plot_hooks = True
        chart_types.make_figure = make_figure

        def remove():
            if vars(chart_types).get("make_figure") is make_figure:
                chart_types.make_figure = original

        return remove

    # ninejs.

    def plotted_frame(ax, frames):
        """The one frame and the two columns whose rows are the points of an Axes, in their order, or None."""
        numpy = sys.modules.get("numpy")
        offsets = next((collection.get_offsets() for collection in ax.collections if type(collection).__name__ == "PathCollection"), None)
        if numpy is None or offsets is None or not len(offsets):
            return None
        points = numpy.asarray(offsets, dtype=float)
        found = []
        for name, frame in frames:
            if len(frame) != len(points):
                continue
            numeric = [column for column in list(frame.columns)[:200] if isinstance(column, str) and frame[column].dtype.kind in "iuf"]

            def same(column, along):
                return bool(numpy.allclose(frame[column].to_numpy(dtype=float), points[:, along], equal_nan=True))

            xs = [column for column in numeric if same(column, 0)]
            ys = [column for column in numeric if same(column, 1)] if xs else []
            found.extend((frame, x, y) for x in xs for y in ys)
            if len(found) > 1:
                # Two frames, or two columns, with the same values: the view cannot tell which.
                return None
        return found[0] if found else None

    def ninejs_payload(chart):
        """The Axes of a ninejs chart in the units of its SVG, or None when a box on the chart cannot map to them."""
        plot = getattr(chart, "plot", None)
        figure = getattr(chart, "fig", None)
        if plot is None or figure is None or not hasattr(figure, "get_figwidth"):
            raise RuntimeError("this ninejs keeps no plot or figure on its charts")
        if getattr(plot, "zoomable", False):
            # The reader can zoom and pan the chart: a box would no longer map to the figure.
            return None
        # matplotlib writes an SVG in points, 72 to the inch.
        width = float(figure.get_figwidth()) * 72
        height = float(figure.get_figheight()) * 72
        frames = frames_in_namespace()
        axes = []
        for ax in figure.axes:
            if ax not in notes:
                # plotnine keeps no link from its figure to its data: the points name the frame.
                match = plotted_frame(ax, frames)
                if match is not None:
                    frame, x, y = match
                    notes[ax] = {"frame": weakref.ref(frame), "x": x, "y": y, "kind": "scatter"}
            left, bottom, right, top = ax.get_position().extents
            box = (left * width, (1 - top) * height, right * width, (1 - bottom) * height)
            entry = describe_axes(ax, box, frames)
            if entry is not None:
                axes.append(entry)
        if not axes:
            return None
        return {"version": 1, "library": "ninejs", "image": {"width": round(width, 3), "height": round(height, 3), "scale": 1}, "axes": axes}

    def ninejs_printer(bundles):
        """The mime-bundle printer registered for ninejs charts, if any."""
        printer = bundles.deferred_printers.get(("ninejs.main", "interactive"))
        if printer is not None:
            return printer
        for cls, printer in list(bundles.type_printers.items()):
            if (getattr(cls, "__module__", None), getattr(cls, "__name__", None)) == ("ninejs.main", "interactive"):
                return printer
        return None

    def install_ninejs():
        bundles = shell.display_formatter.mimebundle_formatter
        if ninejs_printer(bundles) is not None:
            raise RuntimeError("another printer is registered for ninejs charts")

        def bundle(chart):
            # Only the Axes: IPython takes the HTML from the chart's own repr.
            try:
                payload = ninejs_payload(chart)
            except Exception as error:
                fail("ninejs", error)
                return None
            return {axes_mime: payload} if payload else None

        # By name: it applies from the first chart, also in the cell that imports ninejs.
        bundles.for_type_by_name("ninejs.main", "interactive", bundle)

        def remove():
            if bundles.deferred_printers.get(("ninejs.main", "interactive")) is bundle:
                del bundles.deferred_printers[("ninejs.main", "interactive")]
            for cls, printer in list(bundles.type_printers.items()):
                if printer is bundle:
                    bundles.pop(cls, None)

        return remove

    installers = {"matplotlib": install_matplotlib, "pandas": install_pandas, "plotly": install_plotly, "ninejs": install_ninejs}

    def pending(result=None):
        # After each cell: the hooks of libraries imported since.
        try:
            for name, install in installers.items():
                register(name, install)
        except Exception:
            pass

    state["pending"] = pending
    try:
        state["quiet"] = keep_quiet()
    except Exception:
        pass
    shell._whybook_plot_hooks = state
    pending()
    shell.events.register("post_run_cell", pending)
    display({result_mime: report(state["hooks"])}, raw=True)
