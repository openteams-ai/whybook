"""Answers by an agent: a model writes and runs as many cells as a question needs.

A run is one call to the remote model with tools that act in the notebook.
The view runs the tools, not the server: the server sends each tool call to
the browser as an event of the run's stream, the view adds the cell or the
branches and runs them in the kernel, and posts what came out to
``agent/result``. The tool returns that to the model, which goes on or
finishes. So every cell the agent writes is in the notebook, where the
analyst sees it run, and a branch runs in a subshell as the analyst's own do.

With the data kept on the machine (``privacy.py``), a tool result keeps the
kind, size and column names of each output and what a local model wrote
about it, and never its values.

A run can work in a second notebook (design iteration 1.69): new_notebook
makes one beside the analyst's with a kernel of the server, which the view
opens through JupyterLab's commands, and the tools that act in a notebook
take its name as ``notebook``. share_frames has the analyst's kernel write
frames to files that the second notebook reads. The caps count the cells
of both notebooks, and a run makes at most one notebook. A question that
compares two kernels (``compare``) carries the analyst's cells with their
code and saved outputs, and finish carries the estimates of both notebooks,
which the view checks against their outputs.

The server refuses a run_cell whose code only shows a variable that a cell
of the notebook shows already, such as ``tariffs`` under the cell that loads
it (``shows_again``): no cell is added, and the model reads why. The answer
of finish loses any markup of a tool call that the model left in its text,
and a parameter that the markup holds fills the argument the call left out
(``finish_arguments``).

A cell of the run that fails stays failed until the agent fixes it in place,
run_cell with ``fix``, which rewrites that cell and runs it again, or removes
it with remove_cell (design iteration 1.103). The server notes each cell that
failed from what the view says, and finish refuses while one is left in a
notebook, or when the answer cites the label that a cell had when it failed
(``Run.unfinished``). So a notebook that an agent leaves runs from the top
without an error, and its answer cites only cells that ran.

Where a price of the model is known, a run stops at its cost cap: the
server's cap of a run, or what is left under the notebook's cap when the view
sends it, whichever is lower (``AgentRequest.cap``). The run then ends as
stopped, with what it cost; the cells it added stay. A run cannot go on after
it stops: the CLI keeps no session, and Pydantic AI keeps no history once the
run ends.
"""

from __future__ import annotations

import ast
import asyncio
import dataclasses
import json
import logging
import math
import posixpath
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from . import claude, guard, languages, privacy
from .config import Whybook
from .questions.models import InvalidRequest
from .solve import SolveRequest, about_task

log = logging.getLogger(__name__)

# How long the view may take to run one tool: a cell can fit a model.
TOOL_TIMEOUT = 30 * 60
MAX_BRANCHES = 4
# The files that one run may write, and the size of each: a module is the
# exception, and the analysis stays in cells (VISION.md).
MAX_FILES = 3
MAX_FILE_CHARS = 20_000
# While a tool runs, the stream sends a ping this often: writing to a closed
# view raises, which stops the run, where a silent wait would last until the
# tool's timeout.
PING_SECONDS = 15
# The notebooks that one run may make beside the analyst's, and the frames it
# may write to files for them.
MAX_NOTEBOOKS = 1
MAX_FRAMES = 10
# What a request may carry about the server's kernels, the analyst's folder
# and, for a question that compares two kernels, the analyst's cells.
MAX_KERNELS = 20
MAX_FILES_LISTED = 60
MAX_NOTEBOOK_CELLS = 40
MAX_CELL_CODE = 4000
MAX_CELL_OUTPUT = 1500
MAX_COMPARED = 20
# How many times the agent may fix one cell that failed: the prompt asked for
# at most two tries before a fix went in place (design iteration 1.103).
MAX_FIXES = 2
# How many times finish may refuse a run on a driver that counts each refusal
# as a retry of its output, Pydantic AI's: the Claude driver has its turns.
FINISH_REFUSALS = 3

# The argument that names the notebook a tool acts in.
NOTEBOOK_ARGUMENT = {
    "type": "string",
    "description": "The notebook to act in: the name that new_notebook gave. Leave it out to act in the analyst's notebook.",
}

