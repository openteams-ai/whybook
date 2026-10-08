"""Turn a question into one proposed notebook cell.

Claude writes the code, a one-line summary of what the cell computes, and
every assumption the code makes. The summary is written before the cell
runs, so it states no result: a summary of what the output would show was a
guess, and 15 of 34 such summaries claimed a curve that the data do not show
(research/model_access/demo-model.md). The frontend inserts the cell, runs
it in the user's kernel, and keeps the question and the assumptions in the
cell metadata. Python code that does not parse goes back to the model once,
as ``previous_attempt`` with Python's error, before the analyst sees it.
"""

from __future__ import annotations

import ast
import dataclasses
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, AsyncIterator

from . import claude, codegen, connection, databases, languages, privacy
from .config import Whybook
from .questions import files, tables
from .questions.models import TYPES, InvalidRequest, Selection, Variable

MAX_VARIABLES = 25
MAX_COLUMNS = 30
MAX_TERMS = 12
MAX_CODE_CHARS = 4000
# The mask of the rows picked in a plot: two ranges of a brush, or a dozen bars.
MAX_MASK_CHARS = 1000
# The Messages API takes pictures of up to 5 MB, and reads these types.
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")

# The system prompt, with what languages.py says of the kernel's language.
SYSTEM_TEMPLATE = """\
You write one {language} cell for a Jupyter notebook. The cell answers the analyst's question
with the variables that already exist in the kernel. The analyst looks at the output of
the cell, and reads the code only to check it.

Rules for the code:
- Use only the variables in "variables" and the packages in "packages".
- Write the code in the library of the data frames it uses: a variable's "type" names it{frames}.
  Do not convert a frame to another library.
- A file or a database table in "selected" is not in the kernel yet: load it first, with the
  code in its "load" field when it has one.
- Do not change existing variables. Work on copies.
- Keep the kernel namespace clean: the analyst sees every variable the cell leaves behind.
  Leave at most one new variable, named after what it holds, and delete the other
  intermediate values at the end of the cell{remove}.
- Load every module or package the cell uses at its top{load}, even when an earlier cell
  does, so the cell also runs in a notebook that never did.
- Keep the cell short: at most 30 lines, and no functions or classes unless the question needs them.
- End the cell with the object to show: a figure, a table, or a short printed result.{show}
- In a figure or a table, show a coded column by what its codes mean, as a codebook gives
  them, such as "Several times a day" for 6, and name the axes in words.
- If "previous_attempt" is present, that code failed with the given error. Fix it.
- If "about" is present, it names what the analyst pointed at when asking, such as rows
  picked in a plot: the question is about that, and not about all the data. "rows" then
  gives the frame and the pandas mask of those rows: select them with it, as it is.
- Name a unit, such as kg or years, only when the data, a column's name, a file or an
  output gives it. Otherwise write "in the units of" and the column's name.
- If "image" is present, the picture sent with the request is an output of the notebook, and
  "image" gives the point or the area of it that the analyst picked, in pixels from its top
  left corner and as fractions of its width and height. Read what the picture shows there,
  and answer with the variables when they hold the data behind the picture.

Then list the assumptions the code makes that could change the answer: the test or model
chosen, parameters left at their defaults, how missing values are handled, transformations,
thresholds and bin widths. List at most 6, the one most likely to change the answer first,
each in at most 20 words. Write each as its kind, a colon and the assumption, such as
"default: REML, the default of mixedlm". The kind is "default" for a library default,
"modelling" for a choice of method, and "data" for an assumption about the data.

summary says what the cell computes, in at most 12 words, such as "Tests whether a quadratic
term improves the fit". You write it before the cell runs: never say what the output will show.
follow_up holds up to 3 questions that the output raises, at most 12 words each. Write each
as its type, a colon and the question, such as "association: Does sleep relate to pain?". The
type is association, causal, quality (data quality), model (a model check) or descriptive.

If "mode" is present, it is how the analyst works, and it shapes the cell:
- do: write the step the question asks for, and nothing more.
- report: end the cell with a figure or a table ready for a report, with each estimate and
  its uncertainty, such as a 95% interval. summary then names the estimate and the
  uncertainty that the cell reports, in at most 25 words, without their values.
- wonder: answer the question, and give exactly 2 follow_up questions that open directions
  the notebook has not taken, such as another variable, an interaction or a cause.

{helpers}Answer once, with one JSON object that has exactly these four keys: "summary" (a string),
"code" (a string), "assumptions" (a list of strings) and "follow_up" (a list of strings)."""


