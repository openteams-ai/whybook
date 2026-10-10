"""Options for a drop, or for a click on a source and then on a target.

The source is a variable or a column. The target is a cell, another variable
or column, or the source itself. Each option carries a question type, a
placement (edit a cell, a new cell, a branch, a sidebar preview, or notebook
metadata) and, when an offline code template exists, the code to run.
Options without code need an AI model.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any, Callable

from .. import codegen
from . import reshape, starts, templates
from .cells import CellInfo, Decision, group_column, primary_frame, question_id, site_column, sweep_code, sweep_list, sweep_names, unit_noun
from .models import Candidate, Context, InvalidRequest, Placement, Selection, Variable
from .rankers import kind_group, learned_order, score_candidate

FRAME_KINDS = ("dataframe",)
COLUMN_KINDS = ("numeric", "binary", "categorical", "datetime", "text", "id")


@dataclass(frozen=True)
class DropRequest:
    source: Variable
    target_cell: CellInfo | None
    target_item: Variable | None
    branch: bool
    parallel: bool
    cells: tuple[CellInfo, ...]
    context: Context

    @classmethod
    def from_json(cls, data: Any) -> DropRequest:
        if not isinstance(data, dict):
            raise InvalidRequest("the body must be an object")
        target = data.get("target") or {}
        modifiers = data.get("modifiers") or {}
        cell = CellInfo.from_json(target["cell"]) if target.get("cell") else None
        item = Variable.from_json(target["item"]) if target.get("item") else None
        if cell is None and item is None:
            raise InvalidRequest("the target needs a cell or an item")
        return cls(
            source=Variable.from_json(data.get("source")),
            target_cell=cell,
            target_item=item,
            branch=bool(modifiers.get("branch")),
            parallel=bool(modifiers.get("parallel")),
            cells=tuple(CellInfo.from_json(c) for c in data.get("cells") or ()),
            context=Context.from_json(data.get("context")),
        )


def _option(
    text: str,
    kind: str,
    prior: float,
    placement: Placement,
    code: str | None,
    effect: str,
    *parts: str,
    uses: dict[str, str] | None = None,
) -> Candidate:
    return Candidate(
        id=question_id(text, *parts),
        text=text,
        type=kind,
        origin="template",
        variables=parts,
        prior=prior,
        effect=effect,
        placement=placement,
        code=code,
        uses=uses,
    )


# Drops onto a cell.


def _frame_for(column: Variable, cell: CellInfo, context: Context) -> str | None:
    """The frame that a question about a column dropped on a cell runs on.

    First a frame of the cell with an outcome that holds the column already,
    such as the frame the column was dragged from, then the frame of the
    cell's result. A cell can define frames that are not its result: an
    agent's plot left grp, 26 weekly means of one arm, and the share between
    patients ran on it (design iteration 1.85).
    """
    defined = [name for name in cell.defs if name in context.frames]
    used = [name for name in cell.uses if name in context.frames]
    for name in defined + used:
        if column.label in context.frames[name] and context.outcome_in(name):
            return name
    return primary_frame(cell, context)


@dataclass(frozen=True)
class Profile:
    """A card that draws a mean over time: ``whybook.time_profile(frame, time, y)`` or ``whybook.ribbon(frame, x=..., y=...)``."""

    function: str
    frame: str
    x: str
    y: str
    by: str | None
    units: str | None


def profile_call(source: str) -> Profile | None:
    """The profile or the trajectory that a cell draws, when its frame and its columns are written as names and texts."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    for function, axes in (("time_profile", ("time", "y", "by")), ("ribbon", ("x", "y", "by"))):
        for call in codegen.calls_to(tree, function):
            if not call.args or not isinstance(call.args[0], ast.Name):
                continue
            given: dict[str, Any] = dict(zip(axes, call.args[1:]))
            given.update({keyword.arg: keyword.value for keyword in call.keywords if keyword.arg})
            texts = {name: node.value for name, node in given.items() if isinstance(node, ast.Constant) and isinstance(node.value, str)}
            x = texts.get(axes[0])
            if x and texts.get("y"):
                return Profile(function, call.args[0].id, x, texts["y"], texts.get("by"), texts.get("units"))
    return None


def _split_options(column: Variable, profile: Profile, cell: CellInfo, context: Context) -> tuple[list[Candidate], str | None]:
    """A category dropped on a profile or a trajectory: the same plot with one line per level.

    tariff on the profile of the half-hourly use drew one bar per tariff,
    and treatment_arm on the trajectory of pain no split at all (design
    iteration 1.85). A level of the units joins on the unit first. On a
    trajectory over a time index, with a line per unit, a mixed model asks
    whether the levels change the trajectory.
    """
    after = Placement("new", cell.id, f"new cell after {cell.label}")
    level = column.label
    temporary = codegen.temporary(profile.y, "by", level, "data")
    plan = codegen.plan_data(profile.frame, [level], context.frames, context.unit, target=temporary, library=column.library)
    if plan is None:
        return [], None
    note = plan.notes[0] + "." if plan.notes else None
    noun = "profile" if profile.function == "time_profile" else "trajectory"
    text = f"The same {noun} of {profile.y}, one line per {level}"
    if profile.function == "time_profile":
        call = f"whybook.time_profile({plan.name}, {codegen.literal(profile.x)}, {codegen.literal(profile.y)}, by={codegen.literal(level)})"
    else:
        call = f"whybook.ribbon({plan.name}, x={codegen.literal(profile.x)}, y={codegen.literal(profile.y)}, by={codegen.literal(level)})"
    lines = [codegen.comment(text), *(["import polars as pl"] if column.library == "polars" and plan.lines else []), "import whybook", "", *plan.lines, call]
    if plan.name != profile.frame:
        lines.append(f"del {plan.name}")
    effect = "A mean and a 95% band per level" + (f", {plan.notes[0].split(': ', 1)[1]}" if plan.notes else "")
    options = [_option(text, "descriptive", 0.85, after, "\n".join(lines), effect, column.name, cell.id)]
    unit = profile.units
    if profile.function == "ribbon" and unit and templates.is_time(Variable(profile.x, profile.x, "numeric")) and column.library != "polars":
        model = codegen.identifier(f"{profile.y}_by_{profile.x}_and_{level}")
        question = f"Does {level} change the trajectory of {profile.y}?"
        frame = plan.name
        code = [
            codegen.comment(f"{question} A mixed model with a random intercept and a slope over {profile.x} per {unit_noun(unit)}."),
            "import statsmodels.formula.api as smf",
            "",
            *plan.lines,
            f"{model} = smf.mixedlm({codegen.literal(f'{codegen.term(profile.y)} ~ {codegen.term(profile.x)} * {codegen.term(level)}')}, {frame}, groups={frame}[{codegen.literal(unit)}], re_formula={codegen.literal(f'~{codegen.term(profile.x)}')}).fit()",
            *([f"del {plan.name}"] if plan.name != profile.frame else []),
            f"{model}.summary().tables[1]",
        ]
        options.append(_option(question, "association", 0.75, after, "\n".join(code), f"A mixed model of {profile.y} ~ {profile.x} × {level}, a slope per {unit_noun(unit)}", column.name, cell.id, uses={"unit": unit}))
    return options, note


