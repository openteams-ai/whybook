"""The demo notebook's kernel state, in-process, for tests of the kernel code and the templates.

``DemoState`` runs the demo notebook's cells in an IPython shell with the demo
folder as the working directory, then calls the kernel code the way the
frontend does: define the function, call it with JSON arguments, delete it.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any

import IPython.display
import nbformat

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "examples" / "pain_diary"
KERNEL_CODE = ROOT / "whybook" / "server" / "kernel_code"
RESULT_MIME = "application/vnd.whybook.result+json"


class DemoState:
    def __init__(self, skip: tuple[str, ...] = ("ordinal",)):
        from IPython.core.interactiveshell import InteractiveShell
        from traitlets.config import Config

        warnings.simplefilter("ignore")
        self._cwd = os.getcwd()
        os.chdir(DEMO)
        sys.path.insert(0, str(DEMO))
        # History in memory: the history file on disk is shared with the
        # user's kernels, and IPython moves it aside when two processes
        # write to it at once.
        config = Config()
        config.HistoryManager.hist_file = ":memory:"
        self.shell = InteractiveShell.instance(config=config)
        notebook = nbformat.read(DEMO / "pain_diary_cohort.ipynb", 4)
        self.cells = [cell for cell in notebook.cells if cell.cell_type == "code"]
        self.metadata = notebook.metadata.get("whybook", {})
        for cell in self.cells:
            if cell.id in skip:
                continue
            result = self.shell.run_cell(cell.source, silent=True)
            if not result.success:
                raise RuntimeError(f"demo cell {cell.id} failed: {result.error_in_exec!r}")
        self.snapshot = self.kernel("inspect_variables", {})
        self.analysis = self.kernel("analyze_cells", {"cells": [{"id": c.id, "source": c.source} for c in self.cells]})["cells"]

    def close(self) -> None:
        os.chdir(self._cwd)
        if str(DEMO) in sys.path:
            sys.path.remove(str(DEMO))

    def kernel(self, name: str, args: dict[str, Any]) -> Any:
        """Run one kernel code snippet and return its result."""
        shown = []
        original = IPython.display.display
        IPython.display.display = lambda data, raw=False, **kw: shown.append(data)
        try:
            source = (KERNEL_CODE / f"{name}.py").read_text()
            code = f"{source}\ntry:\n    _whybook_{name}(__import__('json').loads({json.dumps(json.dumps(args))}))\nfinally:\n    del _whybook_{name}\n"
            result = self.shell.run_cell(code, silent=True)
            if not result.success:
                raise RuntimeError(f"{name} failed: {result.error_in_exec!r}")
        finally:
            IPython.display.display = original
        return next(item[RESULT_MIME] for item in reversed(shown) if RESULT_MIME in item)

    def variable(self, name: str) -> dict[str, Any]:
        return next(v for v in self.snapshot["variables"] if v["name"] == name)

    def column(self, frame: str, label: str) -> dict[str, Any]:
        column = next(c for c in self.variable(frame)["columns"] if c["label"] == label)
        return {**column, "name": f"{frame}[{label!r}]", "parent": frame, "rows": self.variable(frame)["rows"]}

    def context(self) -> dict[str, Any]:
        frames = {
            v["name"]: {"rows": v["rows"], "columns": {c["label"]: c["tag"] for c in v["columns"]}}
            for v in self.snapshot["variables"]
            if v["kind"] == "dataframe"
        }
        used = sorted({column for a in self.analysis.values() for columns in a.get("columns", {}).values() for column in columns})
        return {
            "outcome": self.metadata.get("outcome"),
            "unit": self.metadata.get("unit"),
            "frames": frames,
            "used": used,
            "asked": [],
        }

    def cell(self, cell_id: str, label: str | None = None) -> dict[str, Any]:
        cell = next(c for c in self.cells if c.id == cell_id)
        analysis = self.analysis.get(cell_id, {})
        index = self.cells.index(cell) + 1
        return {
            "id": cell.id,
            "label": label or f"[{index}]",
            "source": cell.source,
            "title": cell.metadata.get("whybook", {}).get("title", ""),
            "defs": analysis.get("defs", []),
            "uses": analysis.get("uses", []),
            "formulas": analysis.get("formulas", []),
            "columns": analysis.get("columns", {}),
            "decisions": analysis.get("decisions", []),
            "outputs": ["plot"] if "whybook.ribbon" in cell.source else [],
        }

    def cells_json(self) -> list[dict[str, Any]]:
        return [self.cell(c.id) for c in self.cells]

    def run(self, code: str) -> Any:
        """Run generated code; raise if it fails."""
        result = self.shell.run_cell(code, silent=True)
        if not result.success:
            raise RuntimeError(f"generated code failed: {result.error_in_exec!r}\n{code}")
        return result