def system_prompt(name: str | None = None) -> str:
    """The system prompt for a kernel of this language_info.name."""
    found = languages.language(name)
    return SYSTEM_TEMPLATE.format(
        language=found.name,
        frames=f", {found.frames}" if found.frames else "",
        remove=f", {found.remove}" if found.remove else "",
        load=f", {found.load}" if found.load else "",
        show=f"\n{found.show}" if found.show else "",
        helpers=f"{found.helpers}\n\n" if found.helpers else "",
    )


# Python's, which the tests read.
SYSTEM_PROMPT = system_prompt("python")

PLACEMENT_PROMPTS = {
    "edit": "Rewrite the cell in \"cell\" so that it also does what the question asks. Return the full new source of the cell. Keep what the cell already does.",
    # A branch runs in a subshell, at the same time as the original and other branches, in the same namespace.
    "branch": (
        "Write a branch of the cell in \"cell\": the same analysis with the change the question asks for. "
        "It runs at the same time as the original and as other branches, and they all share one namespace. "
        "Give every name that the branch assigns, intermediate values included, a sensible name that says what it holds "
        "and is unique to this branch, made from its change: lmm_fit_with_il6 and _model_data_with_il6 for a branch that adds IL6. "
        "Never assign or delete a name that the notebook or another branch defines. "
        "An import is the exception: import a module under its usual name, such as import numpy as np, "
        "even when the notebook imports it already."
    ),
    "new": "Write a new cell that goes after the cell in \"cell\".",
    "preview": "Write a short cell whose output shows the answer. It is shown in a sidebar and not saved in the notebook.",
}

# The question is about the analyst's text in a markdown cell, not about code.
NOTE_TASK = (
    "Write a new cell that goes after the text in \"cell\": the analyst's writeup of the results, "
    "in markdown. The cell answers the question about that text with the data. Where the text "
    "states a number, show it next to the value the data gives."
)

# One object, whose lists hold strings: with objects in its lists, the model
# sometimes answered with one assumption in place of the whole object, five
# times over, as the CLI's structured output allows five tries.
SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "code": {"type": "string"},
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "follow_up": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "code", "assumptions", "follow_up"],
    "additionalProperties": False,
}

ASSUMPTION_KINDS = ("default", "modelling", "data")
MODES = ("do", "report", "wonder")

# What the model needs of a column to write code against it.
COLUMN_FIELDS = ("label", "tag", "levels", "min", "max", "missing")
# What it does not need of a variable: the view's own fields, and what is sent in short.
DROPPED_FIELDS = {"label", "cell", "fingerprint", "unchanged", "stale", "columns", "groups", "terms", "value"}


def _mentions(text: str, name: str) -> bool:
    """Whether ``text`` names the variable ``name``, and not an attribute of that name."""
    return bool(name) and re.search(rf"(?<![\w.]){re.escape(name)}(?!\w)", text) is not None