TOOLS: dict[str, dict[str, Any]] = {
    "run_cell": {
        "description": (
            "Add a code cell to a notebook and run it in that notebook's kernel: the analyst's, or"
            " the one that new_notebook made. With fix, rewrite a cell of yours that failed, in its"
            " place, and run it again. Returns the cell's label, whether it ran or failed, the"
            " variables it made, and what its outputs show."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "What the cell does, in at most 8 words, shown above it."},
                "code": {
                    "type": "string",
                    "description": "The code of the cell, in the language of its notebook's kernel: Python for a Python kernel, R for an R kernel.",
                },
                "notebook": NOTEBOOK_ARGUMENT,
                "after": {
                    "type": "string",
                    "description": (
                        "The label of the cell this one goes after, such as [3]. Leave it out to go"
                        " after the last cell you added, or after the cell the question is about."
                    ),
                },
                "why": {"type": "string", "description": "Why this step, in at most 15 words, shown to the analyst."},
                "fix": {
                    "type": "string",
                    "description": (
                        "The label of a cell of yours that failed, such as [4]: the code replaces that"
                        " cell's code, and the cell runs again where it is, with its title. A fix adds"
                        " no cell, and the cell gets a new label when it runs."
                    ),
                },
            },
            "required": ["title", "code"],
        },
    },
    "remove_cell": {
        "description": (
            "Remove a cell of yours that failed, when you cannot fix it or a later cell does its"
            " work. Say in the answer what did not run. Returns whether the cell was removed."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "cell": {"type": "string", "description": "The label of the cell that failed, such as [4]."},
                "notebook": NOTEBOOK_ARGUMENT,
                "why": {"type": "string", "description": "Why it goes, in at most 15 words, shown to the analyst."},
            },
            "required": ["cell"],
        },
    },
    "explore": {
        "description": (
            "Run two to four variants of one cell side by side, each as a branch of it in a"
            " subshell, such as another model, another threshold or another subset. Returns"
            " what each branch shows."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "of": {"type": "string", "description": "The label of the cell that the branches vary, such as [5]."},
                "notebook": NOTEBOOK_ARGUMENT,
                "why": {"type": "string", "description": "What the branches compare, in at most 15 words."},
                "branches": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": MAX_BRANCHES,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "The change this branch makes, in at most 8 words."},
                            "code": {
                                "type": "string",
                                "description": (
                                    "The full code of the branch. Every name it assigns, intermediate values included,"
                                    " is unique to this branch; it never assigns or deletes a name that the notebook"
                                    " or another branch defines, except that it imports a module under its usual name,"
                                    " such as import numpy as np."
                                ),
                            },
                        },
                        "required": ["title", "code"],
                    },
                },
            },
            "required": ["of", "branches"],
        },
    },
    "write_file": {
        "description": (
            "Write a module next to the notebook, for code too long for a cell or that"
            " several cells call, such as a set of functions. Import it in a cell afterwards."
            " Returns the file's path and its number of lines, or why it was refused."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "The file's path from the notebook's folder, a module name ending in .py, such as"
                        " pain_models.py, or in .R for a notebook with an R kernel."
                    ),
                },
                "notebook": NOTEBOOK_ARGUMENT,
                "content": {"type": "string", "description": f"The whole file, at most {MAX_FILE_CHARS} characters."},
                "why": {"type": "string", "description": "Why a file and not a cell, in at most 15 words, shown to the analyst."},
            },
            "required": ["path", "content"],
        },
    },
    "new_notebook": {
        "description": (
            "Make a notebook beside the analyst's, with a kernel of \"kernels\", and open it next to"
            " the analyst's. Its first cell says which question it answers. Returns its name, which"
            " run_cell, explore and write_file take as \"notebook\", the language and version of its"
            f" kernel, whether it reads parquet, and the packages it has. At most {MAX_NOTEBOOKS} a run."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "kernel": {"type": "string", "description": "The name of a kernel in \"kernels\" that can run code, such as xr."},
                "name": {
                    "type": "string",
                    "description": (
                        "The file's name, ending in .ipynb: the analyst's notebook's name with the"
                        " language, such as pain_diary_cohort.R.ipynb. When the analyst's notebook"
                        " is still JupyterLab's Untitled, Untitled3 and so on, a name that says what"
                        " the analysis is about instead, such as smoking_weight_gain.R.ipynb."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": (
                        "What the analysis is about, in a few words, such as Quitting smoking and"
                        " weight gain: the notebook's heading, with the language, when the analyst's"
                        " notebook has no heading and is still Untitled."
                    ),
                },
                "why": {"type": "string", "description": "Why this notebook, in at most 15 words, shown to the analyst."},
            },
            "required": ["kernel", "name"],
        },
    },
    "share_frames": {
        "description": (
            "Write data frames of the analyst's kernel to files that the new notebook reads. A fixed"
            " program of the view writes them in the analyst's kernel, as parquet when both kernels"
            " can, else as CSV, and the analyst's notebook gets no cell. Returns each file's path"
            " from the notebooks' folder, its format, its size and its columns."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "frames": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": MAX_FRAMES,
                    "description": "The names of data frames in \"variables\" that the cells you port read.",
                },
                "notebook": {"type": "string", "description": "The notebook that reads the files: the name that new_notebook gave."},
                "why": {"type": "string", "description": "Why these frames, in at most 15 words, shown to the analyst."},
            },
            "required": ["frames", "notebook"],
        },
    },
    "finish": {
        "description": (
            "End the run with the answer, last. It refuses while a cell of yours that failed is in a"
            " notebook, or when the answer cites one, and says why: fix or remove that cell, then"
            " call it again."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "answer": {
                    "type": "string",
                    "description": (
                        "The answer in at most 3 sentences, in plain words, citing the cells that show it by"
                        " label, such as [7]. Cite only cells that ran without an error. The questions that"
                        " the answer raises go in follow_up alone: the view shows them under the answer."
                    ),
                },
                "cells": {"type": "array", "items": {"type": "string"}, "description": "The labels of the cells that show the answer."},
                "follow_up": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 3,
                    # The types, as the one-cell prompt names them: without them, 42 of the 55
                    # follow-ups of the demo video's runs had none or one of the model's own,
                    # such as "robustness", and the view showed each as Descriptive
                    # (design iteration 1.100).
                    "description": (
                        "Up to 3 questions the answer raises, each as its type, a colon and the question,"
                        ' such as "association: Does sleep relate to pain?". The type is association,'
                        " causal, quality (data quality), model (a model check) or descriptive."
                    ),
                },
                "comparison": {
                    "type": "object",
                    "description": (
                        "When the question compares the analyst's notebook with the one you made: the"
                        " estimates of both, which the view checks against the outputs of the cells"
                        " you name. The view adds the defaults that differ between the two languages."
                    ),
                    "properties": {
                        "rows": {
                            "type": "array",
                            "maxItems": MAX_COMPARED,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "estimate": {"type": "string", "description": "What the estimate is, in at most 8 words, such as mean pain, week 12, arm B."},
                                    "first": {
                                        "type": "object",
                                        "description": "In the analyst's notebook: the label of the cell whose output prints it, and the number as printed there, or an empty value when it has no result.",
                                        "properties": {"cell": {"type": "string"}, "value": {"type": "string"}},
                                        "required": ["cell", "value"],
                                    },
                                    "second": {
                                        "type": "object",
                                        "description": "In the notebook you made: the same.",
                                        "properties": {"cell": {"type": "string"}, "value": {"type": "string"}},
                                        "required": ["cell", "value"],
                                    },
                                    "note": {"type": "string", "description": "Why a side has no result, or why the two differ, in at most 12 words."},
                                },
                                "required": ["estimate", "first", "second"],
                            },
                        },
                        "missing": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "The packages that the comparison needed and the new notebook's kernel lacks.",
                        },
                    },
                    "required": ["rows"],
                },
            },
            "required": ["answer"],
        },
    },
}