# A column of more levels than this asks no question about the effect in each of them.
MAX_MODIFIER_LEVELS = 12


def _interaction_option(column: Variable, cell: CellInfo, context: Context) -> Candidate | None:
    """Does the effect of the model's exposure differ by the column dropped on its cell? (design iteration 1.94)

    sex dropped on an adjusted model of wt82_71 on qsmk offered six
    questions, and none about effect modification. The model is the last
    that the cell fits from a formula: an IPW cell fits the propensity of
    qsmk first, then the weighted model of wt82_71. Its exposure is the
    first column of the formula's right side (``codegen.cross_exposure``).
    The branch runs the cell's code up to the fit with the two crossed, its
    names given a suffix, and ``whybook.effect_by`` shows the interaction
    and the effect in each level. A model that crosses the two already is
    read as it is, in a new cell. A unit's id or a time index is no
    modifier here: a model of a trajectory crosses its exposure with time
    already.
    """
    if not cell.formulas or column.kind not in ("numeric", "binary", "categorical") or templates.is_unit(column, context) or templates.is_time(column):
        return None
    levels = column.kind in ("categorical", "binary")
    if levels and column.unique is not None and column.unique > MAX_MODIFIER_LEVELS:
        return None
    fitted = codegen.fitted_models(cell.source)
    if not fitted:
        return None
    model = fitted[-1]
    crossing = codegen.cross_exposure(model.call.formula, column.label, levels)
    if crossing is None:
        return None
    exposure, label = crossing.exposure, column.label

    def show(fit: str) -> str:
        return f"whybook.effect_by({fit}, {codegen.literal(exposure)}, {codegen.literal(label)})"

    text = f"Does the effect of {exposure} on {crossing.outcome} differ by {label}?"
    if crossing.crossed and model.fit not in codegen.deleted_names(cell.source):
        after = Placement("new", cell.id, f"new cell after {cell.label}")
        code = "\n".join([codegen.comment(f"{text} The model of {cell.label} crosses them already."), "import whybook", "", show(model.fit)])
        return _option(text, "causal", 0.75, after, code, f"Reads the interaction in {cell.label}", column.name, cell.id)
    branch = Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel")
    code = _crossed_branch(column, cell, model, crossing, context, text, show)
    if code is None:
        return _option(text, "causal", 0.75, branch, None, "AI writes the branch", column.name, cell.id)
    # whybook.effect_by takes a number of more than two values at its quartiles.
    where = "in each level" if crossing.modifier.startswith("C(") or (column.unique is not None and column.unique <= 2) else "at its quartiles"
    effect = f"Adds {label} to the model, crossed with {exposure}" if crossing.added else f"Refits with {exposure} × {label}: the effect {where}"
    return _option(text, "causal", 0.75, branch, code, effect, column.name, cell.id)


def _crossed_branch(
    column: Variable,
    cell: CellInfo,
    model: codegen.FittedModel,
    crossing: codegen.Crossing,
    context: Context,
    text: str,
    show: Callable[[str], str],
) -> str | None:
    """The code of the branch: the cell up to its fit, with the new formula, its names given a suffix, then ``whybook.effect_by``.

    A column new to the model comes from the model's data when that data
    holds it: a frame of the kernel's listing that has it, a frame of the
    listing joined with it on the unit first, or data whose columns the
    cell names, as ``nhefs[_covars]`` with "sex" among ``_covars``. Without
    any of these, a model writes the branch.
    """
    lines = cell.source.split("\n")[: model.end]
    kept = codegen.replace_string("\n".join(lines), model.call.formula, crossing.formula)
    if kept is None:
        return None
    joined = None
    if crossing.added:
        data = model.call.data or ""
        if data in context.frames:
            if column.label not in context.frames[data]:
                joined = codegen.plan_data(data, [column.label], context.frames, context.unit, target=codegen.temporary(model.fit, "data"))
                if joined is None:
                    return None
        elif column.label not in {name for _, name in cell.columns}:
            return None
    if joined is not None:
        # The model reads the joined frame, passed as data= or as the second argument.
        at = [model.site]
        swapped = codegen.replace_keyword_value(kept, model.call.function, "data", joined.name, at) or codegen.replace_argument(
            kept, model.call.function, model.call.data or "", joined.name, at
        )
        if swapped is None:
            return None
        rows = swapped.split("\n")
        rows[model.start - 1 : model.start - 1] = joined.lines
        kept = "\n".join([*rows, f"del {joined.name}"])
    suffix = codegen.identifier(f"by {column.label}")
    body = codegen.rename(kept, {name: f"{name}_{suffix}" for name in codegen.defined_names(kept)})
    if body is None:
        return None
    head = [codegen.comment(f"{text} {cell.label} again, with {crossing.exposure} crossed with {column.label}."), "import whybook"]
    code = "\n".join(head + ([] if body.lstrip().startswith(("import ", "from ")) else [""]) + [body.rstrip(), show(f"{model.fit}_{suffix}")])
    try:
        ast.parse(code)
    except SyntaxError:
        return None
    return code


