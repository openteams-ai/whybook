"""Progress bars for long cells, including branches that run in subshells."""

from __future__ import annotations

import uuid

from ._display import PROGRESS_MIME, current_request, show

# One display per execute request: a new run of the cell starts a new bar.
_displays: dict[str | None, str] = {}


def progress(fraction: float, stage: str | None = None) -> None:
    """Report how far the running cell is, from 0 to 1.

    The Whybook view draws a progress bar on the cell. A classic notebook
    shows the same report as one line of text that updates in place.
    """
    fraction = min(max(float(fraction), 0.0), 1.0)
    request = current_request()
    bundle = {
        PROGRESS_MIME: {"fraction": fraction, "stage": stage},
        "text/plain": f"[{fraction:4.0%}] {stage or ''}".rstrip(),
    }
    display_id = _displays.get(request)
    if display_id is None:
        display_id = _displays[request] = uuid.uuid4().hex
        show(bundle, display_id=display_id)
    else:
        from IPython.display import update_display

        update_display(bundle, raw=True, display_id=display_id)
    if fraction >= 1.0:
        _displays.pop(request, None)
