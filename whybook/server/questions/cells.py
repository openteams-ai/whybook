"""What the frontend tells the engine about cells, and the questions about them.

``CellInfo`` is one cell as the view sees it: its source, the analysis of
that source, and its outputs. A markdown cell is its text under its heading.
``cell_questions`` builds the questions for the Map popover, and for the text
of a markdown cell, and ``next_steps`` the "Worth asking next" suggestions.
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass
from typing import Any

from .. import codegen, privacy
from . import reshape, values
from .models import Candidate, Context, InvalidRequest, Placement
from .rankers import score_candidate
from .values import LIBRARY_ALTERNATIVES, WHAT_IF_CHOICES


@dataclass(frozen=True)
class DecisionCall:
    """One call that a decision covers: where the cell names the function, and the frame the call joins or reads.

    ``line`` counts from 1, and ``col`` counts UTF-8 bytes from the start of
    the line, as ``ast`` does (``codegen.call_site``).
    """

    line: int
    col: int
    target: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> DecisionCall:
        if not isinstance(data, dict) or not isinstance(data.get("line"), int) or not isinstance(data.get("col"), int):
            raise InvalidRequest("a call of a decision needs a line and a column")
        target = data.get("target")
        return cls(line=data["line"], col=data["col"], target=target if isinstance(target, str) and target else None)

    @property
    def site(self) -> codegen.Site:
        return (self.line, self.col)


@dataclass(frozen=True)
class Decision:
    name: str
    value: str
    provenance: str
    param: str | None = None
    function: str | None = None
    note: str | None = None
    source_file: str | None = None
    source_line: int | None = None
    # The calls that leave this value, by their place in the cell. A decision
    # kept before 27 September 2026 has none, and its what-if values change
    # every call of its function, as they did then.
    calls: tuple[DecisionCall, ...] = ()

    @classmethod
    def from_json(cls, data: Any) -> Decision:
        if not isinstance(data, dict) or not isinstance(data.get("name"), str):
            raise InvalidRequest("a decision needs a name")
        source = data.get("source") or {}
        return cls(
            name=data["name"],
            value=str(data.get("value", "")),
            provenance=str(data.get("provenance", "literal")),
            param=data.get("param"),
            function=data.get("function"),
            note=data.get("note"),
            source_file=source.get("file") if isinstance(source, dict) else None,
            source_line=source.get("line") if isinstance(source, dict) else None,
            # A call that metadata keeps in another form is left out, rather
            # than refusing every request about the notebook.
            calls=tuple(
                DecisionCall.from_json(call)
                for call in (data.get("calls") if isinstance(data.get("calls"), list) else ())
                if isinstance(call, dict) and isinstance(call.get("line"), int) and isinstance(call.get("col"), int)
            ),
        )

    @property
    def is_open(self) -> bool:
        """A value nobody chose on purpose."""
        return self.provenance in ("defaulted", "library_default")

    @property
    def short_function(self) -> str:
        """``merge`` for ``DataFrame.merge``: the name that the cell calls."""
        return (self.function or "").rsplit(".", 1)[-1]

    def sites(self, calls: tuple[DecisionCall, ...] | None = None) -> list[codegen.Site] | None:
        """The places of ``calls``, or of all the decision's calls; None for a decision that lists none."""
        chosen = self.calls if calls is None else calls
        return [call.site for call in chosen] if chosen else None

    def chosen_calls(self, sites: Any) -> tuple[DecisionCall, ...] | None:
        """The decision's calls at the places ``sites``, as the what-if menu sends them: all of them for None."""
        if sites is None:
            return None
        if not isinstance(sites, list):
            raise InvalidRequest("calls must be a list of calls of the decision")
        wanted = {DecisionCall.from_json(site).site for site in sites}
        chosen = tuple(call for call in self.calls if call.site in wanted)
        if not chosen or len(chosen) != len(wanted):
            raise InvalidRequest(f"the calls are not calls that leave {self.name} = {self.value}")
        return chosen


@dataclass(frozen=True)
class CellInfo:
    id: str
    label: str
    source: str
    section: str | None = None
    title: str = ""
    defs: tuple[str, ...] = ()
    uses: tuple[str, ...] = ()
    formulas: tuple[str, ...] = ()
    columns: tuple[tuple[str, str], ...] = ()
    decisions: tuple[Decision, ...] = ()
    outputs: tuple[str, ...] = ()
    branch_of: str | None = None
    # "code", or "markdown": then the source is the text under the heading.
    type: str = "code"
    # The source is words the user selected in the cell, not all of its text.
    excerpt: bool = False

    @classmethod
    def from_json(cls, data: Any) -> CellInfo:
        if not isinstance(data, dict) or not isinstance(data.get("id"), str):
            raise InvalidRequest("a cell needs an id")
        columns = []
        for frame, names in (data.get("columns") or {}).items():
            columns.extend((str(frame), str(name)) for name in names)
        return cls(
            id=data["id"],
            label=str(data.get("label") or f"[{data['id'][:6]}]"),
            source=str(data.get("source", "")),
            section=data.get("section"),
            title=str(data.get("title") or ""),
            defs=tuple(data.get("defs") or ()),
            uses=tuple(data.get("uses") or ()),
            formulas=tuple(data.get("formulas") or ()),
            columns=tuple(columns),
            # A key or a token is no choice to try, and its text would go into the questions (privacy.looks_secret).
            decisions=tuple(
                decision
                for decision in (Decision.from_json(d) for d in data.get("decisions") or ())
                if not privacy.looks_secret(decision.name, decision.value)
            ),
            outputs=tuple(data.get("outputs") or ()),
            branch_of=data.get("branch_of"),
            type="markdown" if data.get("type") == "markdown" else "code",
            excerpt=bool(data.get("excerpt")),
        )

    def involves(self, name: str, label: str | None = None) -> bool:
        if name in self.uses or name in self.defs:
            return True
        return label is not None and any(column == label for _, column in self.columns)

    @property
    def model(self) -> codegen.ModelCall | None:
        return codegen.model_call(self.source) if self.formulas else None


