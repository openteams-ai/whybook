"""Whybook: a question-driven view of Jupyter notebooks.

In a notebook, ``import whybook`` gives the helpers that the view reads:
plots whose marks keep the rows behind them, so that the view can ask about
the rows in a region of a plot, and ``progress``, which shows as a progress
bar on the cell that calls it, also in a branch that runs in a subshell.
They load on first use, so that the Jupyter server, which imports this
package to find its extension, loads no plotting code.

The Jupyter server extension is ``whybook.server``.
"""

from __future__ import annotations

import importlib
from typing import Any

# Each helper, and the module that defines it.
_HELPERS = {
    "bars": "plots",
    "hist": "plots",
    "ribbon": "plots",
    "scatter": "plots",
    "progress": "_progress",
    "by_group": "explore",
    "compare_frames": "explore",
    "compare_levels": "explore",
    "cross_table": "explore",
    "effect_by": "explore",
    "icc": "explore",
    "line_up": "explore",
    "profile": "explore",
    "rows_per_unit": "explore",
    "screen": "explore",
    "summary": "explore",
    "time_profile": "explore",
    "who_is_in": "explore",
    "within_between": "explore",
}

__all__ = sorted(_HELPERS)


def __getattr__(name: str) -> Any:
    module = _HELPERS.get(name)
    if module is None:
        raise AttributeError(f"module 'whybook' has no attribute {name!r}")
    return getattr(importlib.import_module(f".{module}", __name__), name)


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_HELPERS))


try:
    from ._version import __version__
except ImportError:  # a checkout that pip has not installed
    __version__ = "dev"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "whybook"}]


def _jupyter_server_extension_points():
    return [{"module": "whybook.server"}]
