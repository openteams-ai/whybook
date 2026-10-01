"""Parameters that shape a drawing are no decisions (design iteration 1.83).

Pain step 14: the card of the agent's model showed six chips, four of them for
the drawing (figsize, xlabel, ylabel, marker), and the one that matters,
cov_type cluster, was lost among them. The analysis makes no decision of a
parameter that shapes a drawing, so that such values leave room, under the cap
of decisions, for those that change a result.
"""

import pytest

pytestmark = pytest.mark.demo

PLOT_AND_MODEL = """\
fig, ax = plt.subplots(figsize=(8, 5))
ax.plot(weekly["week"], weekly["pain_score"], marker="o", label="Arm A")
ax.set_xlabel("Week")
ax.set_ylabel("Mean pain")
ax.set_title("Mean pain by week, first 6 months, by treatment arm")
ols = smf.ols("pain_score ~ week", data=weekly).fit(cov_type="cluster", cov_kwds={"groups": weekly["patient_id"]})
"""


def test_a_drawing_makes_no_decision_and_a_model_keeps_its_own(demo):
    demo.run("import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport statsmodels.formula.api as smf")
    try:
        analysis = demo.kernel("analyze_cells", {"cells": [{"id": "card", "source": PLOT_AND_MODEL}]})["cells"]["card"]
    finally:
        demo.run("plt.close('all')")
    names = {decision["name"] for decision in analysis["decisions"]}
    assert "cov_type" in names
    assert not names & {"figsize", "xlabel", "ylabel", "label", "marker"}
