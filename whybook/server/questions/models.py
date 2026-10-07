"""The data exchanged between the frontend and the question engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .. import languages, privacy

KINDS = (
    "numeric",
    "binary",
    "categorical",
    "datetime",
    "text",
    "id",
    "dataframe",
    "array",
    "constant",
    "model",
    "other",
    # Dragged from the file browser or the Databases panel: not in the kernel yet.
    "file",
    "table",
)

# The question types of the Exploration panel.
TYPES = ("association", "causal", "quality", "model", "descriptive")

PLACEMENT_KINDS = ("edit", "new", "branch", "preview", "metadata")


class InvalidRequest(ValueError):
    """The request body does not describe a valid selection."""


def _optional_int(data: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidRequest(f"{key} must be an integer")
        return value
    return None


def _scalar(value: Any) -> str | int | float | None:
    """A text or a number of the listing as it is; None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    return value


def _library(data: dict[str, Any]) -> str | None:
    """polars for a polars frame or one of its columns; None for pandas and the rest."""
    if data.get("library") == "polars" or str(data.get("type") or "").startswith("polars."):
        return "polars"
    return None


@dataclass(frozen=True)
class Variable:
    """A variable in the kernel, or a column of a data frame.

    ``name`` is the expression that evaluates to it in the kernel, for example
    ``df['age']``. ``label`` is what the user sees, for example ``age``.
    """

    name: str
    label: str
    kind: str
    parent: str | None = None
    tag: str | None = None
    dtype: str | None = None
    rows: int | None = None
    missing: int | None = None
    unique: int | None = None
    n_columns: int | None = None
    value: str | None = None
    levels: tuple[str, ...] = ()
    # A file or a table's database: its path in the server's contents, and the
    # same file from the notebook's folder, where the kernel runs.
    path: str | None = None
    kernel_path: str | None = None
    table: str | None = None
    # The library of the frame, or of the frame a column belongs to, when its
    # code is not pandas code: "polars". A frame names its type, a column its
    # library.
    library: str | None = None
    # The lowest and the highest value of a column of numbers or dates, as the
    # kernel's listing gives them: a date as "2025-02-10 00:00:00".
    minimum: str | int | float | None = None
    maximum: str | int | float | None = None

    @property
    def missing_fraction(self) -> float:
        if not self.rows or not self.missing:
            return 0.0
        return self.missing / self.rows

    @property
    def is_column(self) -> bool:
        return self.parent is not None

    @classmethod
    def from_json(cls, data: Any) -> Variable:
        if not isinstance(data, dict):
            raise InvalidRequest("a variable must be an object")
        name = data.get("name")
        if not isinstance(name, str) or not name:
            raise InvalidRequest("a variable needs a name")
        kind = data.get("kind", "other")
        if kind not in KINDS:
            raise InvalidRequest(f"unknown kind {kind!r} for {name}")
        levels = data.get("levels") or ()
        return cls(
            name=name,
            label=str(data.get("label") or name),
            kind=kind,
            parent=data.get("parent"),
            tag=data.get("tag"),
            dtype=data.get("dtype"),
            rows=_optional_int(data, "rows"),
            missing=_optional_int(data, "missing", "n_missing"),
            unique=_optional_int(data, "unique", "n_unique"),
            n_columns=_optional_int(data, "n_columns"),
            # A key or a token goes to no model, and into no question: its name stands for it.
            value=None if data.get("secret") is True or privacy.looks_secret(name, data.get("value")) else data.get("value"),
            levels=tuple(str(level) for level in levels) if isinstance(levels, list) else (),
            path=str(data["path"]) if kind in ("file", "table") and data.get("path") else None,
            kernel_path=str(data["kernel_path"]) if kind in ("file", "table") and data.get("kernel_path") else None,
            table=str(data["table"]) if kind == "table" and data.get("table") else None,
            library=_library(data),
            minimum=_scalar(data.get("min")),
            maximum=_scalar(data.get("max")),
        )

    def to_state(self) -> dict[str, Any]:
        """The summary sent to a ranking or generating model."""
        state: dict[str, Any] = {"name": self.label, "kind": self.kind}
        for key in ("parent", "tag", "rows", "missing", "unique", "n_columns", "value"):
            value = getattr(self, key)
            if value is not None:
                state[key] = value
        if self.levels:
            state["levels"] = list(self.levels)
        if self.kind in ("file", "table"):
            # The path that code in the kernel opens.
            state["path"] = self.kernel_path or self.path
            if self.table:
                state["table"] = self.table
        return state


