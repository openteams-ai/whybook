"""The code that the view sends to run a program of kernel_code/ in a Python kernel.

``call`` writes it as PYTHON.call in src/model/languages.ts does: the program
and its call run in globals of their own, which hold the builtins and the
arguments. ``run`` runs it in an IPython shell and returns the program's
result. data/kernel_call.json holds what the view sends for one program and
its arguments: src/__tests__/future.spec.ts checks the view against it, and
test_kernel_globals.py checks ``call``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import IPython.display

KERNEL_CODE = Path(__file__).resolve().parents[1] / "kernel_code"
RESULT_MIME = "application/vnd.whybook.result+json"


def _json(value: Any) -> str:
    """``value`` as JavaScript's JSON.stringify writes it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def call(name: str, args: Any, program: str | None = None) -> str:
    """The code that runs the program of kernel_code/<name>.py, or ``program``, with ``args``."""
    if program is None:
        program = (KERNEL_CODE / f"{name}.py").read_text()
    source = _json(f"{program}\n_whybook_{name}(_whybook_args)\n")
    return f'__import__("builtins").exec({source}, {{"_whybook_args": __import__("json").loads({_json(_json(args))})}})\n'


def run(shell: Any, name: str, args: Any, program: str | None = None) -> Any:
    """Run a program in ``shell`` as the view runs it, and return what it shows with the result MIME type."""
    return execute(shell, call(name, args, program), name)


def execute(shell: Any, code: str, name: str = "the code") -> Any:
    """Run code in ``shell`` as a silent request, as the view sends a program, and return what it shows with the result MIME type."""
    shown = []
    original = IPython.display.display
    IPython.display.display = lambda data, raw=False, **kw: shown.append(data)
    try:
        result = shell.run_cell(code, silent=True)
    finally:
        IPython.display.display = original
    if not result.success:
        raise RuntimeError(f"{name} failed: {result.error_in_exec!r}")
    return next(item[RESULT_MIME] for item in reversed(shown) if RESULT_MIME in item)