def _column_onto_cell(column: Variable, cell: CellInfo, context: Context) -> tuple[list[Candidate], str | None]:
    after = Placement("new", cell.id, f"new cell after {cell.label}")
    branch = Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel")
    edit = Placement("edit", cell.id, f"edit {cell.label} in place")
    # A category with few levels on a profile or a trajectory splits it first.
    profile = profile_call(cell.source)
    few = column.kind in ("categorical", "binary") and (column.unique is None or column.unique <= 8)
    split: list[Candidate] = []
    split_note = None
    if profile and few and not templates.is_unit(column, context) and column.label not in (profile.x, profile.y, profile.by):
        split, split_note = _split_options(column, profile, cell, context)
    base = _frame_for(column, cell, context)
    # A cell whose frame lacks the outcome, such as the raw diary before its
    # reshape, cannot answer a question about the outcome "here". Of the
    # outcomes that the view knows, the first that the frame holds.
    outcome = context.outcome_in(base)
    uses = {"outcome": outcome} if outcome else None
    options = []
    note = None
    if templates.is_unit(column, context):
        # A unit's id is no covariate, and its 318 patients no levels to plot:
        # how much of the outcome lies between the units (design iteration 1.75).
        if base and outcome and column.label != outcome:
            text = f"How much of the variation in {outcome} lies between {unit_noun(column.label)}s?"
            plan = codegen.plan_data(base, [column.label], context.frames, context.unit, target=codegen.temporary(outcome, "by", column.label, "data"))
            code = _helper_code(text, plan, f"whybook.icc({plan.name}, {codegen.literal(outcome)}, {codegen.literal(column.label)})", None) if plan else None
            options.append(_option(text, "association", 0.7, after, code, "The share between them, the ICC, in words", column.name, cell.id, uses=uses))
        return options, None
    if base and outcome and column.label != outcome:
        site = site_column(context, base)
        needed = [column.label] + ([site] if site and site != column.label else [])
        result = codegen.identifier(f"{column.label}_vs_{outcome}")
        # The frame the model is fitted on: _il6_vs_pain_score_data for il6_vs_pain_score.
        plan = codegen.plan_data(base, needed, context.frames, context.unit, target=codegen.temporary(result, "data"))
        adjust = f", adjusting for {site}" if site and site != column.label else ""
        code = None
        if plan:
            if plan.notes:
                note = plan.notes[0].replace(" first", "") + " first."
            lines = [codegen.comment(f"Is {column.label} associated with {outcome} in {cell.label}{adjust}?"), "import statsmodels.formula.api as smf", ""]
            lines += plan.lines
            lines.append(f"{result} = smf.ols({codegen.formula(outcome, needed)}, data={plan.name}).fit()")
            if plan.name != base:
                lines.append(f"del {plan.name}")
            lines.append(f"{result}.summary().tables[1]")
            code = "\n".join(lines)
        options.append(_option(f"Is {column.label} associated with {outcome} here{adjust}?", "association", 0.7, after, code, "Separate test next to this cell", column.name, cell.id, uses=uses))
    interaction = _interaction_option(column, cell, context)
    if interaction is not None:
        options.append(interaction)
    model = cell.model
    if model is not None and column.label not in model.formula:
        code = None
        data_frame = model.data if model.data in context.frames else None
        if data_frame:
            new_source = codegen.replace_string(cell.source, model.formula, f"{model.formula} + {codegen.term(column.label)}")
            if new_source and column.label not in context.frames[data_frame]:
                plan = codegen.plan_data(data_frame, [column.label], context.frames, context.unit, target=data_frame)
                if plan and len(plan.lines) == 2:
                    merged = plan.lines[1].split(" = ", 1)[1]
                    new_source = codegen.replace_keyword_value(new_source, model.function, "data", merged) or None
                else:
                    new_source = None
            code = new_source
        options.append(_option(f"Add {column.label} as a covariate", "model", 0.55, edit, code, f"Refits the model with {column.label}", column.name, cell.id))
    # The exposure of the model that the cell fits, else the column that splits the units.
    # The column alone named the smallest frame's: "Could sex mediate the effect of wt82
    # missing?" on the adjusted model of the demo's v2take11.
    fitted = codegen.fitted_models(cell.source)
    exposure = (codegen.formula_exposure(fitted[-1].call.formula) if fitted else None) or group_column(context)
    # Nothing causes a unit's id or the week of a visit (design iteration 1.75).
    timeless = not templates.is_unit(column, context) and not templates.is_time(column)
    if outcome and exposure and column.label not in (exposure, outcome) and timeless:
        options.append(_option(f"Could {column.label} mediate the effect of {exposure}?", "causal", 0.45, branch, None, "AI writes the branch", column.name, cell.id, uses=uses))
    if base and outcome and column.label != outcome:
        # A time index with repeated units draws the outcome over time: a line
        # per unit and the mean with its band, where a scatter of whole weeks
        # drew 1,428 visits as about 230 dots (design iteration 1.75).
        unit = context.unit if context.unit and context.unit in context.frames.get(base, {}) and context.unit != column.label else None
        trajectory = templates.is_time(column) and column.kind == "numeric" and unit is not None
        needed = [column.label] + ([unit] if trajectory and unit else [])
        # Another name than the association's frame: the two can run as branches at the same time.
        plan = codegen.plan_data(base, needed, context.frames, context.unit, target=codegen.temporary(column.label, "against", outcome, "data"))
        code = None
        text = f"Plot {outcome} over {column.label}, a line per {unit_noun(unit)}" if trajectory else f"Plot {column.label} against {outcome}"
        if plan:
            numeric = column.kind in ("numeric",)
            axes = f"x={codegen.literal(column.label)}, y={codegen.literal(outcome)}"
            if trajectory:
                plot = f"whybook.ribbon({plan.name}, {axes}, units={codegen.literal(unit or '')})"
            elif numeric:
                plot = f"whybook.scatter({plan.name}, {axes})"
            else:
                # One mean per unit when the level stays the same within each unit, as the F test counts them (design iteration 1.85).
                plot = f"whybook.bars({plan.name}, {axes}" + (f", unit={codegen.literal(unit)})" if unit else ")")
            lines = [codegen.comment(text if trajectory else f"{column.label} against {outcome}"), "import whybook", ""] + plan.lines + [plot]
            if plan.name != base:
                lines.append(f"del {plan.name}")
            code = "\n".join(lines)
        options.append(_option(text, "descriptive", 0.5, after, code, "Output shown under the new cell", column.name, cell.id, uses=uses))
    if split:
        # The bars of the levels pooled every time of day: the split shows the same means over time.
        return split + [option for option in options if not option.text.startswith("Plot ")], split_note or note
    return options, note