def unit_noun(unit: str | None) -> str:
    """"patient" for "patient_id": the thing the unit column identifies."""
    if not unit:
        return "row"
    for suffix in ("_id", "_key", "id"):
        if unit.lower().endswith(suffix) and len(unit) > len(suffix):
            return unit[: -len(suffix)].rstrip("_")
    return unit


def question_id(*parts: str) -> str:
    return "q:" + hashlib.sha1("|".join(parts).encode()).hexdigest()[:12]


def primary_frame(cell: CellInfo, context: Context) -> str | None:
    """The frame a cell's result lives in: one it defines or uses that has the outcome."""
    defined = [name for name in cell.defs if name in context.frames]
    used = [name for name in cell.uses if name in context.frames]
    for group in (defined, used):
        for name in group:
            if context.outcome and context.outcome in context.frames[name]:
                return name
    return (defined or used or [None])[0]


def outcome_frame(context: Context) -> str | None:
    """The smallest frame with both the outcome and the unit, which averages cheapest per unit."""
    if not context.outcome:
        return None
    candidates = [
        name
        for name, columns in context.frames.items()
        if context.outcome in columns and (not context.unit or context.unit in columns)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda name: context.frame_rows.get(name, 10**12))


def site_column(context: Context, frame: str | None) -> str | None:
    """A site-like grouping column reachable from ``frame``."""
    names = ("site", "center", "centre", "clinic", "hospital")
    for name in names:
        if frame and name in context.frames.get(frame, {}):
            return name
    for columns in context.frames.values():
        for name in names:
            if name in columns:
                return name
    return None


def group_column(context: Context) -> str | None:
    """The column that splits units into compared groups, such as a treatment arm."""
    unit_frame = context.unit_frame()
    if unit_frame is None:
        return None
    columns = context.frames[unit_frame]
    for name, tag in columns.items():
        if any(word in name.lower() for word in ("arm", "treat", "group", "exposure")) and tag in ("cat", "bool", "int"):
            return name
    return next((name for name, tag in columns.items() if tag in ("cat", "bool") and name != context.unit), None)


def suggestion(decision: Decision, source: str = "") -> values.Suggestion:
    """The kind of a decision's constant, read by the rules from its name, its value and ``source``, the code of its cell, and the values to try."""
    return values.suggest(decision.name, decision.value, decision.param, decision.function, decision.provenance, source)


def what_if_values(decision: Decision, source: str = "") -> list[str]:
    """Other values to try for a decision, by the kind of its constant: common lengths of time for a count of days, the conventional levels for a significance level."""
    return [value.text for value in suggestion(decision, source).values]


def sweep_list(decision: Decision, source: str = "", tried: list[str] | None = None) -> list[str]:
    """The values of a sweep over a decision: its own value among the values to try, in order for numbers."""
    others = what_if_values(decision, source) if tried is None else tried
    return values.sweep_values(decision.value, others) if others else []


def _changed(before: str, after: str) -> str:
    """How a value changes: "7 instead of 14 (−7)", "0.8 instead of 0.9 (−0.1)" for a share, "12.0 instead of 15.5 (÷1.29)"."""
    try:
        old, new = float(before), float(after)
    except ValueError:
        return f"{after} instead of {before}"
    delta = new - old
    sign = "+" if delta > 0 else "−"
    if new.is_integer() and old.is_integer():
        return f"{after} instead of {before} ({sign}{abs(int(delta))})"
    # A share, a threshold or a level between 0 and 1 changes by points.
    if 0 <= new <= 1 and 0 <= old <= 1:
        return f"{after} instead of {before} ({sign}{abs(delta):.4g})"
    if min(new, old) > 0:
        return f"{after} instead of {before} ({'×' if delta > 0 else '÷'}{max(new, old) / min(new, old):.3g})"
    return f"{after} instead of {before}"


JOINS = {"merge", "join", "merge_asof", "merge_ordered"}


def call_nouns(decision: Decision) -> tuple[str, str]:
    """What one call of a decision's function is, and several: merge and merges, read and reads, call and calls."""
    function = decision.short_function
    if function in JOINS:
        noun = "join" if function == "join" else "merge"
        return noun, f"{noun}s"
    if function.startswith(("read_", "scan_")):
        return "read", "reads"
    return "call", "calls"