SYSTEM_PROMPT = """\
You answer an analyst's question in a Jupyter notebook by adding cells and running them.
The {language} kernel holds "variables", and the analyst sees every cell you add, as it runs.

How to work:
- Use as few cells as the question needs. When one cell answers it, run that cell and finish.
- When the answer takes several steps, run them one at a time, and read each result before
  the next. When a result looks wrong, check the data before you go on.
- Never add a cell that only shows a frame of "variables" or a result that an earlier cell
  shows: cite that cell.
- Use explore when the answer depends on a choice, such as the model, a threshold or a subset:
  it runs two to four variants of one cell side by side, as branches, at the same time and in
  one namespace. In each branch, give every name that it assigns, intermediate values
  included, a name unique to that branch, such as fit_mixed and fit_late. Never assign or
  delete a name that another branch or the notebook defines.
- A cell that fails returns its error. Fix that cell in place: run_cell with "fix" set to its
  label, such as [7], and the whole corrected code. After {max_fixes} fixes that fail, or when a
  later cell does its work, remove it with remove_cell, and say in the answer what did not
  run. finish refuses while a cell of yours has failed.
- Write a module with write_file only when a cell would pass 30 lines, or when several cells
  call the same functions; the analysis stays in cells. Put the constants that the results
  depend on at the module's top, in upper case: the view shows them on the cells that use
  them.{reload}
- Add at most {max_cells} cells in all, branches included.
- End with finish: the answer in at most 3 sentences, citing the cells that show it by
  label, such as [7].

Rules for the analysis:
- When the question asks how a value changes over time, draw it: a line per unit and the mean.
- For a measure that repeats within a unit, such as a patient's daily pain, fit a mixed model
  with a random effect per unit, or say in the answer why not. Say when the values reach a
  floor or a ceiling, such as a mean at 0.
- An effect after an event date, such as a switch of tariff, compares with units that had no
  event over the same calendar months; when the run cannot, offer that as a follow-up.
- A unit whose follow-up ends when planned has not dropped out: count only early stops.
- A check for impossible values looks at both ends, zeros and negatives included.
- Read values that a frame holds, such as prices, from that frame: do not type them in.
- If "about" is present, the question is about what it names, such as rows picked in a plot,
  and not about all the data. "rows" then gives the frame and the pandas mask of those rows:
  select them with it, as it is.
- Name a unit, such as kg or years, only when the data, a column's name, a file or an output
  gives it; otherwise write "in the units of" and the column's name. When "files" holds a
  codebook or a data dictionary, read what it says of the columns that the answer reports.
- A causal diagram names its nodes in words, marks the exposure and the outcome, shows each
  measure that the analysis adjusts for, and puts each cause left of its effects.

Rules for the code:
- Use only the variables in "variables" and the packages in "packages".
- Write the code in the library of the data frames it uses: a variable's "type" names it.
- Do not change existing variables: work on copies. Give the frame or the value that answers
  the question a plain name that says what it holds, such as diary_long. Start the name of a
  helper that only one cell needs with an underscore, such as _per_home.
- Load every module or package a cell uses at its top{load}.
- Keep each cell short, at most 30 lines, and end it with the object to show: a figure, a
  table with named columns, or values printed with a label each. Round every number shown, in
  a describe() too, and never show a bare tuple or scientific notation. Never round a p-value
  to 0: write a small one as its field does, such as "< 0.001", or 3.2e-12 in genomics.{show}
- In a figure or a table, show a coded column by what its codes mean, as a codebook gives
  them, such as "Several times a day" for 6, and name the axes in words.
- A file or a database table in "selected" is not in the kernel yet: load it first, with the
  code in its "load" field.

Another notebook:
- "kernels" lists the kernels of this server, and "files" the files of the analyst's folder.
- When the question asks for another language, or another version of the language, make a
  notebook with new_notebook and work there; otherwise work in the analyst's notebook. run_cell, explore and write_file take its name as
  "notebook", and a cell's code is in the language of its notebook's kernel. Without "notebook",
  a tool acts in the analyst's notebook.
- Move the data with share_frames: the analyst's kernel writes the frames to files, and the new
  notebook reads them with what its kernel has, as new_notebook said. Port the preparation from
  the raw files only when the analyst's kernel cannot run code.
- Never install a package, in any kernel. When one is missing, run what you can without it,
  and say in the answer which package is missing and what did not run.
- A notebook whose kernel cannot run code, such as SAS without a licence, keeps the outputs of
  its last run in "notebook": read its code and those outputs, write the analysis in the other
  language, and compare with the outputs it saved. When it saved none, say that its side has no
  results.
- When the question compares the analyst's notebook with the one you made, finish with
  "comparison": each estimate as the outputs of both notebooks print it, by the label of the
  cell that prints it. The view checks each number against those outputs.
- In the answer, cite a cell of the notebook you made with its language in front, such as
  R [2]; a label alone, such as [4], is a cell of the analyst's notebook.

If "mode" is present, it is how the analyst works: do, the steps the question asks for and
nothing more; report, end with a figure or a table ready for a report, with each estimate
and its uncertainty; wonder, give 2 follow-up questions in follow_up that open new directions.{privacy}"""

PRIVACY_PROMPT = """

The data stays on the analyst's machine. "variables" gives names, kinds, sizes and column
names, without values. A tool returns the kind and size of each output and what a local
model wrote about it, and never its values. Write cells that compute and show what the
analyst needs to see; do not try to print data for yourself."""

ANSWER_TASK = "Answer the question with cells that you add and run."
TASK = f"{ANSWER_TASK} The question is about the cell in \"cell\" when there is one."

# A question that compares the analyst's notebook with another kernel (``compare``). The
# new notebook is read as the analyst's is: one step a cell, each with its title, where the
# agents of the demo videos wrote one cell that read the data, fitted the model and showed it.
# It is a second, independent analysis, as a second programmer writes one: in the finance
# video's dry run the agent wrote scikit-learn's penalty and its 100 iterations of L-BFGS
# into R by hand, so the comparison could not show the defaults that differ.
COMPARE_TASK = (
    "The question asks whether the analysis in \"notebook\" gives the same results with the kernel"
    " named in \"compare\". Make a notebook with that kernel and run the analysis there, one step"
    " a cell, so that a reader can follow it: read the data, prepare it, fit each model, and show"
    " its estimates, each in a cell of its own. Write it as an analyst of that language would, with"
    " its usual functions at their defaults, such as glm() for a logistic regression in R, and do not"
    " copy the first notebook's library: the comparison shows where the two differ. Finish with a"
    " comparison of the estimates of both notebooks."
)


class CapReached(Exception):
    """A run passed its cost cap: the notebook's (``by="notebook"``) or the server's cap of a run (``by="server"``).

    ``cost`` is what the run cost, in US dollars, when the driver knows it.
    """

    def __init__(self, cap: float, by: str, cost: float | None = None, model: str | None = None) -> None:
        super().__init__(f"the run reached its cost cap of ${cap:.2f}")
        self.cap = cap
        self.by = by
        self.cost = cost
        self.model = model


def _text(value: Any, limit: int) -> str:
    return str(value if value is not None else "")[:limit]


def _kernels(value: Any) -> tuple[dict[str, Any], ...]:
    """The server's kernels as the view lists them: name, language, sandbox, and whether each can run code."""
    if value is None:
        return ()
    if not isinstance(value, list):
        raise InvalidRequest("kernels must be a list")
    kernels = []
    for item in value[:MAX_KERNELS]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
            raise InvalidRequest("each kernel needs a name")
        kernel = {
            "name": _text(item["name"], 80),
            "display_name": _text(item.get("display_name") or item["name"], 80),
            "language": _text(item.get("language"), 40),
            "sandboxed": item.get("sandboxed") is True,
        }
        if item.get("current") is True:
            kernel["this_notebook"] = True
        kernels.append(kernel)
    return tuple(kernels)


def _files(value: Any) -> tuple[dict[str, Any], ...]:
    """The files of the analyst's folder: names, kinds and sizes."""
    if value is None:
        return ()
    if not isinstance(value, list):
        raise InvalidRequest("files must be a list")
    files = []
    for item in value[:MAX_FILES_LISTED]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise InvalidRequest("each file needs a name")
        entry: dict[str, Any] = {"name": _text(item["name"], 200), "type": item.get("type") if item.get("type") in ("file", "directory", "notebook") else "file"}
        size = item.get("size")
        if isinstance(size, int) and not isinstance(size, bool) and size >= 0:
            entry["size"] = size
        files.append(entry)
    return tuple(files)


def _notebook(value: Any, keep_local: bool) -> dict[str, Any] | None:
    """The analyst's notebook for a question that compares kernels: its kernel and its cells, with their code and the outputs it saved.

    With the data kept here, the outputs go as their number alone: their text holds values.
    """
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("cells"), list):
        raise InvalidRequest("the notebook needs its cells")
    cells = []
    for item in value["cells"][:MAX_NOTEBOOK_CELLS]:
        if not isinstance(item, dict):
            raise InvalidRequest("each cell of the notebook must be an object")
        cell: dict[str, Any] = {"label": _text(item.get("label"), 20), "title": _text(item.get("title"), 120), "code": _text(item.get("code"), MAX_CELL_CODE)}
        outputs = [str(text) for text in item.get("outputs") or [] if isinstance(text, str)]
        if keep_local:
            if outputs:
                cell["outputs_kept_here"] = len(outputs)
        elif outputs:
            cell["outputs"] = "\n".join(outputs)[:MAX_CELL_OUTPUT]
        cells.append(cell)
    return {
        "name": _text(value.get("name"), 200),
        "kernel": _text(value.get("kernel"), 80),
        "language": _text(value.get("language"), 40),
        "cells": cells,
    }