def _compact(variable: dict[str, Any]) -> dict[str, Any]:
    """A variable as the model reads it: a frame's size and first columns, the size of each group of columns.

    A key or a token goes by its name alone (privacy.without_secret), also
    when a view kept its value from before the kernel listed it as a secret.
    """
    variable = privacy.without_secret(variable)
    kept = {key: value for key, value in variable.items() if key not in DROPPED_FIELDS}
    if isinstance(variable.get("value"), str):
        kept["value"] = variable["value"][:200]
    if isinstance(variable.get("columns"), list):
        columns = []
        for column in variable["columns"][:MAX_COLUMNS]:
            if not isinstance(column, dict):
                continue
            entry = {key: column[key] for key in COLUMN_FIELDS if key in column}
            if not entry.get("missing"):
                entry.pop("missing", None)
            if isinstance(entry.get("levels"), list):
                entry["levels"] = entry["levels"][:8]
            columns.append(entry)
        kept["columns"] = columns
    if isinstance(variable.get("groups"), list):
        # A group lists all of its columns: 4,812 protein names in the demo.
        kept["groups"] = [
            {"label": group.get("label"), "columns": group.get("total", len(group.get("columns") or []))}
            for group in variable["groups"]
            if isinstance(group, dict)
        ]
    if isinstance(variable.get("terms"), list):
        kept["terms"] = variable["terms"][:MAX_TERMS]
    return kept


def _trim_variables(variables: Any, mentioned: str = "") -> list[dict[str, Any]]:
    """The variables for the model, short: first those that ``mentioned`` names, then the rest in order."""
    if not isinstance(variables, list) or not all(isinstance(v, dict) for v in variables):
        raise InvalidRequest("variables must be a list of objects")
    named = [variable for variable in variables if _mentions(mentioned, str(variable.get("name", "")))]
    rest = [variable for variable in variables if variable not in named]
    return [_compact(variable) for variable in (named + rest)[:MAX_VARIABLES]]


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidRequest(f"{name} must be a number")
    return value


def _image(data: Any) -> dict[str, Any] | None:
    """A picture the analyst picked a point or an area of, checked; its data stays base64."""
    if data is None:
        return None
    if not isinstance(data, dict):
        raise InvalidRequest("image must be an object")
    mime, encoded = data.get("mime"), data.get("data")
    if mime not in IMAGE_TYPES:
        raise InvalidRequest(f"image must be one of {', '.join(IMAGE_TYPES)}")
    if not isinstance(encoded, str) or not encoded or not re.fullmatch(r"[A-Za-z0-9+/]+=*", encoded):
        raise InvalidRequest("image data must be base64")
    if len(encoded) * 3 // 4 > MAX_IMAGE_BYTES:
        raise InvalidRequest("the image is larger than 5 MB")
    image: dict[str, Any] = {"mime": mime, "data": encoded}
    for key in ("width", "height"):
        if not isinstance(data.get(key), int) or data[key] <= 0:
            raise InvalidRequest(f"image {key} must be a positive whole number")
        image[key] = data[key]
    point, box = data.get("point"), data.get("box")
    if (point is None) == (box is None):
        raise InvalidRequest("image needs a point or a box")
    if point is not None:
        if not isinstance(point, dict):
            raise InvalidRequest("image point must be an object")
        image["point"] = {key: _number(point.get(key), f"point {key}") for key in ("x", "y", "fx", "fy")}
    else:
        if not isinstance(box, dict):
            raise InvalidRequest("image box must be an object")
        image["box"] = {key: _number(box.get(key), f"box {key}") for key in ("x0", "y0", "x1", "y1", "fx0", "fy0", "fx1", "fy1")}
    return image


def _rows(data: Any) -> dict[str, str] | None:
    """The frame and the pandas mask of the rows picked in a plot, checked; None when the view sends none."""
    if data is None:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("frame"), str) or not isinstance(data.get("mask"), str):
        raise InvalidRequest("rows needs a frame and a mask")
    frame, mask = data["frame"].strip(), data["mask"].strip()
    if not frame.isidentifier() or not mask or len(mask) > MAX_MASK_CHARS:
        raise InvalidRequest(f"rows needs the name of a frame, and a mask of at most {MAX_MASK_CHARS} characters")
    return {"frame": frame, "mask": mask}


