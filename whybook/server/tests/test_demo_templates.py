"""Every offline code template runs on the demo notebook's state.

The templates are the offline tier: an option with code runs at once, with
no model. A template that produces broken code would only show when a user
picks the option, so each one is run here.
"""

import pytest

from whybook.server.questions.cells import CellInfo, cell_questions, next_steps
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Context

pytestmark = pytest.mark.demo


def drops(demo):
    return {
        "column onto a model cell": (demo.column("olink", "IL6"), {"cell": demo.cell("lmm")}),
        "column onto a plot cell": (demo.column("diary", "sleep_hours"), {"cell": demo.cell("weekly")}),
        "wide frame onto a cell": (demo.variable("olink"), {"cell": demo.cell("lmm")}),
        "constant onto a cell": (demo.variable("MIN_DAYS"), {"cell": demo.cell("weekly")}),
        "column onto column": (demo.column("diary", "sleep_hours"), {"item": demo.column("diary", "pain_score")}),
        "frame onto frame": (demo.variable("diary"), {"item": demo.variable("patients")}),
        "frame onto itself": (demo.variable("diary"), {"item": demo.variable("diary")}),
        "column onto itself": (demo.column("patients", "bmi"), {"item": demo.column("patients", "bmi")}),
    }


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
def test_drop_option_code_runs(demo, case):
    source, target = drops(demo)[case]
    result = drop_options(DropRequest.from_json({"source": source, "target": target, "cells": demo.cells_json(), "context": demo.context()}))
    assert result["options"], case
    coded = [option for option in result["options"] if option["code"]]
    assert coded, f"{case}: no option runs offline"
    for option in coded:
        demo.run(option["code"])


def test_column_onto_a_model_cell_joins_first(demo):
    source, target = drops(demo)["column onto a model cell"]
    result = drop_options(DropRequest.from_json({"source": source, "target": target, "cells": demo.cells_json(), "context": demo.context()}))
    assert result["note"] == "IL6 lives in olink: joined on patient_id first."
    covariate = next(o for o in result["options"] if o["text"] == "Add IL6 as a covariate")
    assert covariate["placement"]["kind"] == "edit"
    assert '"pain_score ~ treatment_arm * month + age + IL6"' in covariate["code"]


def test_shift_turns_every_new_cell_into_a_branch(demo):
    source, target = drops(demo)["column onto a plot cell"]
    body = {"source": source, "target": target, "cells": demo.cells_json(), "context": demo.context(), "modifiers": {"branch": True}}
    result = drop_options(DropRequest.from_json(body))
    assert result["mode"] == "branch"
    assert {o["placement"]["kind"] for o in result["options"]} == {"branch"}


def test_alt_preselects_three_options(demo):
    source, target = drops(demo)["column onto a model cell"]
    body = {"source": source, "target": target, "cells": demo.cells_json(), "context": demo.context(), "modifiers": {"parallel": True}}
    result = drop_options(DropRequest.from_json(body))
    assert result["mode"] == "parallel"
    assert result["preselected"] == [o["id"] for o in result["options"][:3]]


@pytest.mark.parametrize("cell_ids", [["weekly"], ["lmm"], ["lmm", "ordinal"], ["weekly", "lmm"]])
def test_cell_question_code_runs(demo, cell_ids):
    context = Context.from_json(demo.context())
    cells = [CellInfo.from_json({**demo.cell(i), "branch_of": "lmm" if i == "ordinal" else None}) for i in cell_ids]
    questions = cell_questions(cells, context)
    assert questions
    for question in questions:
        if question.code:
            demo.run(question.code)


def test_next_steps_cover_open_assumptions_and_run(demo):
    context = Context.from_json(demo.context())
    cells = [CellInfo.from_json(c) for c in demo.cells_json()]
    olink = demo.variable("olink")
    groups = {"olink": [{"label": g["label"], "total": len(g["columns"]), "used": 0} for g in olink["groups"]]}
    steps = next_steps(cells, context, groups, set())
    texts = [step.text for step in steps]
    assert "Does MIN_DAYS = 14 change the result of [4]?" in texts
    assert steps[0].reasons
    for step in steps[:4]:
        if step.code:
            demo.run(step.code)