def _frame_onto_cell(frame: Variable, cell: CellInfo, context: Context) -> list[Candidate]:
    after = Placement("new", cell.id, f"new cell after {cell.label}")
    branch = Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel")
    base = primary_frame(cell, context)
    outcome = context.outcome_in(base)
    options = []
    if base and outcome and base != frame.name and frame.name in context.frames:
        keys = codegen.join_keys(context.frames[frame.name], context.frames.get(base, {}), context.unit)
        code = None
        if outcome in context.frames[frame.name]:
            # The frame holds the outcome itself: a join would add a second one.
            result = codegen.identifier(f"{frame.name}_hits")
            code = "\n".join(
                [
                    codegen.comment(f"Screen every column of {frame.name} against {outcome}"),
                    "import whybook",
                    "",
                    f"{result} = whybook.screen({frame.name}, {codegen.literal(outcome)})",
                    result,
                ]
            )
        elif keys:
            key = keys[0]
            result = codegen.identifier(f"{frame.name}_hits")
            code = "\n".join(
                [
                    codegen.comment(f"Screen every column of {frame.name} against {outcome} from {cell.label}"),
                    "import whybook",
                    "",
                    f"{result} = whybook.screen(",
                    f"    {frame.name},",
                    f"    {base}.groupby({codegen.literal(key)}, as_index=False)[{codegen.literal(outcome)}].mean(),",
                    f"    on={codegen.literal(key)},",
                    ")",
                    result,
                ]
            )
        options.append(_option(f"Screen every column of {frame.name} against this cell's outcome", "association", 0.65, after, code, "Ranked hits come back as a catalogue", frame.name, cell.id, uses={"outcome": outcome}))
    # A frame that shares a key with a frame that the cell loads or reads asks the two together:
    # how many visits per site (design iteration 1.87). Both are in the kernel, so the rows tell which has one row per key.
    if frame.name in context.frames:
        for other in starts.cell_frames(cell, context):
            link = starts.find_frame_link(frame.name, other, context) if other != frame.name else None
            if link is not None:
                options += starts.combined_options(link, [], lambda text, kind, prior, placement, code, effect: _option(text, kind, prior, placement, code, effect, frame.name, cell.id), after)
                break
    used = [name for name in cell.uses if name in context.frames and name != frame.name]
    if used:
        code = None
        # A cell that names no column of its input may read them in a function, as
        # to_long(diary_raw) does: then the frame needs every column of the input.
        needed = {column for f, column in cell.columns if f == used[0]} or set(context.frames[used[0]])
        if frame.name in context.frames and needed <= set(context.frames[frame.name]):
            # The cell reads frame.name where it read used[0], until it assigns a name of its own.
            defined = codegen.defined_names(cell.source)
            renamed = codegen.rename(cell.source, {name: f"{name}_{frame.name}" for name in defined}, inputs={used[0]: frame.name})
            if renamed is not None:
                code = f"{codegen.comment(f'Branch of {cell.label} with {frame.name} as its input instead of {used[0]}')}\n{renamed}"
        options.append(_option(f"Use {frame.name} as the input to {cell.label}", "model", 0.45, branch, code, f"Replaces {used[0]} in a branch", frame.name, cell.id))
        compare = "\n".join([codegen.comment(f"{frame.name} compared with {used[0]}, the input of {cell.label}"), "import whybook", "", f"whybook.compare_frames({frame.name}, {used[0]})"])
        options.append(_option(f"Compare {frame.name} with what {cell.label} used", "quality", 0.5, after, compare, "Rows and columns in one, not the other", frame.name, cell.id))
    return options


def _constant_onto_cell(constant: Variable, cell: CellInfo, context: Context) -> list[Candidate]:
    decision = next((d for d in cell.decisions if d.name == constant.label), None)
    options = []
    branch = Placement("branch", cell.id, f"branch of {cell.label} · runs in parallel")
    edit = Placement("edit", cell.id, f"edit {cell.label} in place")
    value = constant.value or (decision.value if decision else "")
    # The values follow the kind of the constant, as on its chip: MIN_DAYS takes common lengths of time.
    values = sweep_list(decision or Decision(constant.label, value, "literal"), cell.source) if value else []
    sweep = sweep_code(cell, decision, context, tried=values or None) if decision and decision.provenance == "defaulted" else None
    if sweep is None and constant.label in cell.uses and values:
        sweep = _loop_over(cell, Decision(constant.label, value, "literal"), values)
    options.append(_option(f"What changes if {constant.label} changes?", "model", 0.65, branch, sweep, f"Re-runs {cell.label} with {', '.join(values)}" if values else "Re-runs the cell with other values", constant.name, cell.id))
    if decision and decision.provenance == "defaulted" and decision.function and decision.param:
        explicit = codegen.add_keyword(cell.source, decision.function, decision.param, constant.label)
        where = f"{decision.source_file}:{decision.source_line}" if decision.source_file else "its module"
        code = f"{constant.label} = {decision.value}  {codegen.comment(f'chosen here; was the default in {where}')}\n{explicit}" if explicit else None
        options.append(_option(f"Make {constant.label} an explicit choice in this cell", "model", 0.55, edit, code, f"Moves it out of {decision.source_file or 'the module'} into a decision chip", constant.name, cell.id))
    return options


def _loop_over(cell: CellInfo, decision: Decision, values: list[str]) -> str | None:
    """A branch that re-runs the cell once for each value of a constant it uses.

    The names of the loop are made from the constant, such as ``_alpha_value``,
    and so are the names the cell defines inside the loop, such as
    ``_significant_at_alpha``: branches run at the same time in one namespace.
    """
    index, value = codegen.temporary(decision.name, "index"), codegen.temporary(decision.name, "value")
    # Each round reads the value it tries, and what the cell starts from, under the names of the cell.
    body = codegen.rename(cell.source, sweep_names(cell.source, decision.name), inputs={decision.name: value})
    if body is None:
        return None
    result = codegen.identifier(f"{decision.name}_sweep")
    tried = codegen.identifier(f"{decision.name}_values")
    return "\n".join(
        [
            codegen.comment(f"What changes if {decision.name} changes? Re-runs {cell.label} with {', '.join(values)}."),
            "import whybook",
            "",
            f"{result} = {{}}",
            f"{tried} = [{', '.join(values)}]",
            f"for {index}, {value} in enumerate({tried}):",
            f'    whybook.progress({index} / len({tried}), f"{decision.name} = {{{value}}}")',
            codegen.indent(body.rstrip()),
            'whybook.progress(1.0, "done")',
        ]
    )