def about_task(about: str | None, rows: dict[str, str] | None, keep_local: bool = False) -> str:
    """What the task line adds when the analyst pointed at part of the data, such as rows picked in a plot.

    An agent answered "How many of them quit smoking?", asked about 65 rows
    picked on a histogram, about all 1,629 rows of the frame: "about" was a
    field among many, which the system prompt explained (design iteration
    1.95). The task line names it, and the code that selects the rows.
    """
    if not about:
        return ""
    if keep_local:
        return " The question is about the part of a table or a plot that the analyst picked, not about all the data."
    if rows:
        frame = rows["frame"]
        return f" The question is about {about}: answer it for those rows alone, not for every row of {frame}. Select them with {frame}[{rows['mask']}]."
    return f" The question is about {about}."


def _labelled(item: Any, labels: tuple[str, ...], default: str, key: str) -> dict[str, str] | None:
    """"modelling: REML fit" as {"text": "REML fit", "kind": "modelling"}, as the view keeps it."""
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        return {"text": item["text"], key: item.get(key) if item.get(key) in labels else default}
    if not isinstance(item, str) or not item.strip():
        return None
    label, colon, rest = item.partition(":")
    if colon and label.strip().lower() in labels and rest.strip():
        return {"text": rest.strip(), key: label.strip().lower()}
    return {"text": item.strip(), key: default}


