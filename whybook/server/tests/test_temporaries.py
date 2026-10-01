"""Template code names what it makes for its own use after what its option asks about.

Branches run at the same time in subshells of one kernel, and share one
namespace. In the pain diary demo, the association and the plot of IL6 dropped
on the mixed model both assigned and deleted ``_data``: the plot branch failed
with a NameError after the association branch deleted it (research/critique/app.md,
item 1). So each temporary says what it holds, and no two options of one
request share one.
"""

import ast
import itertools

import pytest

from whybook.server.questions.cells import CellInfo, Decision, cell_questions, dropped_code, next_steps, random_slope_code, sweep_code
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Context
from whybook.server.tests.test_demo_templates import drops

CONTEXT_JSON = {
    "outcome": "pain",
    "unit": "patient_id",
    "frames": {
        "patients": {"rows": 20, "columns": {"patient_id": "id", "arm": "cat", "site": "cat", "age": "num", "bmi": "num"}},
        "diary": {"rows": 400, "columns": {"patient_id": "id", "week": "int", "pain": "num", "sleep": "num"}},
        "weekly": {"rows": 100, "columns": {"patient_id": "id", "week": "int", "pain": "num"}},
    },
    "used": ["week"],
}
CONTEXT = Context.from_json(CONTEXT_JSON)
WEEKLY = CellInfo("c4", "[4]", "weekly = weekly_means(diary)\nweekly.head()", uses=("diary", "weekly_means"))


def names(code: str, use: type) -> set[str]:
    """The names that ``code`` stores (``ast.Store``) or deletes (``ast.Del``)."""
    return {node.id for node in ast.walk(ast.parse(code)) if isinstance(node, ast.Name) and isinstance(node.ctx, use)}


def deleted(code: str) -> set[str]:
    return names(code, ast.Del)


def temporaries(code: str) -> set[str]:
    """The names code makes for its own use: those it deletes, and those it assigns that start with an underscore."""
    return deleted(code) | {name for name in names(code, ast.Store) if name.startswith("_")}


def assert_no_temporary_twice(options: list[tuple[str, str]]) -> None:
    """``options`` are (text, code) pairs of one request."""
    owners: dict[str, str] = {}
    for text, code in options:
        for name in temporaries(code):
            assert name not in owners, f"{name} is a temporary of {owners[name]!r} and of {text!r}"
            owners[name] = text


def coded(result: dict) -> list[tuple[str, str]]:
    """The (text, code) pairs of the options that run offline."""
    return [(option["text"], option["code"]) for option in result["options"] if option["code"]]


def statements(code: str) -> list:
    """Each top-level statement of ``code``, compiled on its own."""
    return [compile(ast.Module(body=[node], type_ignores=[]), "<template>", "exec") for node in ast.parse(code).body]


def test_two_sweeps_of_one_cell_name_their_temporaries_after_their_decision():
    days = sweep_code(WEEKLY, Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="weekly_means"), CONTEXT)
    gap = sweep_code(WEEKLY, Decision("MAX_GAP", "3", "defaulted", param="max_gap", function="weekly_means"), CONTEXT)
    assert temporaries(days) == {"_min_days_sweep_rows", "min_days_values", "_min_days_index", "_min_days_value", "_weekly_at_min_days"}
    assert "_weekly_at_min_days = weekly_means(diary, min_days=_min_days_value)" in days
    # The two can run as branches at the same time, and each deletes its own names at its end.
    assert not temporaries(days) & temporaries(gap)
    assert deleted(days) == temporaries(days)


def test_the_random_slope_test_names_its_two_fits_and_their_ratio():
    model = CellInfo(
        "c5", "[5]", 'fit = smf.mixedlm("pain ~ week", data=weekly, groups="patient_id", re_formula="~week").fit()', formulas=("pain ~ week",)
    )
    code = random_slope_code(model)
    assert temporaries(code) == {"_random_slope_fit", "_random_intercept_fit", "_random_slope_lr"}
    assert deleted(code) == temporaries(code)


def test_the_checks_of_two_filters_name_what_each_keeps_and_removes():
    cell = CellInfo("c3", "[3]", "kept = diary.pipe(drop_sparse).pipe(drop_short)", uses=("diary", "drop_sparse", "drop_short"))
    sparse, _ = dropped_code(cell, Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="drop_sparse"), CONTEXT)
    short, _ = dropped_code(cell, Decision("MIN_WEEKS", "4", "defaulted", param="min_weeks", function="drop_short"), CONTEXT)
    assert temporaries(sparse) == {"_diary_kept_by_drop_sparse", "_patients_removed_by_drop_sparse"}
    assert not temporaries(sparse) & temporaries(short)
    assert deleted(sparse) == temporaries(sparse)


def test_each_association_worth_asking_next_joins_its_own_frame():
    steps = {step.text: step.code for step in next_steps([WEEKLY], CONTEXT, {}, set())}
    age, bmi = steps["How does age relate to pain?"], steps["How does bmi relate to pain?"]
    assert temporaries(age) == {"_age_vs_pain_data"}
    assert "age_vs_pain = smf.ols(\"pain ~ age\", data=_age_vs_pain_data).fit()" in age
    assert not temporaries(age) & temporaries(bmi)
    assert deleted(age) == temporaries(age)