def call_name(decision: Decision, call: DecisionCall) -> str:
    """One call of a decision, as the what-if menu names it: "the merge with weather".

    A call is named by the frame it joins or reads, and by its line where
    that does not tell it from the decision's other calls.
    """
    noun, _ = call_nouns(decision)
    function = decision.short_function
    if call.target:
        what = f"the {noun} with {call.target}" if noun in ("merge", "join") else f"the {noun} of {call.target}" if noun == "read" else f"the {function} of {call.target}"
        if sum(other.target == call.target for other in decision.calls) == 1:
            return what
        return f"{what} on line {call.line}"
    return f"the {noun if noun != 'call' else function} on line {call.line}"


def where_text(decision: Decision, chosen: tuple[DecisionCall, ...] | None) -> str:
    """Where a what-if value goes, after "in", for a decision of several calls: "both merges", "the merge with weather".

    Empty for a decision of one call, or of calls it does not list.
    """
    if len(decision.calls) <= 1:
        return ""
    _, nouns = call_nouns(decision)
    if chosen is None or len(chosen) == len(decision.calls):
        return f"both {nouns}" if len(decision.calls) == 2 else f"all {len(decision.calls)} {nouns}"
    if len(chosen) == 1:
        return call_name(decision, chosen[0])
    return f"{len(chosen)} of the {len(decision.calls)} {nouns}"


def what_if_code(cell: CellInfo, decision: Decision, value: str, calls: tuple[DecisionCall, ...] | None = None) -> str | None:
    """A branch of the cell with the decision set to ``value``, keeping the original's variables.

    The value goes into the decision's calls, or into ``calls`` alone, such
    as one merge of two; a decision that lists no calls changes every call
    of its function.
    """
    function = decision.short_function
    at = decision.sites(calls)
    if function and decision.param:
        if decision.provenance == "literal":
            body = codegen.replace_keyword_value(cell.source, function, decision.param, value, at) or codegen.replace_argument(cell.source, function, decision.value, value, at)
        else:
            body = codegen.add_keyword(cell.source, function, decision.param, value, at)
    else:
        body = codegen.replace_assignment(cell.source, decision.name, value)
    if body is None:
        return None
    suffix = codegen.identifier("if " + value.replace("-", "minus "))
    body = codegen.rename(body, {name: f"{name}_{suffix}" for name in codegen.defined_names(cell.source)})
    if body is None:
        return None
    where = where_text(decision, calls)
    question = f"What if {decision.name} were {value}{f' in {where}' if where else ''}?"
    return f"{codegen.comment(f'{question} A branch of {cell.label}, where it is {decision.value}.')}\n{body.rstrip()}"


def suggested_values(data: Any) -> list[values.Value] | None:
    """The values that a model suggested, as the view sends them back to build their branches: None when it sends none."""
    if data is None:
        return None
    if not isinstance(data, list):
        raise InvalidRequest("suggested must be a list of values")
    return values.usable(data, "", limit=5)


def decision_options(
    cell: CellInfo,
    decision: Decision,
    context: Context,
    value: str | None = None,
    calls: tuple[DecisionCall, ...] | None = None,
    suggested: list[values.Value] | None = None,
) -> dict[str, Any]:
    """What-if branches for one decision of a cell: other values, a sweep, or a value typed by the analyst.

    The values follow the kind of the constant (values.suggest): "kind" names
    it and "rule" says how the values were chosen. When no rule knows the
    kind, "ask_model" is true and the values are the fallback's, half below
    and above, until the view brings a model's values as ``suggested``.

    With ``calls``, the values go into those calls of the decision alone, and
    each question says where: "What if how were "left" in the merge with
    weather?".
    """
    branch = Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel")
    where = f"{decision.source_file}:{decision.source_line}" if decision.source_file and decision.source_line else decision.source_file
    place = where_text(decision, calls)
    within = f" in {place}" if place else ""
    options = []
    found = None
    if value is not None:
        value = value.strip()
        try:
            ast.parse(value, mode="eval")
        except SyntaxError as error:
            raise InvalidRequest(f"{value} is not a Python value") from error
        tried = [values.Value(value, "")]
    elif suggested is not None:
        tried = [item for item in suggested if values.value_key(item.text) != values.value_key(decision.value)]
    else:
        found = suggestion(decision, cell.source)
        tried = list(found.values)
    for other in tried:
        code = what_if_code(cell, decision, other.text, calls)
        if code is not None:
            effect = _changed(decision.value, other.text) + (f" · {other.why}" if other.why else "")
            option = _question(f"What if {decision.name} were {other.text}{within}?", "model", 0.6, branch, code, effect, cell.id, decision.name)
            option.template = "what_if_value"
            options.append(option)
    if value is None:
        swept = sweep_list(decision, cell.source, [other.text for other in tried])
        sweep = sweep_code(cell, decision, context, calls, swept) if decision.provenance == "defaulted" and swept else None
        if sweep is not None:
            option = _question(f"Compare {decision.name} = {', '.join(swept)}{within} in one table", "model", 0.55, branch, sweep, f"Re-runs {cell.label} with each value", cell.id, decision.name)
            option.template = "what_if_sweep"
            options.append(option)
        function = decision.short_function
        if decision.is_open and function and decision.param:
            explicit = codegen.add_keyword(cell.source, function, decision.param, decision.name, decision.sites(calls))
            if explicit is not None:
                origin = f" in {where}" if where else f" of {decision.function}"
                code = f"{decision.name} = {decision.value}  {codegen.comment(f'chosen here; was the default{origin}')}\n{explicit}"
                edit = Placement("edit", cell.id, f"edit {cell.label} in place")
                option = _question(f"Choose {decision.name} in {cell.label}{f', in {place}' if place else ''}", "model", 0.5, edit, code, "An explicit choice in the cell, to change there", cell.id, decision.name)
                option.template = "what_if_choice"
                options.append(option)
    for option in options:
        score_candidate(option, [], context)
    note = {
        "defaulted": "defaulted",
        "library_default": "a library default",
        "literal": "written in the cell",
        "agent": "chosen by AI",
        "template": "chosen by the template you picked",
    }.get(decision.provenance, "")
    result: dict[str, Any] = {
        "title": f"{decision.name} = {decision.value}",
        "note": f"{note} in {where}" if where and decision.provenance == "defaulted" else note,
        "options": [option.to_json() for option in options],
    }
    if found is not None:
        # The kind that the rules read, and whether a model should choose the values instead.
        result["kind"] = found.label or None
        result["rule"] = found.rule or None
        result["ask_model"] = found.kind is None
    return result