def _compare(value: Any) -> dict[str, str] | None:
    """The kernel that a question compares the analyst's notebook with."""
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("kernel"), str) or not value["kernel"]:
        raise InvalidRequest("compare needs the name of a kernel")
    return {
        "kernel": _text(value["kernel"], 80),
        "display_name": _text(value.get("display_name") or value["kernel"], 80),
        "language": _text(value.get("language"), 40),
    }


@dataclass(frozen=True)
class AgentRequest:
    """The question and the notebook, as for one cell (``SolveRequest``), and how many cells the agent may add."""

    solve: SolveRequest
    keep_local: bool
    max_cells: int
    # What is left under the notebook's cap, in US dollars: the view sends it
    # when the analyst set a cap. None when nothing but the server caps the run.
    budget_usd: float | None = None
    # The server's kernels, and the files of the analyst's folder: a run may
    # make a notebook with another kernel (new_notebook).
    kernels: tuple[dict[str, Any], ...] = ()
    files: tuple[dict[str, Any], ...] = ()
    # For a question that compares the analyst's notebook with another
    # kernel: that notebook's cells, and the kernel it names.
    notebook: dict[str, Any] | None = None
    compare: dict[str, str] | None = None
    # The first prompt as the review guard let it go, its flagged parts masked; None sends it as built.
    guarded_prompt: str | None = None

    @classmethod
    def from_json(cls, data: Any, config: Whybook) -> AgentRequest:
        if not isinstance(data, dict):
            raise InvalidRequest("the body must be an object")
        keep_local = privacy.keep_local_for_remote(config, data)
        if keep_local and data.get("image") is not None:
            raise InvalidRequest(privacy.PICTURE_REFUSED)
        budget = data.get("budget_usd")
        if budget is not None and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget < 0):
            raise InvalidRequest("budget_usd is a number of US dollars, 0 or more")
        solve = SolveRequest.from_json({**data, "placement": "new"})
        if keep_local:
            solve = privacy.local_request(solve)
        compare = _compare(data.get("compare"))
        notebook = _notebook(data.get("notebook"), keep_local)
        if compare is not None and notebook is None:
            raise InvalidRequest("a question that compares kernels needs the notebook's cells")
        return cls(
            solve=solve,
            keep_local=keep_local,
            max_cells=config.agent_max_cells,
            budget_usd=None if budget is None else float(budget),
            kernels=_kernels(data.get("kernels")),
            files=_files(data.get("files")),
            notebook=notebook,
            compare=compare,
        )

    def cap(self, config: Whybook) -> tuple[float, str]:
        """The run's cost cap in US dollars, and whose it is: what is left under the notebook's cap when that is lower than the server's cap of a run.

        A cap holds only where a price of the model is known (``model_client.PRICED``).
        """
        if self.budget_usd is not None and self.budget_usd < config.agent_budget_usd:
            return self.budget_usd, "notebook"
        return config.agent_budget_usd, "server"

    def prompt(self) -> str:
        if self.guarded_prompt is not None:
            return self.guarded_prompt
        body = json.loads(self.solve.prompt())
        if self.compare:
            body["task"] = COMPARE_TASK
        elif self.solve.about:
            # What the analyst picked, such as rows of a plot, is named in the task line:
            # as a field among many, it went unread (design iteration 1.95).
            body["task"] = ANSWER_TASK + about_task(self.solve.about, self.solve.rows, self.solve.keep_local)
        else:
            body["task"] = TASK
        body.pop("previous_attempt", None)
        if self.kernels:
            body["kernels"] = list(self.kernels)
        if self.files:
            body["files"] = list(self.files)
        if self.notebook is not None:
            body["notebook"] = self.notebook
        if self.compare is not None:
            body["compare"] = self.compare
        return json.dumps(body, indent=1)

    def system_prompt(self) -> str:
        found = languages.language(self.solve.language)
        return SYSTEM_PROMPT.format(
            max_cells=self.max_cells,
            max_fixes=MAX_FIXES,
            privacy=PRIVACY_PROMPT if self.keep_local else "",
            language=found.name,
            reload=f" {found.reload}" if found.reload else "",
            load=f", {found.load}" if found.load else "",
            show=f"\n{found.show}" if found.show else "",
        )

    def frames(self) -> tuple[str, ...]:
        """The names of the data frames in the kernel when the run starts, as "variables" lists them."""
        return tuple(str(variable["name"]) for variable in self.solve.variables if variable.get("kind") == "dataframe" and variable.get("name"))


# What a cell that only shows a variable does: the methods and the functions
# that print or display it, whole or in part, as tariffs.head() and print(tariffs).
SHOWING_METHODS = frozenset({"head", "tail", "sample", "to_string", "to_markdown", "show"})
SHOWING_FUNCTIONS = frozenset({"print", "display", "head", "tail", "View"})
# What such a cell may also do: set display options, and load a package in R.
SETUP_FUNCTIONS = frozenset({"library", "require", "suppressPackageStartupMessages", "options"})
SETUP_METHODS = frozenset({"set_option", "reset_option"})


def _shown(node: ast.expr) -> str | None:
    """The variable that an expression shows, as in tariffs, tariffs.head(10) or print(tariffs.to_string()); None for any other expression."""
    if isinstance(node, ast.Name):
        return node.id
    if not isinstance(node, ast.Call):
        return None
    if isinstance(node.func, ast.Attribute) and node.func.attr in SHOWING_METHODS:
        return _shown(node.func.value)
    if isinstance(node.func, ast.Name) and node.func.id in SHOWING_FUNCTIONS and len(node.args) == 1:
        return _shown(node.args[0])
    return None


def _sets_up(statement: ast.stmt) -> bool:
    """Whether a statement only sets up the display: an import, library() in R, or a display option such as pd.set_option(...)."""
    if isinstance(statement, (ast.Import, ast.ImportFrom, ast.Pass)):
        return True
    if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
        func = statement.value.func
        return (isinstance(func, ast.Name) and func.id in SETUP_FUNCTIONS) or (isinstance(func, ast.Attribute) and func.attr in SETUP_METHODS)
    if isinstance(statement, ast.Assign):
        # pd.options.display.max_rows = None
        return all(isinstance(target, ast.Attribute) and ".options." in f".{ast.unparse(target)}." for target in statement.targets)
    return False


def _parsed(code: str) -> ast.Module | None:
    try:
        return ast.parse(code)
    except (SyntaxError, ValueError):  # R, or a null byte
        return None


def only_shows(code: str) -> frozenset[str]:
    """The variables that a cell's code does nothing but show, with imports and display options around them; empty for code that does more."""
    tree = _parsed(code)
    shown: set[str] = set()

    def visit(statements: list[ast.stmt]) -> bool:
        for statement in statements:
            if _sets_up(statement):
                continue
            if isinstance(statement, ast.With) and all(
                isinstance(item.context_expr, ast.Call)
                and isinstance(item.context_expr.func, ast.Attribute)
                and item.context_expr.func.attr == "option_context"
                for item in statement.items
            ):
                if not visit(statement.body):
                    return False
                continue
            name = _shown(statement.value) if isinstance(statement, ast.Expr) else None
            if name is None:
                return False
            shown.add(name)
        return True

    return frozenset(shown) if tree is not None and visit(tree.body) else frozenset()