def _onto_cell(request: DropRequest) -> tuple[list[Candidate], str | None]:
    source, cell, context = request.source, request.target_cell, request.context
    assert cell is not None
    if source.kind in FRAME_KINDS:
        return _frame_onto_cell(source, cell, context), None
    if source.kind == "constant":
        return _constant_onto_cell(source, cell, context), None
    if source.kind == "model":
        after = Placement("new", cell.id, f"new cell after {cell.label}")
        return [
            _option(f"Compare {source.label} with the model in {cell.label}", "model", 0.55, after, None, "Side-by-side estimates", source.name, cell.id),
            _option(f"Does this cell explain what {source.label} leaves unexplained?", "association", 0.45, after, None, "Screens against the residuals", source.name, cell.id),
        ], None
    if source.kind in COLUMN_KINDS:
        return _column_onto_cell(source, cell, context)
    after = Placement("new", cell.id, f"new cell after {cell.label}")
    return [_option(f"Use {source.label} in {cell.label}", "descriptive", 0.4, after, None, "AI writes the cell", source.name, cell.id)], None


# Drops onto another item, or onto itself.


def _cells_involving(request: DropRequest, *items: Variable) -> list[CellInfo]:
    return [
        cell
        for cell in request.cells
        if all(cell.involves(item.parent or item.name, item.label if item.parent else None) for item in items)
    ]


def _placements(request: DropRequest, items: list[Variable], self_drop: bool) -> list[Placement]:
    cells = request.cells
    last = cells[-1] if cells else None
    if self_drop:
        placements = [Placement("preview", None, "a preview in the sidebar", "Nothing is written to the notebook unless you keep it", 0.91)]
        if last:
            placements.append(Placement("new", last.id, "a new cell at the end", "Data checks go with the analysis", 0.06))
        return placements
    models = [item for item in items if item.kind == "model"]
    if models:
        home = next((cell for cell in cells if models[0].name in cell.defs), None)
        if home:
            return [
                Placement("branch", home.id, f"a branch of {home.label}", f"It reuses {models[0].label}, so it belongs next to it", 0.84),
                Placement("new", home.id, f"a new cell after {home.label}", "Alternative", 0.12),
            ]
    together = _cells_involving(request, *items)
    if together:
        home = together[-1]
        section = f" in {home.section}" if home.section else ""
        return [
            Placement("new", home.id, f"a new cell{section}, after {home.label}", f"{home.label} already has them in shape", 0.79),
            Placement("edit", home.id, f"extending {home.label} in place", "Alternative", 0.15),
        ]
    either = [cell for cell in cells if any(cell.involves(i.parent or i.name, i.label if i.parent else None) for i in items)]
    home = either[-1] if either else last
    if home is None:
        return [Placement("new", None, "a new cell at the end", "The notebook has no cells yet", 0.9)]
    section = f" in {home.section}" if home.section else ""
    return [
        Placement("new", home.id, f"a new cell{section}, after {home.label}", "It is the last cell that uses one of them", 0.66),
        Placement("new", last.id if last else None, "a new cell at the end", "Alternative", 0.24),
    ]


# A unit's id, a column of dates and a time index (design iteration 1.75).
# Before, they got the questions of any column: "Does week influence
# analgesic_dose_mg, or the other way round?", "Does kwh differ between the
# levels of timestamp?" over 672 levels, and a describe() of 318 patients.


def _plan_for(other: Variable, needed: list[str], context: Context, *words: str) -> codegen.DataPlan | None:
    """The frame of ``other`` with the columns in ``needed``, joined first when another frame holds them."""
    if not other.parent:
        return None
    return codegen.plan_data(other.parent, needed, context.frames, context.unit, target=codegen.temporary(*words, "data"), library=other.library)


def _helper_code(text: str, plan: codegen.DataPlan, call: str, library: str | None) -> str:
    """The code of an option that one helper of the whybook package answers, after the lines that build its frame."""
    imports = (["import polars as pl"] if library == "polars" and plan.lines else []) + ["import whybook"]
    return "\n".join([codegen.comment(text), *imports, "", *plan.lines, call])


def _unit_options(request: DropRequest, unit: Variable, other: Variable, home: Placement) -> list[Candidate]:
    """A unit's id with another column: how much of a number lies between the units, or how many units each level of a category holds."""
    context = request.context
    noun = unit_noun(unit.label)
    options = []
    if other.kind == "numeric" and not templates.is_time(other):
        text = f"How much of the variation in {other.label} lies between {noun}s?"
        plan = _plan_for(other, [unit.label], context, other.label, "by", unit.label)
        code = None
        if plan:
            code = _helper_code(text, plan, f"whybook.icc({plan.name}, {codegen.literal(other.label)}, {codegen.literal(unit.label)})", other.library)
        options.append(_option(text, "association", 0.75, home, code, "The share between them, the ICC, in words", unit.name, other.name))
    elif other.kind in ("categorical", "binary") and not templates.is_unit(other, context):
        text = f"How many {noun}s does each level of {other.label} hold?"
        plan = _plan_for(other, [unit.label], context, unit.label, "per", other.label)
        code = None
        if plan and other.library != "polars":
            code = "\n".join(
                [
                    codegen.comment(text),
                    *plan.lines,
                    f"{plan.name}.groupby({codegen.literal(other.label)}, observed=True)[{codegen.literal(unit.label)}].nunique().rename({codegen.literal(f'{noun}s')}).to_frame()",
                ]
            )
        options.append(_option(text, "descriptive", 0.6, home, code, f"Distinct {noun}s per level", unit.name, other.name))
    return options


# A time of day in the text of a date: 2025-10-12 23:30:00 or 2025-10-12T23:30.
CLOCK = re.compile(r"[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?")


def _time_of_day(time: Variable) -> bool | None:
    """Whether a column of dates holds times of day, as its first and last values show; None when the listing gives neither.

    A column whose first and last times both fall at midnight counts as
    whole days, though it can hold hours between them.
    """
    stamps = [value for value in (time.minimum, time.maximum) if isinstance(value, str)]
    if not stamps:
        return None
    return any(any(int(part or 0) for part in match.groups()) for match in (CLOCK.search(stamp) for stamp in stamps) if match)