def sweep_names(source: str, decision: str) -> dict[str, str]:
    """New names for what a cell defines, in a loop over the values of ``decision``.

    ``weekly`` becomes ``_weekly_at_min_days`` in a loop over MIN_DAYS. Two
    loops over two decisions of one cell can run as branches at the same
    time, in one namespace, so the decision is part of the name.
    """
    key = codegen.identifier(decision)
    return {name: f"_{name}_at_{key}" for name in codegen.defined_names(source)}


def sweep_code(
    cell: CellInfo, decision: Decision, context: Context, calls: tuple[DecisionCall, ...] | None = None, tried: list[str] | None = None
) -> str | None:
    """A branch that re-runs a cell with other values of a defaulted parameter, in its calls or in ``calls`` alone.

    The values are ``tried``, or else the decision's own value among the
    values that its kind gives (sweep_list). Its temporaries are named after
    the decision, such as ``_min_days_value`` and ``_min_days_sweep_rows``,
    and deleted at the end.
    """
    if not decision.function or not decision.param:
        return None
    swept = tried if tried is not None else sweep_list(decision, cell.source)
    if not swept:
        return None
    result = codegen.identifier(f"{decision.name}_sweep")
    # A public name, so the decision chip reads as the values that were tried.
    listed = codegen.identifier(f"{decision.name}_values")
    rows, index, value = codegen.temporary(result, "rows"), codegen.temporary(decision.name, "index"), codegen.temporary(decision.name, "value")
    body = codegen.add_keyword(cell.source, decision.short_function, decision.param, value, decision.sites(calls))
    if body is None:
        return None
    renamed = sweep_names(cell.source, decision.name)
    body = codegen.rename(body, renamed)
    if body is None:
        return None
    body = codegen.add_keyword(body, "ribbon", "title", f'f"{decision.name} = {{{value}}}"') or body
    summary = []
    for name, copy in renamed.items():
        columns = context.frames.get(name)
        if columns is None:
            continue
        summary.append(f"{codegen.literal(f'{name} rows')}: len({copy})")
        if context.unit and context.unit in columns:
            summary.append(f"{codegen.literal(f'{context.unit}s')}: {copy}[{codegen.literal(context.unit)}].nunique()")
        if context.outcome and context.outcome in columns:
            summary.append(f"{codegen.literal(f'mean {context.outcome}')}: round({copy}[{codegen.literal(context.outcome)}].mean(), 3)")
    if not summary:
        return None
    lines = [
        codegen.comment(f"What changes if {decision.name} changes? Re-runs {cell.label} with {', '.join(swept)}."),
        "import whybook",
        "import pandas as pd",
        "",
        f"{rows} = {{}}",
        f"{listed} = [{', '.join(swept)}]",
        f"for {index}, {value} in enumerate({listed}):",
        f'    whybook.progress({index} / len({listed}), f"{decision.name} = {{{value}}}")',
        codegen.indent(body.rstrip()),
        f"    {rows}[{value}] = {{{', '.join(summary)}}}",
        'whybook.progress(1.0, "done")',
        # One row per value, each column with its own type: a transpose made the counts floats.
        f'{result} = pd.DataFrame.from_dict({rows}, orient="index").rename_axis({codegen.literal(decision.name)})',
        f"del {', '.join([rows, listed, index, value, *renamed.values()])}",
        result,
    ]
    return "\n".join(lines)


def alternative_value(decision: Decision) -> str | None:
    """The other value that a branch tries for a library default.

    The function's own choice comes first, since a parameter can mean different
    things to different functions: how="left" is a join for merge, and dropna
    takes only "any" or "all".
    """
    function = (decision.function or "").rsplit(".", 1)[-1]
    chosen = WHAT_IF_CHOICES.get((function, decision.param or ""))
    if chosen is not None:
        value = decision.value.strip().strip("'\"")
        return next((choice for choice in chosen if choice.strip("'\"") != value), None)
    return LIBRARY_ALTERNATIVES.get(decision.param or "")