@dataclass(frozen=True)
class Selection:
    """What the user picked: a source, and a target that may be the same variable."""

    source: Variable
    target: Variable | None = None

    @property
    def univariate(self) -> bool:
        return self.target is None or self.target.name == self.source.name

    @classmethod
    def from_json(cls, data: Any) -> Selection:
        if not isinstance(data, dict) or "source" not in data:
            raise InvalidRequest("the selection needs a source")
        target = data.get("target")
        return cls(
            source=Variable.from_json(data["source"]),
            target=Variable.from_json(target) if target is not None else None,
        )


@dataclass(frozen=True)
class AskedQuestion:
    id: str
    text: str
    type: str

    @classmethod
    def from_json(cls, data: Any) -> AskedQuestion:
        if not isinstance(data, dict):
            raise InvalidRequest("an asked question must be an object")
        values = [data.get("id"), data.get("text"), data.get("type", data.get("intent", ""))]
        if not all(isinstance(value, str) for value in values):
            raise InvalidRequest("an asked question needs string id, text and type")
        return cls(*values)


def _strings(data: dict[str, Any], key: str) -> list[str]:
    values = data.get(key) or []
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise InvalidRequest(f"{key} must be a list of strings")
    return values


@dataclass(frozen=True)
class Context:
    """What the notebook already contains.

    ``asked`` holds the questions that cells already answer, ``used`` the
    variable names and labels that appear in code cells, and ``cells`` one
    summary per cell, oldest first. ``frames`` maps each frame in the kernel
    to its columns, as ``{label: tag}``, and ``frame_rows`` to its row count,
    so templates can plan joins.
    """

    asked: tuple[AskedQuestion, ...] = ()
    used: frozenset[str] = frozenset()
    cells: tuple[str, ...] = ()
    outcome: str | None = None
    unit: str | None = None
    mode: str = "wonder"
    # The type of the question asked last, in the order the analyst asked.
    last_type: str | None = None
    frames: dict[str, dict[str, str]] = field(default_factory=dict)
    frame_rows: dict[str, int] = field(default_factory=dict)
    # Every outcome and unit that the view knows, best first: the one that the
    # notebook's metadata sets by hand alone, or those that the rules and a
    # model inferred (design iteration 1.64). ``outcome`` and ``unit`` are the
    # first of each.
    outcomes: tuple[str, ...] = ()
    units: tuple[str, ...] = ()
    # The kernel's language_info.name, in lower case. In a kernel whose
    # language the templates do not write (languages.py), their questions go
    # without code, and a model writes the cell in that language.
    language: str = "python"

    @property
    def templates(self) -> bool:
        """Whether the templates' code runs in the kernel."""
        return languages.language(self.language).templates

    def for_kernel(self, options: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The options as JSON, without the templates' code in a kernel of another language."""
        if self.templates:
            return options
        return [{**option, "code": None} for option in options]

    def outcome_in(self, frame: str | None) -> str | None:
        """The first outcome that ``frame`` holds: an analysis of that frame explains it."""
        columns = self.frames.get(frame or "", {})
        for outcome in dict.fromkeys([self.outcome, *self.outcomes]):
            if outcome and outcome in columns:
                return outcome
        return None

    def unit_frame(self) -> str | None:
        """The frame with one row per unit: the smallest frame that has the unit column."""
        candidates = [name for name, columns in self.frames.items() if self.unit and self.unit in columns]
        if not candidates:
            return None
        return min(candidates, key=lambda name: self.frame_rows.get(name, 10**12))

    @property
    def asked_ids(self) -> frozenset[str]:
        return frozenset(question.id for question in self.asked)

    @property
    def asked_types(self) -> frozenset[str]:
        return frozenset(question.type for question in self.asked)

    def type_share(self, kind: str) -> float:
        if not self.asked:
            return 0.0
        return sum(1 for question in self.asked if question.type == kind) / len(self.asked)

    @classmethod
    def from_json(cls, data: Any) -> Context:
        if data is None:
            return cls()
        if not isinstance(data, dict):
            raise InvalidRequest("the context must be an object")
        asked = data.get("asked") or []
        if not isinstance(asked, list):
            raise InvalidRequest("asked must be a list")
        frames = data.get("frames") or {}
        if not isinstance(frames, dict) or not all(isinstance(v, dict) for v in frames.values()):
            raise InvalidRequest("frames must map frame names to {rows, columns}")
        columns = {}
        rows = {}
        for name, frame in frames.items():
            listed = frame.get("columns", frame)
            if not isinstance(listed, dict):
                raise InvalidRequest("frame columns must map labels to tags")
            columns[str(name)] = {str(c): str(t) for c, t in listed.items() if c != "rows" or "columns" in frame}
            if isinstance(frame.get("rows"), int):
                rows[str(name)] = frame["rows"]
        mode = data.get("mode") or "wonder"
        if mode not in ("do", "report", "wonder"):
            raise InvalidRequest(f"unknown mode {mode!r}")
        last_type = data.get("last_type")
        if last_type is not None and last_type not in TYPES:
            raise InvalidRequest(f"unknown question type {last_type!r}")
        outcome, unit = data.get("outcome"), data.get("unit")
        outcomes, units = _strings(data, "outcomes"), _strings(data, "units")
        return cls(
            asked=tuple(AskedQuestion.from_json(item) for item in asked),
            used=frozenset(_strings(data, "used")),
            cells=tuple(_strings(data, "cells")),
            outcome=outcome or (outcomes[0] if outcomes else None),
            unit=unit or (units[0] if units else None),
            mode=mode,
            last_type=last_type,
            frames=columns,
            frame_rows=rows,
            outcomes=tuple(dict.fromkeys(outcomes)),
            units=tuple(dict.fromkeys(units)),
            language=str(data.get("language") or "python").strip().lower() or "python",
        )


@dataclass
class Placement:
    """Where the result of an option goes.

    ``edit`` rewrites ``cell`` in place, ``new`` inserts a cell after
    ``cell``, ``branch`` inserts a branch of ``cell`` that runs in its own
    subshell, and ``preview`` shows the result in the sidebar without writing
    to the notebook.
    """

    kind: str
    cell: str | None = None
    label: str = ""
    why: str = ""
    confidence: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "cell": self.cell,
            "label": self.label,
            "why": self.why,
            "confidence": self.confidence,
        }


@dataclass
class Candidate:
    """A question the user could ask next, or an option offered after a drop.

    ``code`` is the cell source from the offline code templates. When it is
    None, answering the question needs Claude.
    """

    id: str
    text: str
    type: str
    origin: str
    variables: tuple[str, ...]
    prior: float
    template: str | None = None
    probability: float | None = None
    reasons: list[str] = field(default_factory=list)
    effect: str = ""
    placement: Placement | None = None
    code: str | None = None
    # The outcome and the unit that the question takes from the context, by
    # column: {"outcome": "kwh_import"}. The view shows where each came from.
    uses: dict[str, str] | None = None

    def to_json(self) -> dict[str, Any]:
        data = {
            "id": self.id,
            "text": self.text,
            "type": self.type,
            "origin": self.origin,
            "template": self.template,
            "variables": list(self.variables),
            "probability": self.probability,
            "reasons": self.reasons,
            "effect": self.effect,
            "placement": self.placement.to_json() if self.placement else None,
            "code": self.code,
        }
        if self.uses:
            data["uses"] = dict(self.uses)
        return data