def test_next_steps_leave_out_the_reshape_that_a_cell_made(demo):
    """[3] makes diary from diary_raw with to_long, and Worth asking next offered the reshape first (critique 5, the app, A3).

    diary holds the measures as pain_score, sleep_hours and mood, so no
    frame held pain, sleep and mood under the names of diary_raw's columns.
    """
    context = Context.from_json(demo.context())
    assert (context.frame_rows["diary_raw"], context.frame_rows["diary"]) == (5880, 36941)
    cells = [CellInfo.from_json(c) for c in demo.cells_json()]
    texts = [step.text for step in next_steps(cells, context, {}, set())]
    # Nor does a question pair a day's column of diary_raw with diary's pain_score.
    assert not [text for text in texts if text.startswith("Reshape") or "pain_1" in text or "sleep_1" in text], texts
    # Without [3], the reshape is offered.
    unshaped = [cell for cell in cells if cell.id != "reshape"]
    texts = [step.text for step in next_steps(unshaped, context, {}, set())]
    assert "Reshape diary_raw to one row per day: pain, sleep and mood" in texts


def test_polars_drop_option_code_runs(demo):
    """Headers of a polars table ask what its columns dropped ask: the code is polars code, and runs.

    The listing leaves out names that start with an underscore, so these frames have plain names.
    """
    pl = pytest.importorskip("polars")
    ns = demo.shell.user_ns
    ns["drops_pl"] = pl.DataFrame(
        {"patient_id": ["p1", "p2", "p3", "p4"], "age": [34, 51, None, 29], "pain": [3.1, 7.2, 6.9, 2.8]}
    )
    ns["visits_pl"] = pl.DataFrame({"patient_id": ["p1", "p1", "p2", "p3", "p4"], "crp": [1.0, 3.0, 2.5, 0.5, 4.0]})
    try:
        listing = {v["name"]: v for v in demo.kernel("inspect_variables", {})["variables"]}

        def column(frame, label):
            # As the view sends a column: prepareVariable names the library of a polars frame.
            entry = next(c for c in listing[frame]["columns"] if c["label"] == label)
            return {**entry, "name": f"{frame}[{label!r}]", "parent": frame, "rows": listing[frame]["rows"], "library": "polars"}

        def frame(name):
            return {key: value for key, value in listing[name].items() if key not in ("columns", "groups")}

        context = {
            "frames": {
                name: {"rows": listing[name]["rows"], "columns": {c["label"]: c["tag"] for c in listing[name]["columns"]}}
                for name in ("drops_pl", "visits_pl")
            },
            "used": [],
            "asked": [],
        }

        def options(source, target):
            result = drop_options(DropRequest.from_json({"source": source, "target": {"item": target}, "cells": [], "context": context}))
            return {option["text"]: option["code"] for option in result["options"]}

        pair = options(column("drops_pl", "age"), column("drops_pl", "pain"))
        code = pair["Are age and pain associated?"]
        assert code.split("\n")[1:] == ["import polars as pl", "", 'drops_pl.select(pl.corr("age", "pain"))']
        demo.run(code)
        joined = options(column("drops_pl", "age"), column("visits_pl", "crp"))["Are age and crp associated?"]
        assert (
            '_age_and_crp_data = _age_and_crp_data.join(visits_pl.group_by("patient_id").agg(pl.col("crp").mean()), on="patient_id", how="left")'
            in joined
        )
        demo.run(joined)
        frames = options(frame("drops_pl"), frame("visits_pl"))["Join drops_pl and visits_pl"]
        assert 'drops_pl.join(visits_pl, on=["patient_id"], how="left")' in frames
        demo.run(frames)
    finally:
        for name in ("drops_pl", "visits_pl", "_age_and_crp_data", "drops_plvisits_pl"):
            ns.pop(name, None)