def alternative_code(cell: CellInfo, decision: Decision) -> str | None:
    """A branch with one library default changed in each call that leaves it, keeping the original results."""
    replacement = alternative_value(decision)
    if replacement is None or not decision.function or not decision.param:
        return None
    body = codegen.add_keyword(cell.source, decision.short_function, decision.param, replacement, decision.sites())
    if body is None:
        return None
    suffix = codegen.identifier(f"{decision.param}_{replacement.strip(chr(34))}")
    defined = codegen.defined_names(cell.source)
    body = codegen.rename(body, {name: f"{name}_{suffix}" for name in defined})
    if body is None:
        return None
    return f"{codegen.comment(f'Branch of {cell.label}: {decision.param}={replacement} instead of the default {decision.value}.')}\n{body.rstrip()}"


def random_slope_code(cell: CellInfo) -> str | None:
    call = cell.model
    if call is None or "re_formula" not in call.keywords or call.data is None:
        return None
    others = {k: v for k, v in call.keywords.items() if k not in ("re_formula",)}
    arguments = ", ".join(f"{k}={v}" for k, v in others.items())
    # The two fits and their likelihood ratio, named for what they hold.
    slope, intercept, ratio = "_random_slope_fit", "_random_intercept_fit", "_random_slope_lr"
    formula = codegen.literal(call.formula)
    return "\n".join(
        [
            codegen.comment(f"Is the random slope in {cell.label} justified? Likelihood ratio test against a random intercept only."),
            "import pandas as pd",
            "import statsmodels.formula.api as smf",
            "from scipy import stats",
            "",
            f'{slope} = smf.{call.function}({formula}, data={call.data}, re_formula={call.keywords["re_formula"]}, {arguments}).fit(reml=False)',
            f"{intercept} = smf.{call.function}({formula}, data={call.data}, {arguments}).fit(reml=False)",
            f"{ratio} = 2 * ({slope}.llf - {intercept}.llf)",
            "random_slope_test = pd.Series(",
            f'    {{"log likelihood, slope": {slope}.llf, "log likelihood, intercept only": {intercept}.llf, "LR": {ratio},'
            f' "p (chi-squared, 2 df, conservative)": stats.chi2.sf({ratio}, 2)}}',
            ").round(4)",
            f"del {slope}, {intercept}, {ratio}",
            "random_slope_test",
        ]
    )


def residuals_code(cell: CellInfo, context: Context) -> tuple[str, str] | None:
    call = cell.model
    if call is None or call.fit_target is None or call.data is None:
        return None
    group = site_column(context, call.data if call.data in context.frames else None)
    if group is None or group not in context.frames.get(call.data, {}):
        return None
    code = "\n".join(
        [
            codegen.comment(f"Are the residuals of {cell.label} well behaved per {group}?"),
            "import whybook",
            "",
            f'whybook.by_group({call.data}.assign(residual={call.fit_target}.resid), "residual", {codegen.literal(group)})',
        ]
    )
    return code, group


def dropped_code(cell: CellInfo, decision: Decision, context: Context) -> tuple[str, str] | None:
    """Who a filtering function of the user's own removes, split by the compared groups."""
    unit_frame = context.unit_frame()
    group = group_column(context)
    if not (decision.function and context.unit and unit_frame and group):
        return None
    frames = [name for name in cell.uses if name in context.frames and context.unit in context.frames[name]]
    if not frames or f"{decision.function}" not in cell.source:
        return None
    frame = frames[0]
    result = codegen.identifier(f"dropped_by_{decision.function}")
    # Such as _diary_kept_by_drop_sparse and _patients_removed_by_drop_sparse.
    kept = codegen.temporary(frame, "kept_by", decision.function)
    removed = codegen.temporary(f"{unit_noun(context.unit)}s", "removed_by", decision.function)
    unit = codegen.literal(context.unit)
    code = "\n".join(
        [
            codegen.comment(f"Who does {decision.function} remove in {cell.label}, and does it differ by {group}?"),
            f"{kept} = {frame}.pipe({decision.function})",
            f"{removed} = {frame}.loc[~{frame}.index.isin({kept}.index), {unit}].unique()",
            f"{result} = (",
            f"    {unit_frame}.assign(dropped={unit_frame}[{unit}].isin({removed}))",
            f'    .groupby({codegen.literal(group)}, observed=True)["dropped"]',
            '    .agg(dropped="sum", share="mean")',
            ")",
            f"del {kept}, {removed}",
            result,
        ]
    )
    return code, group


def _question(text: str, kind: str, prior: float, placement: Placement, code: str | None, effect: str, *parts: str) -> Candidate:
    return Candidate(
        id=question_id(text, *parts),
        text=text,
        type=kind,
        origin="template",
        variables=(),
        prior=prior,
        effect=effect,
        placement=placement,
        code=code,
    )