def _one_per_unit(column: Variable, context: Context) -> bool:
    """Whether a column gives one value to each unit, such as the day a home switched tariff.

    It comes from the frame of the units: the smallest frame with the unit,
    with at most a fifth of the rows of the largest, as homes has 360 rows
    beside 129,058 daily readings. The column's frame is that frame, or
    holds all of its columns, as the readings joined with homes do. The
    profile by hour of day was offered for tou_start against the daily
    readings (design iteration 1.85).
    """
    units = context.unit_frame()
    columns = context.frames.get(units or "", {})
    if not units or column.label not in columns:
        return False
    if column.parent != units and not set(columns) <= set(context.frames.get(column.parent or "", {})):
        return False
    rows = context.frame_rows.get(units)
    largest = max((context.frame_rows.get(name, 0) for name, held in context.frames.items() if context.unit in held), default=0)
    return rows is not None and 5 * rows <= largest


def _date_options(request: DropRequest, time: Variable, other: Variable, home: Placement) -> list[Candidate]:
    """A column of dates with a number: the profile of the number by time of day, weekday and month.

    Only for several dates per unit: a date that each unit has once, such as
    the day a home switched tariff, has no weekdays or hours to profile. A
    column with times of day gets the profile by hour of day and weekday,
    and whole days by weekday and month (design iteration 1.85).
    """
    if other.kind != "numeric" or _one_per_unit(time, request.context):
        return []
    timed = _time_of_day(time)
    if timed is None:
        # Without its first and last values, the name says which it is, and the helper checks.
        timed = not re.search(r"(^|_)(date|day)$", time.label.lower())
    text = f"How does {other.label} vary by hour of day and by weekday?" if timed else f"How does {other.label} vary by weekday and by month?"
    plan = _plan_for(other, [time.label], request.context, other.label, "by", time.label)
    code = None
    if plan:
        code = _helper_code(text, plan, f"whybook.time_profile({plan.name}, {codegen.literal(time.label)}, {codegen.literal(other.label)})", other.library)
    return [_option(text, "association", 0.75, home, code, "The mean with a 95% band at each time", time.name, other.name)]


def _trajectory(request: DropRequest, time: Variable, other: Variable, unit: str | None, home: Placement) -> Candidate:
    """A number over a time index: a line per unit, and the mean at each time with its 95% band."""
    noun = unit_noun(unit)
    text = f"How does {other.label} change over {time.label}, per {noun}?" if unit else f"How does {other.label} change over {time.label}?"
    plan = _plan_for(other, [time.label] + ([unit] if unit else []), request.context, other.label, "over", time.label)
    code = None
    if plan:
        units = f", units={codegen.literal(unit)}" if unit else ""
        call = f"whybook.ribbon({plan.name}, x={codegen.literal(time.label)}, y={codegen.literal(other.label)}{units})"
        code = _helper_code(text, plan, call, other.library)
    effect = f"A line per {noun}, and the mean with a 95% band" if unit else "The mean with a 95% band at each time"
    return _option(text, "descriptive", 0.75, home, code, effect, time.name, other.name, uses={"unit": unit} if unit else None)


def _rows_per_unit(unit: str, frame: str, home: Placement, *parts: str) -> Candidate:
    """How many rows each unit has in a frame, the fewest first: a group-by count."""
    text = f"How many rows does each {unit_noun(unit)} have in {frame}?"
    code = "\n".join([codegen.comment(text), "import whybook", "", f"whybook.rows_per_unit({frame}, {codegen.literal(unit)})"])
    return _option(text, "descriptive", 0.5, home, code, "A count per unit, the fewest first", *parts)