def shows_again(code: str, shown: dict[str, str | None]) -> str | None:
    """Why a run_cell is refused: its code only shows variables that the notebook shows already (``Run.shown``). None for a cell that does more."""
    names = only_shows(code)
    if not names or not names <= shown.keys():
        return None
    name = min(names)
    where = shown[name]
    if where:
        return f"No cell was added: the code only shows {name}, which {where} shows already. Cite {where}, and read what you need of {name} in the cell that uses it."
    return (
        f"No cell was added: the code only shows {name}, a frame of \"variables\", which gives its columns and size."
        f" Cite the cell that makes it, and read what you need of {name} in the cell that uses it."
    )


def _last_shown(code: str) -> str | None:
    """The variable that the last line of a cell's code shows as its output: tariffs, for code that ends with tariffs.head()."""
    tree = _parsed(code)
    last = tree.body[-1] if tree is not None and tree.body else None
    return _shown(last.value) if isinstance(last, ast.Expr) else None


def _assigned(code: str) -> set[str]:
    """The names that a cell's code assigns or deletes."""
    tree = _parsed(code)
    if tree is None:
        return set()
    return {node.id for node in ast.walk(tree) if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}


# A cell's label at the end of what the agent gives: "[14]", "14", "[5b]" or "R [2]".
LABEL_END = re.compile(r"(\d+[a-z]?)\]?\s*$")
# The labels that a text cites, alone or in a list, with the word before them:
# [7], [7, 9] and R [2], a cell of the notebook that the run made with R.
CITED = re.compile(r"(?:([A-Za-z][\w.+#-]*)\s+)?\[(\d+[a-z]?(?:\s*,\s*\d+[a-z]?)*)\]")


def cell_label(value: Any) -> str | None:
    """A cell's label as the view writes it, [14] or [5b], from what the agent gives; None when it names no label."""
    found = LABEL_END.search(str(value or "").strip())
    return f"[{found.group(1)}]" if found else None


def notebook_key(value: Any) -> str:
    """The notebook that a tool acts in, as the run notes its cells: "" for the analyst's, else the name that new_notebook gave."""
    return posixpath.basename(str(value or "").strip())


def cited_labels(text: str, languages: dict[str, str]) -> set[tuple[str, str]]:
    """The cells that a text cites, by notebook and label: [7] and [7, 9] in the analyst's notebook, R [2] in the notebook that the run made with R."""
    by_language = {language.lower(): name for name, language in languages.items() if language}
    found: set[tuple[str, str]] = set()
    for match in CITED.finditer(text):
        notebook = by_language.get((match.group(1) or "").lower(), "")
        for label in match.group(2).split(","):
            found.add((notebook, f"[{label.strip()}]"))
    return found


@dataclass
class Failed:
    """A cell of a run that failed and is in its notebook: the name of its error, and the fixes tried."""

    error: str
    fixes: int = 0