def single_cell_questions(cell: CellInfo, context: Context) -> list[Candidate]:
    questions = []
    for decision in cell.decisions:
        if decision.provenance == "defaulted":
            swept = sweep_list(decision, cell.source)
            code = sweep_code(cell, decision, context, tried=swept)
            questions.append(
                _question(
                    f"Does {decision.name} = {decision.value} change what {cell.label} shows?",
                    "model",
                    0.7,
                    Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel"),
                    code,
                    f"Re-runs {cell.label} with {', '.join(swept)}" if swept else "Re-runs the cell with other values",
                    cell.id,
                )
            )
            dropped = dropped_code(cell, decision, context)
            if dropped:
                questions.append(
                    _question(
                        f"Who does {decision.function} remove here, and does it differ by {dropped[1]}?",
                        "quality",
                        0.6,
                        Placement("new", cell.id, f"new cell after {cell.label}"),
                        dropped[0],
                        f"Rows removed by {decision.function}, per {dropped[1]}",
                        cell.id,
                    )
                )
        elif decision.provenance == "library_default":
            questions.append(
                _question(
                    f"Is {decision.name}={decision.value} changing the result of {cell.label}?",
                    "model",
                    0.6,
                    Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel"),
                    alternative_code(cell, decision),
                    decision.note or "Refits with the alternative",
                    cell.id,
                )
            )
        elif decision.provenance == "agent":
            questions.append(
                _question(
                    f"Is {decision.name} = {decision.value} the right choice in {cell.label}?",
                    "model",
                    0.35,
                    Placement("new", cell.id, f"new cell after {cell.label}"),
                    None,
                    "The agent chose it; nobody checked it",
                    cell.id,
                )
            )
    if cell.model is not None:
        slope = random_slope_code(cell)
        if slope:
            questions.append(
                _question(
                    f"Is the random slope in {cell.label} justified?",
                    "model",
                    0.55,
                    Placement("new", cell.id, f"new cell after {cell.label}"),
                    slope,
                    "Likelihood ratio against intercept only",
                    cell.id,
                )
            )
        residuals = residuals_code(cell, context)
        if residuals:
            questions.append(
                _question(
                    f"Are the residuals well behaved per {residuals[1]}?",
                    "model",
                    0.5,
                    Placement("new", cell.id, f"new cell after {cell.label}"),
                    residuals[0],
                    f"Residual summary per {residuals[1]}",
                    cell.id,
                )
            )
    if "plot" in cell.outputs and context.unit:
        questions.append(
            _question(
                f"Is averaging hiding variation between {unit_noun(context.unit)}s?",
                "descriptive",
                0.45,
                Placement("new", cell.id, f"new cell after {cell.label}"),
                None,
                "Shows individual trajectories next to the mean",
                cell.id,
            )
        )
    return questions


def multi_cell_questions(cells: list[CellInfo], context: Context) -> list[Candidate]:
    labels = " and ".join(cell.label for cell in cells)
    last = cells[-1]
    after = Placement("new", last.id, f"new cell after {last.label}")
    models = [cell for cell in cells if cell.formulas]
    plots = [cell for cell in cells if "plot" in cell.outputs]
    questions = []
    if len(cells) == 2 and (len(models) == 2 or any(cell.branch_of in {c.id for c in cells} for cell in cells)):
        first, second = cells
        questions += [
            _question(f"Do {first.label} and {second.label} agree on the effect of interest?", "model", 0.7, after, None, "Side-by-side estimates", *[c.id for c in cells]),
            _question("Which fits better, and by what criterion?", "model", 0.55, after, None, "You choose the criterion first", *[c.id for c in cells]),
            Candidate(
                id=question_id("keep", *[c.id for c in cells]),
                text="Keep one branch, or report both?",
                type="model",
                origin="template",
                variables=(),
                prior=0.45,
                effect="Records the decision as an assumption",
                placement=Placement("metadata", None, "notebook assumptions"),
                action={"kind": "assumption", "text": f"Report both {first.label} and {second.label}"},
            ),
        ]
    elif plots and models:
        plot, model = plots[0], models[0]
        questions += [
            _question(f"Is the trajectory in {plot.label} what {model.label} estimates?", "model", 0.65, Placement("edit", plot.id, f"edit {plot.label}"), None, f"Overlays {model.label}'s predictions on {plot.label}", plot.id, model.id),
            _question(f"Does {model.label} model the same rows {plot.label} plots?", "quality", 0.55, after, None, "Row-level difference of the two inputs", plot.id, model.id),
        ]
    questions += [
        _question("What do these cells share, and where do they diverge?", "descriptive", 0.45, after, None, "Inputs, rows and assumptions compared", *[c.id for c in cells]),
        _question(f"Are the conclusions of {labels} consistent?", "model", 0.4, after, None, "Checks estimates and directions", *[c.id for c in cells]),
    ]
    return questions


# A number worth checking in a text: one with a decimal point, a percent sign
# or an exponent, or a whole number of 100 or more.
NUMBER = re.compile(r"(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?!\w)")
# Words that state a cause rather than an association.
CAUSAL = re.compile(
    r"\b(?:caus(?:e|es|ed|ing)|leads? to|led to|reduc(?:e|es|ed|ing)|improv(?:e|es|ed|ing)|prevent(?:s|ed|ing)?"
    r"|because|due to|effect of|drives|driven by)\b",
    re.IGNORECASE,
)