@dataclass(frozen=True)
class SolveRequest:
    question: dict[str, str]
    # None for a follow-up question asked from a cell, with nothing selected.
    selection: Selection | None
    placement: str
    cell: dict[str, str] | None
    variables: list[dict[str, Any]]
    packages: dict[str, Any]
    cells: list[str]
    previous_attempt: dict[str, str] | None
    # Names the notebook's cells define, imports included.
    defined: frozenset[str] = frozenset()
    # What the analyst pointed at when asking, in words: rows picked in a plot.
    about: str | None = None
    # The rows picked in a plot, as their frame and the pandas mask that
    # selects them: {"frame": "nhefs", "mask": 'nhefs["wt82_71"].between(15.6, 48.5)'}.
    rows: dict[str, str] | None = None
    # The columns of a dragged file or table and the code that loads it, by name.
    sources: dict[str, dict[str, Any]] = dataclasses.field(default_factory=dict)
    # Do, Report or Wonder: how the analyst works, which the system prompt explains.
    mode: str | None = None
    # A picture from an output, with the point or the area of it the analyst picked.
    image: dict[str, Any] | None = None
    # The data stays on this machine: the selection goes as names, kinds and sizes (privacy.py).
    keep_local: bool = False
    # The kernel's language_info.name, in lower case: the cell is written in it.
    language: str = "python"

    @classmethod
    def from_json(cls, data: Any) -> SolveRequest:
        if not isinstance(data, dict):
            raise InvalidRequest("the body must be an object")
        question = data.get("question")
        if not isinstance(question, dict) or not isinstance(question.get("text"), str):
            raise InvalidRequest("the question needs a text")
        previous = data.get("previous_attempt")
        if previous is not None:
            if not isinstance(previous, dict):
                raise InvalidRequest("previous_attempt must be an object")
            previous = {
                "code": str(previous.get("code", ""))[:MAX_CODE_CHARS],
                "error": str(previous.get("error", ""))[:MAX_CODE_CHARS],
            }
        packages = data.get("packages") or {}
        cells = data.get("cells") or []
        if not isinstance(packages, dict) or not isinstance(cells, list):
            raise InvalidRequest("packages must be an object and cells a list")
        selection = data.get("selection")
        placement = data.get("placement") or "new"
        if placement not in PLACEMENT_PROMPTS:
            raise InvalidRequest(f"unknown placement {placement!r}")
        cell = data.get("cell")
        if cell is not None:
            if not isinstance(cell, dict) or not isinstance(cell.get("source"), str):
                raise InvalidRequest("the cell needs a source")
            cell = {
                "label": str(cell.get("label", "")),
                "kind": "markdown" if cell.get("kind") == "markdown" else "code",
                "source": cell["source"][:MAX_CODE_CHARS],
            }
        if placement in ("edit", "branch") and cell is None:
            raise InvalidRequest(f"a {placement} needs the cell it changes")
        mode = data.get("mode")
        if mode is not None and mode not in MODES:
            raise InvalidRequest(f"unknown mode {mode!r}")
        # What the question points at: its variables go to the model first.
        mentioned = " ".join([question["text"], json.dumps(selection or {}), (cell or {}).get("source", "")])
        return cls(
            question={"text": question["text"], "type": str(question.get("type", question.get("intent", "")))},
            selection=Selection.from_json(selection) if selection is not None else None,
            placement=placement,
            cell=cell,
            variables=_trim_variables(data.get("variables") or [], mentioned),
            packages=packages,
            cells=[str(cell) for cell in cells[-20:]],
            previous_attempt=previous,
            defined=frozenset(str(name) for name in (data.get("defined") or [])[:2000]),
            about=str(data["about"])[:500] if data.get("about") else None,
            rows=_rows(data.get("rows")) if data.get("about") else None,
            mode=mode,
            image=_image(data.get("image")),
            language=str(data.get("language") or "python").strip().lower() or "python",
        )

    def with_sources(self, root: str | None) -> SolveRequest:
        """The request with what the server's files say about a dragged file or table."""
        if self.selection is None:
            return self
        found = {
            item.name: describe_source(item, root, self.language)
            for item in (self.selection.source, self.selection.target)
            if item is not None and item.kind in ("file", "table")
        }
        return dataclasses.replace(self, sources=found) if found else self

    def prompt(self) -> str:
        selected = []
        if self.selection is not None:
            items = [self.selection.source]
            if not self.selection.univariate and self.selection.target is not None:
                items.append(self.selection.target)
            selected = [{**item.to_state(), **self.sources.get(item.name, {})} for item in items]
            if self.keep_local:
                selected = [privacy.local_variable(item) for item in selected]
        about_text = self.cell is not None and self.cell["kind"] == "markdown" and self.placement == "new"
        task = NOTE_TASK if about_text else PLACEMENT_PROMPTS[self.placement]
        branch = languages.language(self.language).branch
        if self.placement == "branch" and branch and not about_text:
            task = f"{task} {branch}"
        task += about_task(self.about, self.rows, self.keep_local)
        body: dict[str, Any] = {
            "task": task,
            "question": self.question,
            "selected": selected,
            "variables": self.variables,
            "packages": self.packages,
            "analysis_so_far": self.cells,
            "language": self.language,
        }
        if self.cell:
            body["cell"] = self.cell
        if self.about:
            body["about"] = self.about
        if self.rows:
            body["rows"] = self.rows
        if self.mode:
            body["mode"] = self.mode
        if self.image:
            # The picture goes as an image block; the text names its size and the pick.
            body["image"] = {key: value for key, value in self.image.items() if key not in ("mime", "data")}
        if self.previous_attempt:
            body["previous_attempt"] = self.previous_attempt
        return json.dumps(body, indent=1)

    def images(self) -> list[dict[str, str]]:
        """The pictures that go to the model with the prompt."""
        return [{"media_type": self.image["mime"], "data": self.image["data"]}] if self.image else []


def describe_source(item: Variable, root: str | None, language: str = "python") -> dict[str, Any]:
    """The code that loads a dragged file or table in the kernel, and its columns.

    The code is Python's: in a kernel of another language the model writes it.
    """
    python = languages.language(language).templates
    kernel_path = item.kernel_path or item.path or item.name
    described: dict[str, Any] = {}
    if item.kind == "table" and item.table:
        if python:
            described["load"] = "\n".join(tables.read_lines(kernel_path, f"SELECT * FROM {databases.quote(item.table)}"))
        try:
            found = databases.describe(root, item.path) if root and item.path else None
        except (databases.OutsideRoot, ValueError, sqlite3.Error):
            found = None
        table = next((t for t in (found or {}).get("tables", []) if t["name"] == item.table), None)
        if table is not None:
            if table["rows"] is not None:
                described["rows"] = table["rows"]
            described["columns"] = table["columns"][:MAX_COLUMNS]
    elif item.kind == "file":
        suffix = PurePosixPath(item.path or kernel_path).suffix.lower()
        reader = files.READERS.get(suffix)
        if reader is not None and python:
            described["load"] = f"import pandas as pd\n\n_frame = {reader.format(path=codegen.literal(kernel_path))}"
        header = files.header(root, item.path, suffix) if item.path else None
        if header:
            described["columns"] = [{"name": name} for name in header[:MAX_COLUMNS]]
    return described