@dataclass
class Run:
    """One agent run: its events for the view, and the tool calls that wait for the view."""

    id: str
    keep_local: bool
    max_cells: int
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    calls: dict[str, asyncio.Future] = field(default_factory=dict)
    task: asyncio.Task | None = None
    answer: dict[str, Any] | None = None
    # The cells of every notebook of the run, the modules, the notebooks it
    # made and the frames it wrote to files.
    cells: int = 0
    files: int = 0
    notebooks: int = 0
    frames: int = 0
    # The driver's reading of what the run has cost so far, in US dollars, or
    # None where no price is known: a run that stops or fails reports it.
    meter: Callable[[], float | None] | None = None
    # What the analyst's notebook shows already, by name: the frames of
    # "variables", and what a cell of the run shows at its end, with the
    # cell's label. A cell that only shows one of them again is refused.
    shown: dict[str, str | None] = field(default_factory=dict)
    # The review guard: what the view chose, where the prompts go, and the
    # connected model's review of code when the analyst turned it on.
    guard_settings: guard.Settings = field(default_factory=guard.Settings)
    to: str = "the remote model"
    local: bool = False
    threads: int = 4
    review: Callable[[str], Any] | None = None
    # The cells of the run that failed and are in their notebook, by the
    # notebook ("" for the analyst's) and the label: finish refuses while one
    # is left (design iteration 1.103). Every label that a cell had when it
    # failed, and the labels of the cells that ran: the answer cites no label
    # of a failed attempt. What a fix or a removal made of a failed label:
    # the cell's label after the fix, or None for a cell removed.
    failed: dict[tuple[str, str], Failed] = field(default_factory=dict)
    failed_labels: set[tuple[str, str]] = field(default_factory=set)
    ran_labels: set[tuple[str, str]] = field(default_factory=set)
    became: dict[tuple[str, str], str | None] = field(default_factory=dict)
    # The language of each notebook that the run made, by its name, as an
    # answer names its cells: R [2].
    languages: dict[str, str] = field(default_factory=dict)

    def emit(self, event: dict[str, Any]) -> None:
        self.queue.put_nowait(event)

    def named(self, key: tuple[str, str]) -> str:
        """A cell of the run as the agent names it: [14] here, R [3] in the notebook that the run made with R."""
        notebook, label = key
        return f"{self.languages.get(notebook) or notebook} {label}" if notebook else label

    def failed_list(self) -> str:
        """The cells that failed and are still in their notebook, with their errors: "[14] (PatsyError) and [16] (KeyError)"."""
        items = [f"{self.named(key)} ({failed.error})" for key, failed in self.failed.items()]
        return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"

    def failed_cell(self, notebook: Any, asked: Any, tool: str) -> tuple[str, str] | str:
        """The failed cell that a fix or a removal names, or why the tool is refused."""
        label = cell_label(asked)
        key = (notebook_key(notebook), label or "")
        if label and key not in self.failed:
            # The analyst's notebook named by its name, or a cell of another
            # notebook named without it: the one failed cell of that label.
            same = [found for found in self.failed if found[1] == label]
            if len(same) == 1:
                key = same[0]
        if key in self.failed:
            return key
        what = "fix" if tool == "run_cell" else "remove_cell"
        if not self.failed:
            return f"No cell of yours has failed: {what} takes only a cell of yours that failed." + (
                " Leave out fix to add a cell." if tool == "run_cell" else ""
            )
        return f"{label or 'That'} is not a cell of yours that failed: {what} takes only those, and {self.failed_list()} failed."

    def track(self, name: str, tool_input: dict[str, Any], result: dict[str, Any], fixing: tuple[str, str] | None) -> None:
        """Note which cells of the run failed, ran or left their notebook, from what the view says of a tool."""
        if name == "new_notebook" and result.get("status") == "ok" and isinstance(result.get("notebook"), str):
            self.languages[notebook_key(result["notebook"])] = str(result.get("language") or "")
            return
        if fixing is not None and result.get("failed") is False:
            # The cell is no longer a failed cell of the notebook: the
            # analyst removed it, or ran it again.
            self.failed.pop(fixing, None)
            return
        if name == "remove_cell":
            if result.get("status") == "ok":
                self.failed.pop(fixing, None)
                if fixing is not None:
                    self.became[fixing] = None
            return
        if name == "explore":
            notebook = notebook_key(tool_input.get("notebook"))
            for branch in result.get("branches") or []:
                if isinstance(branch, dict):
                    self.ran(notebook, branch, None)
            return
        if name == "run_cell":
            self.ran(fixing[0] if fixing else notebook_key(tool_input.get("notebook")), result, fixing)

    def ran(self, notebook: str, result: dict[str, Any], fixing: tuple[str, str] | None) -> None:
        """Note a cell that ran, from its result: a fix's cell keeps the fixes it took."""
        status = result.get("status")
        if status not in ("ok", "error"):
            return
        label = cell_label(result.get("cell"))
        before = self.failed.pop(fixing, None) if fixing is not None else None
        if fixing is not None:
            self.became[fixing] = label
        if label is None:
            return
        key = (notebook, label)
        if status == "ok":
            self.ran_labels.add(key)
            return
        self.failed[key] = Failed(privacy.error_type(result.get("error")), (before.fixes + 1) if before else 0)
        self.failed_labels.add(key)

    def unfinished(self, answer: dict[str, Any]) -> str | None:
        """Why finish is refused: a cell of the run failed and is in its notebook, or the answer cites a cell when it failed. None lets the run end."""
        if self.failed:
            first = self.named(next(iter(self.failed)))
            one = len(self.failed) == 1
            return (
                f"Not finished: {self.failed_list()} failed and {'is' if one else 'are'} still in the notebook, which would"
                f" fail there when it runs from the top. Fix {'it' if one else 'each'} in place with run_cell and \"fix\":"
                f' "{first}", or remove {"it" if one else "one"} with remove_cell when you cannot fix it or a later cell does'
                " its work, and say in the answer what did not run. Then finish again."
            )
        cleaned = finish_arguments(answer)
        cells = cleaned.get("cells") if isinstance(cleaned.get("cells"), list) else []
        text = " ".join([str(cleaned.get("answer") or ""), *(str(item) for item in cells)])
        cited = sorted(key for key in cited_labels(text, self.languages) if key in self.failed_labels and key not in self.ran_labels)
        if not cited:
            return None
        key = cited[0]
        now = self.became.get(key)
        where = f"it is {self.named((key[0], now))} since its fix" if now else "you removed it"
        return f"Not finished: the answer cites {self.named(key)}, a cell when it failed, and {where}. Cite only cells that ran without an error."

    def saw(self, code: str, label: Any) -> None:
        """Note what a cell that ran shows at its end, after what it assigned: a value that a cell changes is new again."""
        for name in _assigned(code):
            self.shown.pop(name, None)
        last = _last_shown(code)
        if last is not None:
            self.shown[last] = label if isinstance(label, str) and label else None

    def spent(self) -> float | None:
        """What the run has cost so far, in US dollars, when the driver knows it."""
        try:
            cost = self.meter() if self.meter else None
        except Exception:  # noqa: BLE001  a reading is never worth a failed run
            return None
        return round(cost, 6) if isinstance(cost, (int, float)) else None

    async def call(self, name: str, tool_input: dict[str, Any]) -> dict[str, Any]:
        """Ask the view to run a tool, and wait for what came out."""
        if name == "finish":
            refused = self.unfinished(tool_input)
            if refused:
                return {"status": "refused", "error": refused}
            self.answer = tool_input
            return {"status": "ok"}
        # The failed cell that a fix or a removal acts on: it adds no cell.
        fixing: tuple[str, str] | None = None
        if name == "remove_cell" or (name == "run_cell" and tool_input.get("fix")):
            found = self.failed_cell(tool_input.get("notebook"), tool_input.get("cell" if name == "remove_cell" else "fix"), name)
            if isinstance(found, str):
                return {"status": "refused", "error": found}
            if name == "run_cell" and self.failed[found].fixes >= MAX_FIXES:
                return {
                    "status": "refused",
                    "error": f"{self.named(found)} failed after {MAX_FIXES} fixes: remove it with remove_cell, and say in the answer what did not run.",
                }
            fixing = found
            # The view finds the cell by the label and the notebook that the run noted: "R [2]" is [2] there.
            tool_input = {key: value for key, value in tool_input.items() if key != "notebook"}
            tool_input["cell" if name == "remove_cell" else "fix"] = found[1]
            if found[0]:
                tool_input["notebook"] = found[0]
        elif name == "write_file":
            if self.files >= MAX_FILES:
                return {"status": "refused", "error": f"at most {MAX_FILES} files in a run: put the rest in cells"}
            if len(str(tool_input.get("content") or "")) > MAX_FILE_CHARS:
                return {"status": "refused", "error": f"a file holds at most {MAX_FILE_CHARS} characters: split it, or put the rest in cells"}
            self.files += 1
        elif name == "new_notebook":
            if self.notebooks >= MAX_NOTEBOOKS:
                return {"status": "refused", "error": f"at most {MAX_NOTEBOOKS} new notebook in a run: work in the one you made"}
        elif name == "share_frames":
            frames = tool_input.get("frames") if isinstance(tool_input.get("frames"), list) else []
            if not frames:
                return {"status": "refused", "error": "name the frames to write"}
            if self.frames + len(frames) > MAX_FRAMES:
                return {"status": "refused", "error": f"at most {MAX_FRAMES} frames in a run: write the ones the cells read"}
            self.frames += len(frames)
        else:
            # A cell of the analyst's notebook that only shows what it shows already.
            again = shows_again(str(tool_input.get("code") or ""), self.shown) if name == "run_cell" and not tool_input.get("notebook") else None
            if again:
                return {"status": "refused", "error": again}
            # The cells of every notebook count against one limit.
            added = 1 if name == "run_cell" else len(tool_input.get("branches") or [])
            if self.cells + added > self.max_cells:
                return {"status": "refused", "error": f"at most {self.max_cells} cells in all, in every notebook: finish with what you have"}
            self.cells += added
        held = await self.guard_code(name, tool_input)
        if held is not None:
            if name == "write_file":
                self.files -= 1
            elif name in ("run_cell", "explore") and fixing is None:
                self.cells -= 1 if name == "run_cell" else len(tool_input.get("branches") or [])
            return held
        call_id = secrets.token_hex(6)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.calls[call_id] = future
        self.emit({"type": "tool", "run": self.id, "call": call_id, "name": name, "input": tool_input})
        try:
            result = await asyncio.wait_for(future, TOOL_TIMEOUT)
        except asyncio.TimeoutError:
            result = {"status": "error", "error": "the notebook did not answer in time"}
        finally:
            self.calls.pop(call_id, None)
        # A notebook that the view could not make leaves the run its one notebook.
        if name == "new_notebook" and isinstance(result, dict) and result.get("status") == "ok":
            self.notebooks += 1
        if name == "run_cell" and not tool_input.get("notebook") and isinstance(result, dict) and result.get("status") == "ok":
            self.saw(str(tool_input.get("code") or ""), result.get("cell"))
        if isinstance(result, dict):
            self.track(name, tool_input, result, fixing)
        return await self.guard_result(name, privacy.tool_result(result, self.keep_local))

    async def guard_code(self, name: str, tool_input: dict[str, Any]) -> dict[str, Any] | None:
        """The execution guard on the code of a tool before the view runs it: None lets it run, else what the agent reads instead."""
        if not self.guard_settings.checks_code:
            return None
        cells: list[str] | None = None
        if name == "run_cell":
            code, what = str(tool_input.get("code") or ""), "a cell"
        elif name == "explore":
            branches = tool_input.get("branches") if isinstance(tool_input.get("branches"), list) else []
            # Each branch runs as a cell of its own: the rules read each alone, and one that does not compile stops no other.
            cells = [str(branch.get("code") or "") for branch in branches if isinstance(branch, dict)]
            code = "\n\n".join(cells)
            what = "the branches of a cell"
        elif name == "write_file" and str(tool_input.get("path") or "").endswith(".py"):
            code, what = str(tool_input.get("content") or ""), f"the file {str(tool_input.get('path'))[:120]}"
        else:
            return None
        if not code.strip():
            return None
        outcome = await guard.review_code(code, self.guard_settings, self.emit, what=what, threads=self.threads, review=self.review, cells=cells)
        if outcome.go:
            return None
        if outcome.by == "analyst":
            return {"status": "refused", "reason": f"The analyst did not run it. {outcome.finding.reasons()}."}
        return {"status": "refused", "reason": f"held back by the review guard: {outcome.reason}. Do it another way, or finish with what you have."}

    async def guard_result(self, name: str, kept: dict[str, Any]) -> dict[str, Any]:
        """The privacy guard on a tool's result before it goes to a model on another machine."""
        if not self.guard_settings.checks_prompts or self.local:
            return kept
        text = json.dumps(kept)
        cell = kept.get("cell")
        what = f"the result of {cell}" if isinstance(cell, str) and cell else "the result of a step"
        outcome = await guard.check_prompt(text, self.guard_settings, self.emit, to=self.to, what=what, threads=self.threads)
        if not outcome.go:
            return {"status": kept.get("status", "ok"), "cell": kept.get("cell"), "result": f"held back by the review guard: {outcome.reason}"}
        if outcome.text != text:
            try:
                return json.loads(outcome.text)
            except ValueError:
                return {"status": kept.get("status", "ok"), "cell": kept.get("cell"), "result": "held back by the review guard"}
        return kept


