"""What the prompts that write code say about the language of the notebook's kernel.

The kernel's language_info.name picks the entry. A language without an entry
gets one made from its name: the model writes in that language and keeps to
its conventions.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    # As the prompts name it: Python, R.
    name: str
    # How a cell loads a module or a package: "with import".
    load: str = ""
    # How a cell removes a value that it no longer needs: "with del".
    remove: str = ""
    # The types of data frames that a variable's "type" may name.
    frames: str = ""
    # For the agent: how to load a file of code again after a change.
    reload: str = ""
    # The view's helpers that the code may call, as a paragraph of the prompt.
    helpers: str = ""
    # What a branch does besides its change.
    branch: str = ""
    # Whether the code that the server writes, the templates' code, the code
    # that loads a dropped file and the imports it adds, runs in this language.
    templates: bool = False


PYTHON = Language(
    name="Python",
    load="with import",
    remove="with del",
    frames="such as polars.dataframe.frame.DataFrame for polars",
    reload="After you change a module that the notebook imported, reload it with importlib.reload.",
    helpers=(
        'If "packages" lists whybook, import it (import whybook) and use its helpers: '
        "whybook.ribbon(data, x, y, by), whybook.scatter(data, x, y),\n"
        "whybook.hist(data, x) and whybook.bars(data, x, y) draw plots whose regions map back to rows, and\n"
        "whybook.progress(fraction, stage) shows a progress bar during a long loop."
    ),
    branch="Report progress with whybook.progress in loops.",
    templates=True,
)

R = Language(
    name="R",
    load="with library()",
    remove="with rm()",
    frames="such as data.frame, tbl_df or data.table",
    reload="After you change a file of code that the notebook sources, source() it again.",
)

LANGUAGES = {"python": PYTHON, "r": R}


def language(name: str | None) -> Language:
    """The entry for a kernel's language_info.name, or one made from the name; Python without a name."""
    key = (name or "").strip().lower() or "python"
    found = LANGUAGES.get(key)
    if found is not None:
        return found
    shown = (name or "").strip()
    return Language(name=shown[:1].upper() + shown[1:])
