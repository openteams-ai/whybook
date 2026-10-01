"""Display helpers shared by the plotting and progress functions."""

from __future__ import annotations

from typing import Any

PLOT_MIME = "application/vnd.whybook.plot+json"
PROGRESS_MIME = "application/vnd.whybook.progress+json"


def shell() -> Any:
    try:
        from IPython import get_ipython
    except ImportError:
        return None
    return get_ipython()


def name_of(value: Any) -> str | None:
    """The name of a user variable that holds ``value``, if there is one."""
    ip = shell()
    if ip is None:
        return None
    for name, candidate in list(ip.user_ns.items()):
        if candidate is value and not name.startswith("_"):
            return name
    return None


def current_request() -> str | None:
    """The id of the execute request that is running in this thread.

    ipykernel 7 keeps the parent message in a context variable, so this is
    also right inside a kernel subshell.
    """
    ip = shell()
    kernel = getattr(ip, "kernel", None)
    if kernel is None:
        return None
    try:
        return kernel.get_parent()["header"]["msg_id"]
    except (KeyError, TypeError, AttributeError):
        return None


def show(bundle: dict[str, Any], **kwargs: Any) -> None:
    from IPython.display import display

    display(bundle, raw=True, **kwargs)