def _pair_options(request: DropRequest, a: Variable, b: Variable, home: Placement) -> tuple[list[Candidate], str | None]:
    context = request.context
    options = []
    note = None
    # Catalogue templates that an option below answers with code.
    answered: set[str] = set()
    if a.kind in COLUMN_KINDS and b.kind in COLUMN_KINDS:
        base = a.parent
        polars = a.library == "polars"
        # The unit counts when the frame of the columns holds it: a table of
        # weather by day and region has no homes to be within or between.
        unit_here = context.unit if context.unit and context.unit in context.frames.get(base or "", {}) else None
        # A unit's id and a time index are no causes, and their values are no
        # levels to compare (design iteration 1.75): each gets questions of its own.
        unit_column = next((v for v in (a, b) if templates.is_unit(v, context)), None)
        time = None if unit_column else next((v for v in (a, b) if v.kind == "datetime"), None) or next((v for v in (a, b) if templates.is_time(v)), None)
        special = unit_column or time
        other = (b if special is a else a) if special else None
        if unit_column is not None and other is not None:
            options += _unit_options(request, unit_column, other, home)
            answered |= {"group_difference", "independence"}
        elif time is not None and other is not None and time.kind == "datetime":
            options += _date_options(request, time, other, home)
            # The profile by time of day, weekday and month shows the cycles.
            answered |= {"seasonality"}
        else:
            # The frame with b joined to a's, such as _sleep_and_age_data.
            joined = codegen.temporary(a.label, "and", b.label, "data")
            plan = codegen.plan_data(base, [b.label] + ([unit_here] if unit_here else []), context.frames, context.unit, target=joined, library=a.library) if base else None
            code = None
            # A correlation needs two numbers; a category is compared by its
            # levels: the numbers of each level, or a table of the two.
            numbers = [v for v in (a, b) if v.kind == "numeric"]
            both = len(numbers) == 2
            unit = f", within or between {unit_noun(unit_here)}s" if unit_here and both else ""
            # The catalogue's own questions for a category, answered here with code.
            if both:
                text = f"Are {a.label} and {b.label} associated{unit}?"
            elif numbers:
                number = numbers[0]
                level = b if number is a else a
                text = f"Does {number.label} differ between the levels of {level.label}?"
                answered.add("group_difference")
            else:
                text = f"Are {a.label} and {b.label} independent?"
                answered.add("independence")
            # The levels of a category are compared by unit means, and two
            # categories counted once per unit, when they stay the same within
            # each unit: the tariff and the car of a home (design iteration 1.85).
            per_unit = unit_here if not both and unit_here not in (a.label, b.label) else None
            if plan:
                if plan.notes:
                    note = plan.notes[0] + "."
                first, second = codegen.literal(a.label), codegen.literal(b.label)
                if both and unit_here:
                    call = f"whybook.within_between({plan.name}, {first}, {second}, group={codegen.literal(unit_here)})"
                elif both and polars:
                    # One coefficient, from the rows where both are present, as pandas' corr() does.
                    call = f"{plan.name}.select(pl.corr({first}, {second}))"
                elif both:
                    call = f"{plan.name}[[{first}, {second}]].corr()"
                elif numbers:
                    # One line with the result first, and a row per level: a describe() of 318 rows answered no question.
                    by_unit = f", unit={codegen.literal(per_unit)}" if per_unit else ""
                    call = f"whybook.compare_levels({plan.name}, {codegen.literal(number.label)}, {codegen.literal(level.label)}{by_unit})"
                else:
                    # Counts and shares with a chi-square test, where a table of shares counted home-days and gave no test.
                    by_unit = f", unit={codegen.literal(per_unit)}" if per_unit else ""
                    call = f"whybook.cross_table({plan.name}, {first}, {second}{by_unit})"
                if both:
                    imports = (["import polars as pl"] if polars and (plan.lines or not unit_here) else []) + (["import whybook"] if unit_here or not polars else [])
                else:
                    imports = (["import polars as pl"] if polars and plan.lines else []) + ["import whybook"]
                lines = [codegen.comment(text), *imports, ""] + plan.lines + [call]
                code = "\n".join(line for i, line in enumerate(lines) if line or i != 1)
            uses = {"unit": unit_here} if unit or per_unit else None
            options.append(_option(text, "association", 0.7, home, code, "Question · joins frames if needed", a.name, b.name, uses=uses))
            if time is not None and other is not None and other.kind == "numeric":
                options.append(_trajectory(request, time, other, unit_here, home))
                answered.add("trend")
        if special is None:
            options.append(_option(f"What else could explain both {a.label} and {b.label}?", "causal", 0.5, home, None, "Scans unexplored variables for common causes", a.name, b.name))
        else:
            # How many rows each unit has: a group-by count, which the model was asked for.
            # Not for a date that each unit has once, such as tou_start: the
            # rows of each home are no question about the day it switched.
            counted = unit_column.label if unit_column else unit_here
            frame = unit_column.parent if unit_column else base
            once = time is not None and time.kind == "datetime" and _one_per_unit(time, context)
            if counted and frame and not once:
                options.append(_rows_per_unit(counted, frame, home, a.name, b.name))
    elif a.kind in FRAME_KINDS and b.kind in FRAME_KINDS:
        line_up = "\n".join([codegen.comment(f"How do {a.name} and {b.name} line up?"), "import whybook", "", f"whybook.line_up({a.name}, {b.name})"])
        options.append(_option(f"How do {a.name} and {b.name} line up?", "quality", 0.7, home, line_up, "Keys, overlap, rows that do not match", a.name, b.name))
        keys = codegen.join_keys(context.frames.get(a.name, {}), context.frames.get(b.name, {}), context.unit)
        if keys:
            result = codegen.identifier(f"{a.name}_{b.name}")
            on = codegen.literals(keys)
            joined = f"{a.name}.join({b.name}, on={on}, how=\"left\")" if a.library == "polars" else f"{a.name}.merge({b.name}, on={on}, how=\"left\")"
            join = "\n".join([codegen.comment(f"{a.name} joined with {b.name} on {', '.join(keys)}"), f"{result} = {joined}", f"{result}.head()"])
            options.append(_option(f"Join {a.name} and {b.name}", "quality", 0.6, home, join, f"Left join on {', '.join(keys)}", a.name, b.name))
        else:
            note = _mismatch_note(a.name, b.name, context)
        options.append(_option("Which columns of one predict the other?", "association", 0.45, home, None, "Wide screen · catalogue of hits", a.name, b.name))
    elif "model" in (a.kind, b.kind):
        model, other = (a, b) if a.kind == "model" else (b, a)
        options.append(_option(f"Does {other.label} explain what {model.label} leaves unexplained?", "association", 0.6, home, None, "Screens against the residuals", a.name, b.name))
        options.append(_option(f"Refit {model.label} on {other.label}", "model", 0.5, Placement("branch", home.cell, home.label.replace("a new cell", "a branch")), None, "A branch that runs in parallel; the original stays", a.name, b.name))
    elif {a.kind, b.kind} & set(FRAME_KINDS) and {a.kind, b.kind} & set(COLUMN_KINDS):
        frame, column = (a, b) if a.kind in FRAME_KINDS else (b, a)
        keys = codegen.join_keys(context.frames.get(frame.name, {}), context.frames.get(column.parent or "", {}), context.unit)
        if not keys and column.parent:
            note = _mismatch_note(frame.name, column.parent, context)
        code = None
        if column.parent and keys:
            result = codegen.identifier(f"{frame.name}_vs_{column.label}")
            code = "\n".join(
                [
                    codegen.comment(f"Which columns of {frame.name} are related to {column.label}?"),
                    "import whybook",
                    "",
                    f"{result} = whybook.screen(",
                    f"    {frame.name},",
                    f"    {column.parent}.groupby({codegen.literal(keys[0])}, as_index=False)[{codegen.literal(column.label)}].mean(),",
                    f"    on={codegen.literal(keys[0])},",
                    ")",
                    result,
                ]
            )
        options.append(_option(f"Which columns of {frame.name} are related to {column.label}?", "association", 0.6, home, code, "Wide screen · catalogue of hits", a.name, b.name))
    # The general question catalogue adds questions that need an AI model to answer,
    # except the ones an option above already answers offline.
    selection = Selection(a, b)
    known = {option.text for option in options}
    covered = {"association", "confounding", "join_keys", "related_columns", "predict_from_frame", *answered}
    for candidate in templates.generate(selection, context):
        if candidate.text not in known and candidate.template not in covered:
            candidate.placement = home
            candidate.effect = "AI writes the cell"
            options.append(candidate)
    return options, note