Driver = Callable[[Run, AgentRequest, Whybook], Awaitable[dict[str, Any]]]

# The runs in progress, by id: one server process serves every view.
RUNS: dict[str, Run] = {}


def submit(run_id: str, call_id: str, result: Any) -> bool:
    """The outcome of a tool from the view; False when no call waits for it."""
    run = RUNS.get(run_id)
    future = run.calls.get(call_id) if run else None
    if future is None or future.done():
        return False
    future.set_result(result if isinstance(result, dict) else {"status": "error", "error": "the result must be an object"})
    return True


def stop(run_id: str) -> bool:
    """Stop a run, as the analyst's Stop button does; False when no such run goes on."""
    run = RUNS.get(run_id)
    if run is None or run.task is None or run.task.done():
        return False
    run.task.cancel()
    return True


async def run_events(request: AgentRequest, config: Whybook, driver: Driver | None = None) -> AsyncIterator[dict[str, Any]]:
    """The events of one run: its id, progress, the agent's words and tool calls, then one result or error."""
    start = time.monotonic()
    from . import connection

    settings = guard.settings_of(config)
    connected = connection.load(config)
    to, local = connected.label(config), connected.local
    if settings.checks_prompts and not local:
        # The privacy guard reads the question and the notebook before the run sends them.
        held: list[guard.Outcome] = []
        prompt = request.prompt()
        async for event in guard.events(
            lambda emit: guard.check_prompt(prompt, settings, emit, to=to, what="the question and the notebook", threads=config.local_threads), held
        ):
            yield event
        if not held[0].go:
            yield {"type": "error", "message": f"The review guard held back the question: {held[0].reason}.", "guard": True, "elapsed": round(time.monotonic() - start, 1)}
            return
        if held[0].text != prompt:
            request = dataclasses.replace(request, guarded_prompt=held[0].text)
    run = Run(
        id=secrets.token_hex(8),
        keep_local=request.keep_local,
        max_cells=request.max_cells,
        shown=dict.fromkeys(request.frames()),
        guard_settings=dataclasses.replace(settings, language=languages.language(request.solve.language).name),
        to=to,
        local=local,
        threads=config.local_threads,
        review=guard.code_review(config, settings),
    )
    RUNS[run.id] = run
    run.task = asyncio.ensure_future((driver or claude_driver)(run, request, config))
    yield {"type": "started", "run": run.id, "keep_local": run.keep_local, "elapsed": 0.0}
    try:
        while True:
            getter = asyncio.ensure_future(run.queue.get())
            done, _ = await asyncio.wait({getter, run.task}, timeout=PING_SECONDS, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                getter.cancel()
                yield {"type": "ping"}
                continue
            if getter in done:
                yield getter.result()
                continue
            getter.cancel()
            while not run.queue.empty():
                yield run.queue.get_nowait()
            elapsed = round(time.monotonic() - start, 1)
            try:
                final = run.task.result()
            except asyncio.CancelledError:
                yield {"type": "result", "stopped": True, "answer": None, "cells": [], "cost_usd": run.spent(), "elapsed": elapsed}
            except CapReached as reached:
                # The cells so far stay; the view offers a way past the notebook's cap.
                cost = reached.cost if reached.cost is not None else run.spent()
                yield {
                    "type": "result",
                    "stopped": True,
                    "capped": {"by": reached.by, "usd": reached.cap},
                    "answer": None,
                    "cells": [],
                    "model": reached.model,
                    "cost_usd": cost,
                    "elapsed": elapsed,
                }
            except Exception as error:  # noqa: BLE001  the failure goes to the view
                log.warning("the agent run failed: %s", error)
                yield {"type": "error", "message": str(error), "cost_usd": run.spent(), "elapsed": elapsed}
            else:
                yield {**final, "elapsed": elapsed}
            return
    finally:
        if not run.task.done():
            run.task.cancel()
        for future in run.calls.values():
            future.cancel()
        RUNS.pop(run.id, None)


def _side(value: Any) -> dict[str, str] | None:
    """One notebook's side of an estimate: the label of the cell that prints it, and the number as printed, or ""."""
    if not isinstance(value, dict):
        return None
    number = value.get("value")
    if number is None:
        number = ""
    if isinstance(number, bool) or not isinstance(number, (str, int, float)):
        return None
    return {"cell": _text(value.get("cell"), 20), "value": _text(number, 40).strip()}


def comparison_of(value: Any) -> dict[str, Any] | None:
    """The comparison of finish, as the view reads it: the rows that name both sides, and the packages missing."""
    if not isinstance(value, dict) or not isinstance(value.get("rows"), list):
        return None
    rows = []
    for item in value["rows"][:MAX_COMPARED]:
        if not isinstance(item, dict) or not isinstance(item.get("estimate"), str):
            continue
        first, second = _side(item.get("first")), _side(item.get("second"))
        if first is None or second is None:
            continue
        row: dict[str, Any] = {"estimate": _text(item["estimate"], 120), "first": first, "second": second}
        if isinstance(item.get("note"), str) and item["note"].strip():
            row["note"] = _text(item["note"].strip(), 200)
        rows.append(row)
    missing = [_text(name, 60) for name in value.get("missing") or [] if isinstance(name, str) and name.strip()][:20]
    return {"rows": rows, "missing": missing}


# The markup of a tool call that a model can leave in the text of an argument.
# A parameter closed with the wrong tag takes in the parameters after it, as in
# 'per-home totals.</answer>\n<parameter name="cells">["[4]","[5]"]' (energy,
# pass 2, run 2). Only the tags of a tool call count, so a "<" in an answer, as
# in p < 0.05, stays.
FINISH_KEYS = tuple(TOOLS["finish"]["schema"]["properties"])
TOOL_MARKUP = re.compile(r"</?(?:antml:)?(?:parameter|invoke|function_calls|" + "|".join(FINISH_KEYS) + r")\b[^<>]*>")
# A tag that opens the text, as in "<answer>Yes, ...".
OPENING_TAG = re.compile(r'\s*<(?:antml:)?(?:' + "|".join(FINISH_KEYS) + r'|parameter\s+name="\w+")\s*>')
MARKUP_PARAMETER = re.compile(r'<(?:antml:)?parameter\s+name="(\w+)"\s*>(.*?)(?=</?(?:antml:)?(?:parameter|invoke|function_calls)\b|\Z)', re.S)


def _without_markup(text: str) -> tuple[str, dict[str, Any]]:
    """The text of an argument up to the markup of a tool call in it, and the parameters that the markup holds. A text without markup comes back as it is."""
    opening = OPENING_TAG.match(text)
    body = text[opening.end() :] if opening else text
    found = TOOL_MARKUP.search(body)
    if found is None:
        return (body.strip() if opening else text), {}
    held: dict[str, Any] = {}
    for name, value in MARKUP_PARAMETER.findall(body[found.start() :]):
        try:
            held[name] = json.loads(value)
        except ValueError:
            held[name] = value.strip()
    return body[: found.start()].strip(), held


def finish_arguments(arguments: dict[str, Any] | None) -> dict[str, Any]:
    """The arguments of finish without the markup of a tool call that the model left in their text.

    A parameter that the markup holds fills an argument that the call left out
    or empty, when it has that argument's type: a string for the answer, a list
    of strings for cells and follow_up.
    """
    cleaned: dict[str, Any] = {}
    held: dict[str, Any] = {}
    for key, value in (arguments or {}).items():
        if isinstance(value, str):
            value, found = _without_markup(value)
            held.update(found)
        elif isinstance(value, list):
            items = []
            for item in value:
                if isinstance(item, str):
                    item, found = _without_markup(item)
                    held.update(found)
                    if not item:
                        continue
                items.append(item)
            value = items
        cleaned[key] = value
    for key, value in held.items():
        if cleaned.get(key):
            continue
        if key == "answer" and isinstance(value, str):
            cleaned[key] = value
        elif key in ("cells", "follow_up") and isinstance(value, list) and all(isinstance(item, str) for item in value):
            cleaned[key] = value
    return cleaned


def answer_fields(answer: dict[str, Any] | None) -> dict[str, Any]:
    """What a run's result carries of its finish call: the answer, its cells, its follow-ups, and the comparison when it made one."""
    answer = finish_arguments(answer)
    fields: dict[str, Any] = {"answer": answer.get("answer"), "cells": answer.get("cells", []), "follow_up": answer.get("follow_up", [])}
    comparison = comparison_of(answer.get("comparison"))
    if comparison is not None:
        fields["comparison"] = comparison
    return fields


def scripted(steps: list[tuple[str, dict[str, Any]]], model: str = "script") -> Driver:
    """A driver that calls the tools in order, for tests and demos: no model runs."""

    async def drive(run: Run, request: AgentRequest, config: Whybook) -> dict[str, Any]:
        results = []
        for name, tool_input in steps:
            run.emit({"type": "progress", "stage": "writing", "message": tool_input.get("why") or name, "elapsed": 0.0})
            results.append(await run.call(name, tool_input))
        return {
            "type": "result",
            **answer_fields(run.answer),
            "results": results,
            "model": model,
            "cost_usd": 0.0,
        }

    return drive


async def claude_driver(run: Run, request: AgentRequest, config: Whybook) -> dict[str, Any]:
    """The remote model, through the Claude Agent SDK, with the tools as an in-process MCP server."""
    try:
        import claude_agent_sdk as sdk
    except ImportError as error:  # the "claude" extra is not installed
        raise RuntimeError("No AI model is set up on the server.") from error

    def handler(name: str) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
        async def call(args: dict[str, Any]) -> dict[str, Any]:
            result = await run.call(name, args)
            return {"content": [{"type": "text", "text": json.dumps(result)}]}

        return call

    tools = [sdk.tool(name, spec["description"], spec["schema"])(handler(name)) for name, spec in TOOLS.items()]
    server = sdk.create_sdk_mcp_server(name="whybook", version="1.0.0", tools=tools)
    cap, by = request.cap(config)
    options = sdk.ClaudeAgentOptions(
        system_prompt=request.system_prompt(),
        tools=[],
        mcp_servers={"whybook": server},
        allowed_tools=[f"mcp__whybook__{name}" for name in TOOLS],
        setting_sources=[],
        strict_mcp_config=True,
        skills=[],
        permission_mode="dontAsk",
        max_turns=config.agent_max_turns,
        max_budget_usd=cap,
        model=config.claude_model,
        cli_path=config.claude_cli_path,
        effort=config.agent_effort,
        cwd=claude._workdir(),
        extra_args={"no-session-persistence": None},
        # The three tools are loaded at once, without the search for tools.
        env={"ENABLE_TOOL_SEARCH": "false"},
    )
    state: dict[str, Any] = {"model": None, "cost": None}
    # The CLI gives the cost in its last message alone: a run that the analyst
    # stops has none.
    run.meter = lambda: state["cost"]
    async with sdk.ClaudeSDKClient(options=options) as client:
        await client.query(request.prompt())
        async for message in client.receive_response():
            if isinstance(message, sdk.SystemMessage) and message.subtype == "init":
                state["model"] = message.data.get("model")
                run.emit({"type": "progress", "stage": "starting", "elapsed": 0.0})
            elif isinstance(message, sdk.AssistantMessage):
                for block in message.content:
                    if isinstance(block, sdk.TextBlock) and block.text.strip():
                        run.emit({"type": "text", "text": block.text.strip()})
                thought = claude.last_thought(message, sdk)
                if thought is not None:
                    run.emit({"type": "progress", "stage": "thinking", "message": thought, "elapsed": 0.0})
            elif isinstance(message, sdk.ResultMessage):
                state["cost"] = message.total_cost_usd
                if message.subtype == "error_max_budget_usd" and run.answer is None:
                    raise CapReached(cap, by, message.total_cost_usd, state["model"])
                if message.is_error and run.answer is None:
                    raise RuntimeError(claude.reason("; ".join(message.errors or []) or message.subtype, config))
    return {
        "type": "result",
        **answer_fields(run.answer),
        "model": state["model"],
        "cost_usd": state["cost"],
    }