def test_a_loop_over_a_constant_names_its_value_after_the_constant():
    cell = {"id": "c6", "label": "[6]", "source": "significant = results[results.p < ALPHA]\nlen(significant)", "uses": ["results", "ALPHA"]}
    constant = {"name": "ALPHA", "label": "ALPHA", "kind": "constant", "value": "0.05"}
    result = drop_options(DropRequest.from_json({"source": constant, "target": {"cell": cell}, "cells": [cell], "context": {}}))
    loop = dict(coded(result))["What changes if ALPHA changes?"]
    assert temporaries(loop) == {"_alpha_index", "_alpha_value", "_significant_at_alpha"}
    assert "    _significant_at_alpha = results[results.p < _alpha_value]" in loop


def test_the_options_of_one_drop_onto_a_cell_join_their_frames_under_names_of_their_own():
    cell = {
        "id": "c7",
        "label": "[7]",
        "source": 'fit = smf.ols("pain ~ week", data=weekly).fit()',
        "defs": ["fit"],
        "uses": ["smf", "weekly"],
        "formulas": ["pain ~ week"],
    }
    bmi = {"name": "patients['bmi']", "label": "bmi", "kind": "numeric", "parent": "patients"}
    body = {"source": bmi, "target": {"cell": cell}, "cells": [cell], "context": CONTEXT_JSON, "modifiers": {"parallel": True}}
    options = coded(drop_options(DropRequest.from_json(body)))
    code = dict(options)
    assert temporaries(code["Is bmi associated with pain here, adjusting for site?"]) == {"_bmi_vs_pain_data"}
    assert temporaries(code["Plot bmi against pain"]) == {"_bmi_against_pain_data"}
    assert_no_temporary_twice(options)


def test_a_pair_and_a_check_of_one_column_join_their_frames_under_the_words_of_their_question():
    sleep = {"name": "diary['sleep']", "label": "sleep", "kind": "numeric", "parent": "diary"}
    age = {"name": "patients['age']", "label": "age", "kind": "numeric", "parent": "patients"}
    pain = {"name": "diary['pain']", "label": "pain", "kind": "numeric", "parent": "diary"}

    def options(source, target):
        return dict(coded(drop_options(DropRequest.from_json({"source": source, "target": {"item": target}, "cells": [], "context": CONTEXT_JSON}))))

    pair = options(sleep, age)["Are sleep and age associated, within or between patients?"]
    assert temporaries(pair) == {"_sleep_and_age_data"}
    check = options(pain, pain)["Is pain measured consistently across sites?"]
    assert temporaries(check) == {"_pain_by_site_data"}


# The demo notebook: the drops, cell selections and next steps of the demo's tests.


@pytest.mark.demo
@pytest.mark.parametrize(
    "case",
    [
        "column onto a model cell",
        "column onto a plot cell",
        "wide frame onto a cell",
        "constant onto a cell",
        "column onto column",
        "frame onto frame",
        "frame onto itself",
        "column onto itself",
    ],
)
def test_the_options_of_one_demo_drop_share_no_temporary(demo, case):
    source, target = drops(demo)[case]
    # Alt+drop offers the options as branches to start together.
    body = {"source": source, "target": target, "cells": demo.cells_json(), "context": demo.context(), "modifiers": {"parallel": True}}
    assert_no_temporary_twice(coded(drop_options(DropRequest.from_json(body))))


@pytest.mark.demo
def test_the_questions_of_demo_cells_and_the_next_steps_share_no_temporary(demo):
    context = Context.from_json(demo.context())
    for cell_ids in (["weekly"], ["lmm"], ["lmm", "ordinal"], ["weekly", "lmm"]):
        cells = [CellInfo.from_json({**demo.cell(i), "branch_of": "lmm" if i == "ordinal" else None}) for i in cell_ids]
        assert_no_temporary_twice([(q.text, q.code) for q in cell_questions(cells, context) if q.code])
    cells = [CellInfo.from_json(c) for c in demo.cells_json()]
    olink = demo.variable("olink")
    groups = {"olink": [{"label": g["label"], "total": len(g["columns"]), "used": 0} for g in olink["groups"]]}
    # A column in two frames, such as notes, gives the same step twice, with one id.
    steps = {step.id: step for step in next_steps(cells, context, groups, set())}
    assert_no_temporary_twice([(step.text, step.code) for step in steps.values() if step.code])


@pytest.mark.demo
def test_two_demo_branches_that_run_one_statement_each_in_turn_both_finish(demo):
    """The critique's steps: IL6 onto the mixed model with Alt, the association and the plot started together.

    Subshells are threads of one kernel that share its namespace, so one
    statement of each branch in turn is an order that can happen. With
    ``_data`` in both, the association fitted on the frame to which the plot
    had joined IL6 a second time. That frame has IL6_x and IL6_y and no IL6,
    so patsy raised a NameError.
    """
    body = {"source": demo.column("olink", "IL6"), "target": {"cell": demo.cell("lmm")}, "cells": demo.cells_json(), "context": demo.context(), "modifiers": {"parallel": True}}
    code = dict(coded(drop_options(DropRequest.from_json(body))))
    association = code["Is IL6 associated with pain_score here, adjusting for site?"]
    plot = code["Plot IL6 against pain_score"]
    ns = demo.shell.user_ns
    failure = None
    try:
        for pair in itertools.zip_longest(statements(association), statements(plot)):
            for statement in pair:
                if statement is not None:
                    exec(statement, ns)
    except Exception as error:  # noqa: BLE001
        # Kept as text: Python 3.12 cannot format the traceback of a NameError raised in a patsy formula.
        failure = f"{type(error).__name__}: {error}"
    try:
        assert failure is None, failure
        assert "IL6" in ns["il6_vs_pain_score"].params
        assert not (temporaries(association) | temporaries(plot)) & set(ns)
    finally:
        for name in temporaries(association) | temporaries(plot) | {"il6_vs_pain_score"}:
            ns.pop(name, None)
