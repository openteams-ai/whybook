"""A column goes against the outcome only from a frame whose rows match the outcome's rows.

The R notebook that an agent made for "Would I get the same results in R?"
offered "How does Variance relate to wt82_71?". Variance is a column of
core_estimates_R, the table of the model's estimates that a cell printed:
its two rows are two ways to compute a variance, not two people. A table of
results holds neither the outcome nor a key of the outcome's frame, so no
row of it matches a row of the data.
"""

from whybook.server.questions.cells import CellInfo, next_steps
from whybook.server.questions.models import Context

ESTIMATES = ("Variance", "Adjusted difference (kg)", "95% CI lower", "p-value")


def offered(context):
    cells = [CellInfo("c5", "[5]", "fit_R <- lm(wt82_71 ~ qsmk + age, data=analysis_R)")]
    return {step.text for step in next_steps(cells, Context.from_json(context), {}, set())}


def test_a_table_of_estimates_offers_none_of_its_columns_against_the_outcome():
    texts = offered(
        {
            "frames": {
                "analysis_R": {"rows": 1566, "columns": {"qsmk": "int", "wt82_71": "num", "age": "int", "sbp": "num"}},
                "core_estimates_R": {"rows": 2, "columns": {"Variance": "cat", "Adjusted difference (kg)": "num", "95% CI lower": "num", "p-value": "num"}},
            },
            "outcome": "wt82_71",
            "used": ["qsmk", "age"],
            "language": "r",
        }
    )
    assert "How does sbp relate to wt82_71?" in texts
    assert not texts & {f"How does {column} relate to wt82_71?" for column in ESTIMATES}


def test_a_frame_with_the_unit_offers_its_columns_and_a_table_of_results_does_not():
    texts = offered(
        {
            "frames": {
                "nhefs": {"rows": 1629, "columns": {"seqn": "id", "wt82_71": "num", "qsmk": "int"}},
                "visits": {"rows": 3000, "columns": {"seqn": "id", "bmi": "num"}},
                "result": {"rows": 1, "columns": {"Estimate": "num", "95% CI lower": "num"}},
            },
            "outcome": "wt82_71",
            "unit": "seqn",
        }
    )
    assert {"How does qsmk relate to wt82_71?", "How does bmi relate to wt82_71?"} <= texts
    assert not texts & {"How does Estimate relate to wt82_71?", "How does 95% CI lower relate to wt82_71?"}