def excerpt(text: str, limit: int = 60) -> str:
    """The start of a text, cut at a word: at most ``limit`` characters."""
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    cut = flat[: limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(",;:.") + "…"


def states_numbers(text: str) -> bool:
    """Whether a text states a number worth checking against the outputs."""
    for match in NUMBER.finditer(text):
        token = match.group(0)
        if any(mark in token for mark in ".%eE") or abs(float(token.replace(",", ""))) >= 100:
            return True
    return False


def note_questions(notes: list[CellInfo], context: Context) -> list[Candidate]:
    """Questions about the text of markdown cells: the analyst's writeup of the results.

    An AI model answers each one with a cell after the text, as no template
    reads prose. The view checks the numbers of the text itself, offline.
    """
    text = "\n\n".join(note.source for note in notes)
    last = notes[-1]
    if len(notes) > 1:
        subject = "these texts"
    elif last.excerpt:
        subject = f"“{excerpt(last.source)}”"
    else:
        subject = "this text"
    after = Placement("new", last.id, f"new cell after {last.label}")
    parts = [note.id for note in notes] + [text]
    questions = []
    if states_numbers(text):
        questions.append(
            _question(
                f"Can each number in {subject} be recomputed from the data?",
                "quality",
                0.7,
                after,
                None,
                "AI writes a cell that puts each number beside the value the data gives",
                *parts,
            )
        )
        questions.append(
            _question(f"How uncertain are the estimates in {subject}?", "model", 0.5, after, None, "AI writes a cell with an interval for each estimate", *parts)
        )
    questions.append(
        _question(f"Do the results support each claim in {subject}?", "model", 0.6, after, None, "AI writes a check of each claim against the data", *parts)
    )
    causal = CAUSAL.search(text)
    if causal:
        questions.append(
            _question(
                f"Does “{causal.group(0)}” claim a cause that the design does not show?",
                "causal",
                0.55,
                after,
                None,
                "AI writes a check of what reading it as a cause assumes",
                *parts,
            )
        )
    site = site_column(context, outcome_frame(context))
    if site:
        questions.append(
            _question(
                f"Do the claims in {subject} hold at every {site}?",
                "model",
                0.45,
                after,
                None,
                f"AI writes a cell that repeats the main estimate per {site}",
                *parts,
            )
        )
    return questions


def writeup_questions(notes: list[CellInfo], cells: list[CellInfo]) -> list[Candidate]:
    """Questions about a text and the code cells selected with it."""
    texts = " and ".join(note.label for note in notes)
    labels = " and ".join(cell.label for cell in cells)
    after = Placement("new", notes[-1].id, f"new cell after {notes[-1].label}")
    ids = [item.id for item in notes + cells]
    return [
        _question(
            f"Does {texts} say what {labels} {'shows' if len(cells) == 1 else 'show'}?",
            "model",
            0.7,
            after,
            None,
            "AI writes a check of the text against the results of the cells",
            *ids,
        )
    ]


def cell_questions(cells: list[CellInfo], context: Context) -> list[Candidate]:
    notes = [cell for cell in cells if cell.type == "markdown"]
    code = [cell for cell in cells if cell.type != "markdown"]
    if notes and not code:
        questions = note_questions(notes, context)
    elif notes:
        questions = writeup_questions(notes, code)
        questions += single_cell_questions(code[0], context) if len(code) == 1 else multi_cell_questions(code, context)
    elif len(cells) == 1:
        questions = single_cell_questions(cells[0], context)
    else:
        questions = multi_cell_questions(cells, context)
    for question in questions:
        score_candidate(question, [], context)
    return sorted(questions, key=lambda q: q.probability or 0.0, reverse=True)


# A cell's label, as the view writes it: [4], [4b], [ ] for a cell that has not run, [·b] for its branch.
_LABEL = re.compile(r"\[(?:\d+|·)?[a-z]?\]|\[ \]")


def _without_labels(text: str) -> str:
    return _LABEL.sub("[]", text)


def next_steps(cells: list[CellInfo], context: Context, groups: dict[str, list[dict]], dismissed: set[str]) -> list[Candidate]:
    """Questions tied to gaps: open assumptions, unexplored columns and thin column groups."""
    steps = []
    # The questions that a branch of each cell answers. A label is an execution
    # count, so a branch that answers "... of [4]?" answers "... of [10]?" once
    # its cell has run again.
    branched = {(cell.branch_of, _without_labels(cell.title)) for cell in cells if cell.branch_of}
    for cell in cells:
        for decision in cell.decisions:
            if not decision.is_open:
                continue
            text = f"Does {decision.name} = {decision.value} change the result of {cell.label}?"
            if (cell.id, _without_labels(text)) in branched:
                continue
            code = sweep_code(cell, decision, context) if decision.provenance == "defaulted" else alternative_code(cell, decision)
            steps.append(
                Candidate(
                    id=question_id(text),
                    text=text,
                    type="model",
                    origin="template",
                    variables=(),
                    prior=0.6,
                    reasons=[f"Open assumption in {cell.label}"],
                    placement=Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel"),
                    code=code,
                )
            )
    outcome = context.outcome
    source = outcome_frame(context)
    # A measure in numbered columns, such as pain_1 to pain_7, is one measure
    # on seven days: the reshape to one row per day comes first, unless a
    # frame holds the measures as columns already, and no question pairs
    # pain_2 with pain_1, or pain_1 with pain (design iteration 1.85).
    numbered = {frame: reshape.stub_groups(columns) for frame, columns in context.frames.items() if len(columns) <= 400}
    for frame, stubs in numbered.items():
        wide = reshape.plan(context.frames[frame], context.unit, context.frames[frame]) if stubs else None
        if wide is None or any(set(wide.stubs) <= set(columns) for columns in context.frames.values()):
            continue
        name = reshape.name_for(frame, context.frames)
        text = reshape.text(frame, wide)
        steps.append(
            Candidate(
                id=question_id(text),
                text=text,
                type="descriptive",
                origin="template",
                variables=(),
                prior=0.65,
                reasons=[f"{reshape.words(list(wide.stubs))} each in {wide.per} columns"],
                placement=Placement("new", cells[-1].id if cells else None, "new cell at the end"),
                code="\n".join([codegen.comment(text), "import pandas as pd", "", *reshape.lines(frame, name, wide)]),
            )
        )
    measures = {measure for stubs in numbered.values() for measure, members in stubs.items() if outcome in members}
    if outcome:
        for frame, columns in context.frames.items():
            if len(columns) > 60:
                continue
            stubs = numbered.get(frame, {})
            for column, tag in columns.items():
                if column in (outcome, context.unit) or tag in ("id", "text", "other") or column in context.used:
                    continue
                measure = reshape.stub_of(column, stubs)
                long = measure is not None and any(measure in held for held in context.frames.values())
                if column in measures or (measure and (measures or measure == outcome or long)):
                    continue
                text = f"How does {column} relate to {outcome}?"
                code = None
                if source:
                    plan = _association_plan(source, column, frame, context)
                    code = plan
                steps.append(
                    Candidate(
                        id=question_id(text),
                        text=text,
                        type="association",
                        origin="template",
                        variables=(),
                        prior=0.5,
                        reasons=[f"{column} not explored yet"],
                        placement=Placement("new", cells[-1].id if cells else None, "new cell at the end"),
                        code=code,
                        uses={"outcome": outcome},
                    )
                )
    for frame, listed in groups.items():
        for group in listed:
            used, total = group.get("used", 0), group.get("total", 0)
            if not total or used / total > 0.2 or not outcome or not source or not context.unit:
                continue
            text = f"Which {group['label']} columns of {frame} track {outcome}?"
            unit = codegen.literal(context.unit)
            code = "\n".join(
                [
                    codegen.comment(text),
                    "import whybook",
                    "",
                    f"{codegen.identifier(group['label'] + '_hits')} = whybook.screen(",
                    f"    {frame},",
                    f"    {source}.groupby({unit}, as_index=False)[{codegen.literal(outcome)}].mean(),",
                    f"    on={unit},",
                    f'    columns={frame}.attrs["whybook"]["groups"][{codegen.literal(group["label"])}],',
                    ")",
                    codegen.identifier(group["label"] + "_hits"),
                ]
            )
            steps.append(
                Candidate(
                    id=question_id(text),
                    text=text,
                    type="association",
                    origin="template",
                    variables=(),
                    prior=0.55,
                    reasons=[f"{used} of {total} {group['label']} columns used"],
                    placement=Placement("new", cells[-1].id if cells else None, "new cell at the end"),
                    code=code,
                    uses={"outcome": outcome, "unit": context.unit},
                )
            )
    exposure = group_column(context)
    if outcome and exposure and context.type_share("causal") < 0.15:
        text = f"What could confound {exposure} and {outcome}?"
        steps.append(
            Candidate(
                id=question_id(text),
                text=text,
                type="causal",
                origin="template",
                variables=(),
                prior=0.55,
                reasons=["Few causal questions so far"],
                placement=Placement("new", cells[-1].id if cells else None, "new cell at the end"),
                code=None,
                uses={"outcome": outcome},
            )
        )
    asked = {question.text for question in context.asked}
    steps = [step for step in steps if step.text not in dismissed and step.text not in asked]
    for step in steps:
        score_candidate(step, [], context)
    steps.sort(key=lambda s: s.probability or 0.0, reverse=True)
    # The best question of each type first, so the short list covers several kinds of gap.
    first, rest, seen = [], [], set()
    for step in steps:
        (rest if step.type in seen else first).append(step)
        seen.add(step.type)
    return first + rest


def _association_plan(source: str, column: str, frame: str, context: Context) -> str | None:
    """Code for "How does column relate to the outcome?" at the level of ``source``."""
    result = codegen.identifier(f"{column}_vs_{context.outcome}")
    # Each column's step joins its own frame, such as _bmi_vs_pain_score_data.
    plan = codegen.plan_data(source, [column], context.frames, context.unit, target=codegen.temporary(result, "data"))
    if plan is None:
        return None
    lines = [codegen.comment(f"How does {column} relate to {context.outcome}?"), "import statsmodels.formula.api as smf", ""]
    lines += plan.lines
    lines.append(f"{result} = smf.ols({codegen.formula(context.outcome, [column])}, data={plan.name}).fit()")
    if plan.name != source:
        lines.append(f"del {plan.name}")
    lines.append(f"{result}.summary().tables[1]")
    return "\n".join(lines)