async def solve(request: SolveRequest, config: Whybook) -> AsyncIterator[claude.Event]:
    """Stream progress events, then a result event with the proposed cell.

    The review guard reads the cell's code before the view runs it: a cell
    that the analyst does not run, or that the guard holds back, ends as an
    error, with the code and what the call cost.
    """
    from . import guard

    settings = dataclasses.replace(guard.settings_of(config), language=languages.language(request.language).name)
    # Python, as complete_cell reads it: the language whose code the templates write.
    python = languages.language(request.language).templates
    attempt = request
    # The cost of an answer whose code did not parse, added to the answer that replaces it.
    spent: float | None = None
    for round in range(2):
        broken: dict[str, str] | None = None
        async for event in connection.structured_call(
            attempt.prompt(),
            schema=SCHEMA,
            system_prompt=system_prompt(request.language),
            config=config,
            effort=config.solve_effort,
            images=request.images(),
        ):
            if event["type"] == "result":
                event["cell"] = complete_cell(event.pop("output"), request.defined, request.language)
                code = event["cell"].get("code")
                error = syntax_error(code) if python and round == 0 and isinstance(code, str) else None
                if error:
                    # One more call, with the code and Python's error: the model fixes what it wrote.
                    broken = {"code": code, "error": error}
                    spent = event.get("cost_usd")
                    break
                if spent is not None:
                    event["cost_usd"] = spent + (event.get("cost_usd") or 0.0)
                if settings.checks_code and isinstance(code, str) and code.strip():
                    held: list[guard.Outcome] = []
                    review = guard.code_review(config, settings)
                    async for step in guard.events(
                        lambda emit: guard.review_code(code, settings, emit, what="the cell of an answer", threads=config.local_threads, review=review), held
                    ):
                        yield step
                    if not held[0].go:
                        why = "You did not run the cell that the AI wrote" if held[0].by == "analyst" else f"The review guard held back the cell that the AI wrote: {held[0].reason}"
                        yield {"type": "error", "message": f"{why}.", "guard": True, "code": code, "cost_usd": event.get("cost_usd"), "model": event.get("model")}
                        return
            yield event
        if broken is None:
            return
        attempt = dataclasses.replace(request, previous_attempt=broken)


def syntax_error(code: str) -> str | None:
    """Why Python code with IPython's ``%`` and ``!`` lines does not parse, as Python words it; None when it parses.

    A cell magic (``%%bash``) holds another language, and is not checked.
    """
    if code.lstrip().startswith("%%"):
        return None
    lines = ["" if line.lstrip().startswith(("%", "!")) else line for line in code.splitlines()]
    try:
        ast.parse("\n".join(lines))
    except SyntaxError as error:
        return f"SyntaxError: {error.msg} (line {error.lineno})"
    return None


def complete_cell(cell: dict[str, Any], defined: frozenset[str] = frozenset(), language: str = "python") -> dict[str, Any]:
    """Add the imports that the model's Python code needs and the notebook does not have, and turn
    its assumptions and follow-up questions into the objects the view keeps."""
    if isinstance(cell.get("code"), str) and languages.language(language).templates:
        cell = {**cell, "code": codegen.add_missing_imports(cell["code"], defined)}
    assumptions = (_labelled(item, ASSUMPTION_KINDS, "modelling", "kind") for item in cell.get("assumptions") or [])
    follow_up = (_labelled(item, tuple(TYPES), "descriptive", "type") for item in cell.get("follow_up") or [])
    return {**cell, "assumptions": [a for a in assumptions if a], "follow_up": [f for f in follow_up if f]}