def _mismatch_note(first: str, second: str, context: Context) -> str | None:
    """Why two frames have no key to join on, when a column that they share holds two kinds of values."""
    columns, other = context.frames.get(first, {}), context.frames.get(second, {})
    mismatched = codegen.mismatched_keys(columns, other, context.unit)
    if not mismatched:
        return None
    key = mismatched[0]
    return (
        f"{key} holds {codegen.KEY_KINDS[columns[key]]} in {first} and {codegen.KEY_KINDS[other[key]]} in {second}: "
        f"a join on it matches no row until both hold the same kind."
    )


def _self_options(request: DropRequest, item: Variable, home: Placement) -> list[Candidate]:
    context = request.context
    preview = Placement("preview", None, "a preview in the sidebar", "Nothing is written to the notebook unless you keep it")
    options = []
    if item.kind in FRAME_KINDS:
        options.append(_option(f"Profile {item.name}: types, missingness, duplicates", "quality", 0.7, preview, f"import whybook\n\nwhybook.profile({item.name})", f"Quick look · {starts.UNLESS_KEPT}", item.name))
        columns = context.frames.get(item.name, {})
        long = reshape.plan(columns, context.unit, columns) if item.library != "polars" else None
        if long:
            # pain_1 to pain_7 reshaped by a template, where only a model could (design iteration 1.85).
            name = reshape.name_for(item.name, context.frames)
            code = "\n".join([codegen.comment(reshape.text(item.name, long)), "import pandas as pd", "", *reshape.lines(item.name, name, long)])
            options.append(_option(reshape.text(item.name, long), "descriptive", 0.75, home, code, reshape.effect(long), item.name))
        else:
            unit = f"one row per {unit_noun(context.unit)}" if context.unit else "aggregated"
            options.append(_option(f"Reshape {item.name}: wide or long, or {unit}", "descriptive", 0.45, home, None, "AI proposes shapes that later questions need", item.name, uses={"unit": context.unit} if context.unit else None))
    elif item.kind in COLUMN_KINDS and item.parent:
        column = codegen.literal(item.label)
        if templates.is_unit(item, context):
            # The rows of each unit, the fewest first: one bar per home in the
            # order of the ids hid the homes with gaps (design iteration 1.75).
            text = f"Summarise {item.label}: rows per {unit_noun(item.label)}"
            code = f"import whybook\n\nwhybook.rows_per_unit({item.parent}, {column})"
        else:
            # The numbers under the plot: count, missing, quartiles and the extremes.
            plot = {"numeric": "hist", "datetime": "hist", "categorical": "bars", "binary": "bars"}.get(item.kind)
            text = f"Summarise {item.label}: distribution and missingness"
            code = "\n".join(["import whybook", "", *([f"whybook.{plot}({item.parent}, {column})"] if plot else []), f"whybook.summary({item.parent}, {column})"])
        options.append(_option(text, "descriptive", 0.7, preview, code, f"Quick look · {starts.UNLESS_KEPT}", item.name))
        # No "Transform: log, standardise or bin": the catalogue asks once
        # whether a number needs a transform, and never of an id or a time.
        site = site_column(context, item.parent)
        if site and site != item.label and not templates.is_unit(item, context):
            joined = codegen.temporary(item.label, "by", site, "data")
            plan = codegen.plan_data(item.parent, [site], context.frames, context.unit, target=joined, library=item.library)
            if plan:
                imports = ["import polars as pl"] if item.library == "polars" and plan.lines else []
                by_group = f"whybook.by_group({plan.name}, {codegen.literal(item.label)}, {codegen.literal(site)})"
                code = "\n".join([codegen.comment(f"Is {item.label} measured consistently across {site}s?"), *imports, "import whybook", ""] + plan.lines + [by_group])
                options.append(_option(f"Is {item.label} measured consistently across {site}s?", "quality", 0.55, home, code, "Summary per level · ~3 s", item.name))
    elif item.kind == "constant":
        options.append(_option(f"Where does {item.label} come from, and what uses it?", "model", 0.6, preview, None, "Shown in Contents", item.name))
    known = {option.text for option in options}
    # The summary of a column of dates gives its first and last dates and its longest gap.
    covered = {"frame_missing", "duplicates", "distribution", "missing_values", "level_counts", "time_coverage"}
    for candidate in templates.generate(Selection(item, item), context):
        if candidate.text not in known and candidate.template not in covered:
            candidate.placement = home
            candidate.effect = "AI writes the cell"
            options.append(candidate)
    return options


def drop_options(request: DropRequest) -> dict[str, Any]:
    source, context = request.source, request.context
    placements: list[Placement] = []
    note = None
    if request.target_cell is not None:
        cell = request.target_cell
        options, note = _onto_cell(request)
        title = f"{source.label} onto {cell.label}"
        involved = [source]
    else:
        target = request.target_item
        assert target is not None
        self_drop = target.name == source.name
        placements = _placements(request, [source] if self_drop else [source, target], self_drop)
        home = next((p for p in placements if p.kind != "preview"), placements[0])
        if self_drop:
            options = _self_options(request, source, home)
            title = f"{source.label} (itself)"
        else:
            options, note = _pair_options(request, source, target, placements[0])
            title = f"{source.label} + {target.label}" if source.kind == target.kind else f"{source.label} → {target.label}"
        involved = [source] if self_drop else [source, target]
    for option in options:
        score_candidate(option, involved, context)
        if option.code is None and not option.effect.startswith("AI "):
            option.reasons.append("needs AI")
    options.sort(key=lambda option: option.probability or 0.0, reverse=True)
    if request.target_cell is None:
        # The learned ranker orders the types; the rules keep their order within a type.
        # Drops onto a cell keep the rules' order: the notebooks gave no such drops to learn from.
        options = learned_order(options, kind_group(involved), context, len(request.cells))
    if request.branch:
        for option in options:
            if option.placement and option.placement.kind in ("new", "edit"):
                option.placement = Placement("branch", option.placement.cell, option.placement.label.replace("new cell after", "branch of").replace("edit ", "branch of ").replace(" in place", "") + " · runs in parallel")
    mode = "parallel" if request.parallel else ("branch" if request.branch else "auto")
    return {
        "title": title,
        "note": note,
        "mode": mode,
        "options": [option.to_json() for option in options[:8]],
        "placements": [placement.to_json() for placement in placements],
        "preselected": [option.id for option in options[:3]] if request.parallel else [],
    }
