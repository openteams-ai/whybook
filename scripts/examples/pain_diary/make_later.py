"""Write examples/pain_diary/pain_diary_cohort_6h.ipynb: the demo after about six more hours of analysis.

It starts from the cells of make_notebook.py and adds model checks, two more
branches, a look at missing diary days, a screen of the 4,812 proteins,
secondary outcomes and a report: larger tables, and cells with several
outputs. The whybook metadata records the questions asked over those hours.

It also keeps what the view reads from the kernel, as the view does after a
run: the variables in the notebook metadata and each cell's analysis in its
metadata. The notebook then opens with its map and panels before anything
runs. The labels of the large tables are written here, from the numbers of
each table, where the view would ask Claude for them.

    python scripts/examples/pain_diary/make_later.py [--root]

With --root it writes pain_diary_demo_6h.ipynb in the repository root instead,
importing prep as examples.pain_diary.prep. It runs every cell, which takes a
minute or two.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import nbformat
from nbformat.v4 import new_notebook

from make_notebook import CELLS, EXAMPLE, NOTEBOOK_EPI, REPO, code, markdown, question

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

# fingerprint is imported here for the tests of the notebook this script writes.
from kept_state import fingerprint, label_tables, run_and_keep  # noqa: E402


def assumption(text: str, kind: str) -> dict:
    return {"text": text, "kind": kind}


def follow(text: str, kind: str) -> dict:
    return {"text": text, "type": kind}


LATER = [
    code(
        """
model_data = model_data.assign(fitted=lmm_fit.fittedvalues, residual=lmm_fit.resid)
whybook.scatter(model_data, x="fitted", y="residual", by="treatment_arm", max_points=1500, title="Residuals against fitted values")
display(model_data.groupby("treatment_arm")[["residual"]].describe().round(3))
print(f"Residual SD {model_data['residual'].std():.2f}; {int((model_data['residual'].abs() > 3).sum())} residuals beyond 3")
""",
        "lmm_checks",
        title="Residuals of the mixed model",
        question=question("Do the residuals of the mixed model look like noise?", "quality"),
        asked_by="user",
        written_by="agent",
        assumptions=[assumption("Residuals within a patient are treated as independent after the random slope", "modelling")],
    ),
    code(
        """
sweep = []
for min_days in [7, 14, 21]:
    whybook.progress(len(sweep) / 3, f"MIN_DAYS = {min_days}")
    kept = (
        diary.pipe(drop_sparse, min_days)
        .merge(patients[["patient_id", "treatment_arm", "age"]], on="patient_id")
        .groupby(["patient_id", "treatment_arm", "age", "week"], as_index=False, observed=True)["pain_score"]
        .mean()
        .assign(month=lambda d: (d["week"] - 1) / 4.345)
    )
    fit = smf.mixedlm("pain_score ~ treatment_arm * month + age", kept, groups="patient_id", re_formula="~month").fit()
    sweep.append(
        {
            "min_days": min_days,
            "patients": kept["patient_id"].nunique(),
            "arm_x_month": fit.params["treatment_arm[T.B]:month"],
            "p": fit.pvalues["treatment_arm[T.B]:month"],
        }
    )
whybook.progress(1.0, "done")
min_days_sweep = pd.DataFrame(sweep).round(4)
min_days_sweep
""",
        "min_days_sweep",
        title="The arm effect for three values of MIN_DAYS",
        question=question("Does the arm effect depend on MIN_DAYS?", "model"),
        asked_by="user",
        written_by="agent",
        branch={"of": "lmm", "letter": "c"},
    ),
    code(
        """
no_east = model_data[model_data["site"] != "east"]
fit_no_east = smf.mixedlm("pain_score ~ treatment_arm * month + age", no_east, groups="patient_id", re_formula="~month").fit()
fit_no_east.summary().tables[1]
""",
        "without_east",
        title="The mixed model without site east",
        question=question("Does one site drive the arm effect?", "causal"),
        asked_by="user",
        written_by="agent",
        branch={"of": "lmm", "letter": "d"},
        follow_up=[follow("Is site east different at baseline?", "descriptive")],
    ),
    markdown("## Missing diary days", "section-missing"),
    code(
        """
completeness = (
    diary.groupby("patient_id", as_index=False)
    .agg(days_logged=("diary_day", "size"), last_week=("week", "max"))
    .merge(patients[["patient_id", "treatment_arm", "site"]], on="patient_id")
    .assign(dropped=lambda d: d["last_week"] < 12)
)
display(completeness.groupby("treatment_arm")[["days_logged", "dropped"]].mean().round(2))
completeness
""",
        "completeness",
        title="Diary days logged, per patient",
        question=question("Who stops keeping the diary?", "quality"),
        asked_by="user",
        written_by="agent",
        assumptions=[assumption("A patient whose last diary week is before week 12 dropped out", "modelling")],
    ),
    code(
        """
days_per_week = (
    diary.groupby(["patient_id", "week"], as_index=False)
    .size()
    .rename(columns={"size": "days"})
    .assign(share=lambda d: d["days"] / 7)
    .merge(patients[["patient_id", "treatment_arm"]], on="patient_id")
)
whybook.ribbon(days_per_week, x="week", y="share", by="treatment_arm", title="Share of diary days logged, by week")
days_per_week.groupby("treatment_arm")["share"].mean().round(3).to_frame("share logged")
""",
        "missing_by_week",
        title="Diary days logged, by week",
        question=question("When do diary days go missing?", "quality"),
        asked_by="user",
        written_by="agent",
    ),
    code(
        """
early_pain = (
    weekly[weekly["week"] <= 4].groupby("patient_id", as_index=False)["pain_score"].mean().rename(columns={"pain_score": "early_pain"})
)
dropout_data = completeness.merge(early_pain, on="patient_id").merge(patients[["patient_id", "age"]], on="patient_id")
dropout_fit = smf.logit("dropped ~ early_pain + treatment_arm + age", data=dropout_data.assign(dropped=lambda d: d["dropped"].astype(int))).fit(disp=False)
dropout_fit.summary2().tables[1].round(3)
""",
        "dropout_model",
        title="Does early pain predict dropping out?",
        question=question("Does pain predict dropping out?", "causal"),
        asked_by="user",
        written_by="agent",
        assumptions=[
            assumption("Diary days are missing at random given the arm and early pain", "modelling"),
            assumption("Early pain is the mean of weeks 1 to 4", "data"),
        ],
        follow_up=[follow("Would inverse probability weights change the arm effect?", "model")],
    ),
    markdown("## Protein panel", "section-proteins"),
    code(
        """
import numpy as np

slopes = (
    weekly.groupby("patient_id")
    .apply(lambda d: np.polyfit(d["week"], d["pain_score"], 1)[0] if len(d) > 2 else np.nan, include_groups=False)
    .rename("pain_slope")
    .reset_index()
    .dropna()
    .merge(patients[["patient_id", "treatment_arm"]], on="patient_id")
)
whybook.hist(slopes, x="pain_slope", bins=40, title="Change in weekly pain per week, per patient")
slopes.groupby("treatment_arm")["pain_slope"].describe().round(3)
""",
        "slopes",
        title="How fast pain changes, per patient",
        question=question("How fast does each patient's pain change?", "descriptive"),
        asked_by="user",
        written_by="agent",
    ),
    code(
        """
from scipy import stats
from statsmodels.stats.multitest import multipletests

proteins = olink.set_index("patient_id")
joined = proteins.join(slopes.set_index("patient_id")["pain_slope"], how="inner")
names = list(proteins.columns)
r = joined[names].corrwith(joined["pain_slope"])
n = joined[names].notna().sum()
t = r * np.sqrt((n - 2) / (1 - r**2))
panel_of = {name: panel for panel, members in olink.attrs["whybook"]["groups"].items() for name in members}
protein_screen = (
    pd.DataFrame({"protein": names, "panel": [panel_of[name] for name in names], "n": n.to_numpy(), "r": r.to_numpy(), "p": 2 * stats.t.sf(np.abs(t), n - 2)})
    .assign(q=lambda d: multipletests(d["p"], method="fdr_bh")[1], neg_log10_p=lambda d: -np.log10(d["p"]))
    .sort_values("p")
    .reset_index(drop=True)
    .round({"r": 3, "p": 5, "q": 4, "neg_log10_p": 2})
)
whybook.scatter(protein_screen, x="r", y="neg_log10_p", by="panel", max_points=5000, title="Proteins against the change in pain")
display(protein_screen.head(10))
protein_screen
""",
        "screen",
        title="Which proteins track the change in pain?",
        question=question("Which proteins track the change in pain?", "association"),
        asked_by="user",
        written_by="agent",
        assumptions=[assumption("Correlations are pairwise: each protein uses the patients it was measured in", "data")],
        follow_up=[follow("Does IL6 still track pain after adjusting for age and site?", "causal")],
    ),
    code(
        """
hits_by_panel = (
    protein_screen.assign(hit=protein_screen["q"] < 0.05)
    .groupby("panel")
    .agg(proteins=("protein", "size"), hits=("hit", "sum"), strongest=("r", lambda s: s.abs().max()))
)
hits_by_panel
""",
        "hits_by_panel",
        title="Hits per assay panel",
        question=question("Which panels hold the hits?", "descriptive"),
        asked_by="user",
        written_by="agent",
    ),
    markdown("## Secondary outcomes", "section-secondary"),
    code(
        """
sleep_weekly = (
    diary.merge(patients[["patient_id", "treatment_arm", "age"]], on="patient_id")
    .groupby(["patient_id", "treatment_arm", "age", "week"], as_index=False, observed=True)["sleep_hours"]
    .mean()
    .assign(month=lambda d: (d["week"] - 1) / 4.345)
)
whybook.ribbon(sleep_weekly, x="week", y="sleep_hours", by="treatment_arm", title="Weekly sleep hours, by arm")
sleep_fit = smf.mixedlm("sleep_hours ~ treatment_arm * month + age", sleep_weekly, groups="patient_id", missing="drop").fit()
sleep_fit.summary().tables[1]
""",
        "sleep",
        title="Sleep hours by arm",
        question=question("Does arm B change sleep too?", "association"),
        asked_by="user",
        written_by="agent",
    ),
    code(
        """
took_analgesic = diary.merge(patients[["patient_id", "treatment_arm"]], on="patient_id").assign(
    month=lambda d: ((d["week"] - 1) // 4 + 1).clip(upper=6),
    took=lambda d: (d["analgesic_use"] != "none").astype(float),
)
whybook.bars(took_analgesic, x="treatment_arm", y="took", title="Share of days with an analgesic, by arm")
analgesic_share = took_analgesic.pivot_table(index="month", columns="treatment_arm", values="took", aggfunc="mean", observed=True).round(3)
analgesic_share
""",
        "analgesics",
        title="Analgesic use by arm and month",
        question=question("Do patients in arm B take fewer analgesics?", "association"),
        asked_by="user",
        written_by="agent",
    ),
    markdown("## Report", "section-report"),
    code(
        """
table_one = pd.concat(
    [
        patients.groupby("treatment_arm").size().rename("patients").to_frame().T,
        patients.groupby("treatment_arm")[["age", "bmi"]].mean().round(1).T.rename(index=lambda name: f"{name}, mean"),
        patients.groupby("treatment_arm")["bmi"].apply(lambda s: s.isna().mean()).round(2).to_frame("bmi, share missing").T,
        pd.crosstab(patients["site"], patients["treatment_arm"]),
        pd.crosstab(patients["stage"], patients["treatment_arm"]),
    ]
)
table_one
""",
        "table_one",
        title="Table 1: who is in each arm",
        question=question("Who is in each arm?", "descriptive"),
        asked_by="user",
        written_by="user",
    ),
    code(
        """
term = "treatment_arm[T.B]:month"
effects = pd.DataFrame(
    [
        {"analysis": "Mixed model", "estimate": lmm_fit.params[term], "p": lmm_fit.pvalues[term]},
        {"analysis": "Without site east", "estimate": fit_no_east.params[term], "p": fit_no_east.pvalues[term]},
        *({"analysis": f"MIN_DAYS = {row.min_days}", "estimate": row.arm_x_month, "p": row.p} for row in min_days_sweep.itertuples()),
    ]
).round(4)
whybook.bars(effects, x="analysis", y="estimate", title="Arm B × month, by analysis")
effects
""",
        "effects",
        title="The arm effect across the analyses",
        question=question("How consistent is the arm effect across the analyses?", "model"),
        asked_by="user",
        written_by="agent",
    ),
    # Written after the run, from the numbers: see summary().
    markdown("## Summary", "summary"),
]


def summary(facts: dict) -> str:
    dropped = facts["dropped_by_arm"]
    screen = (
        f"Of the 4,812 proteins, only {facts['top']} tracks how fast pain changes once the false discovery rate is controlled."
        if facts["hits"] == 1
        else f"{facts['hits']} of the 4,812 proteins track how fast pain changes once the false discovery rate is controlled."
    )
    return (
        "## Summary\n\n"
        f"Pain falls over the six months in both arms, faster in arm B, by {abs(facts['interaction']):.2f} points more per month, "
        "and the difference holds without site east and for each value of MIN_DAYS. "
        f"More patients stop keeping the diary in the first 12 weeks in arm A ({dropped['A']:.0%}) than in arm B ({dropped['B']:.0%}), "
        "so the patients who stay are not a random half of either arm. "
        + screen
    )

ASKED_AT = [
    "09:05", "09:20", "09:40", "10:10", "10:30", "10:55", "11:20", "11:45", "12:30",
    "13:05", "13:25", "13:50", "14:10", "14:30", "14:45", "15:00", "15:10", "15:20",
]


# The facts the headlines rest on, read from the kernel after the run.
FACTS = """
def _significant(fit):
    return int(sum(fit.pvalues[name] < 0.05 for name in fit.fe_params.index))

from IPython.display import display as _display
_display(
    {
        "application/vnd.whybook.result+json": {
            "lmm": _significant(lmm_fit),
            "interaction": float(lmm_fit.params["treatment_arm[T.B]:month"]),
            "dropped_by_arm": {arm: float(share) for arm, share in completeness.groupby("treatment_arm")["dropped"].mean().items()},
            "no_east": _significant(fit_no_east),
            "sleep": _significant(sleep_fit),
            "sweep_holds": bool((min_days_sweep["p"] < 0.05).all()),
            "dropped": int(completeness["dropped"].sum()),
            "early_pain_p": float(dropout_fit.pvalues["early_pain"]),
            "hits": int((protein_screen["q"] < 0.05).sum()),
            "top": str(protein_screen["protein"].iloc[0]),
            "effects_negative": bool((effects["estimate"] < 0).all()),
            "analgesics_b_lower": bool(analgesic_share["B"].iloc[-1] < analgesic_share["A"].iloc[-1]),
        }
    },
    raw=True,
)
del _significant, _display
"""


def labels(facts: dict) -> dict[str, list[tuple[str, str]]]:
    """A description and a headline for each table output of a cell, in order."""
    return {
        "reshape": [("daily diary rows", "")],
        "lmm": [("model coefficients", f"{facts['lmm']} significant")],
        "lmm_checks": [("residuals by arm", "")],
        "min_days_sweep": [("sweep of MIN_DAYS", "holds for every value" if facts["sweep_holds"] else "")],
        "without_east": [("model without east", f"{facts['no_east']} significant")],
        "completeness": [("dropout by arm", ""), ("diary completeness", f"{facts['dropped']} dropped out")],
        "missing_by_week": [("days logged by arm", "")],
        "dropout_model": [("dropout model", "early pain predicts dropout" if facts["early_pain_p"] < 0.05 else "early pain not significant")],
        "slopes": [("pain slopes by arm", "")],
        "screen": [("top proteins", f"{facts['top']} strongest"), ("protein screen", f"{facts['hits']} pass FDR" if facts["hits"] else "none pass FDR")],
        "hits_by_panel": [("hits per panel", f"{facts['hits']} hits")],
        "sleep": [("sleep model", f"{facts['sleep']} significant")],
        "analgesics": [("analgesic use", "B lower" if facts["analgesics_b_lower"] else "")],
        "table_one": [("baseline by arm", "")],
        "effects": [("effect by analysis", "all negative" if facts["effects_negative"] else "")],
    }


def main() -> None:
    root = "--root" in sys.argv
    cells = copy.deepcopy(CELLS) + copy.deepcopy(LATER)
    # The questions of the first notebook came first.
    if root:
        imports = next(cell for cell in cells if cell["id"] == "imports")
        imports["source"] = imports["source"].replace("from prep import", "from examples.pain_diary.prep import")
    path, run_in = (REPO / "pain_diary_demo_6h.ipynb", REPO) if root else (EXAMPLE / "pain_diary_cohort_6h.ipynb", EXAMPLE)
    epi_meta = copy.deepcopy(NOTEBOOK_EPI)
    asked = [cell["metadata"]["whybook"]["question"] for cell in cells if cell.cell_type == "code" and "question" in cell["metadata"].get("whybook", {})]
    epi_meta["exploration"]["asked"] = [
        {**q, "at": f"2026-09-22T{ASKED_AT[min(i, len(ASKED_AT) - 1)]}:00"} for i, q in enumerate(asked)
    ]
    epi_meta["exploration"]["pivots"] += [
        {"text": "from the arm effect to who stops keeping the diary", "section": "Missing diary days"},
        {"text": "from pain to the proteins that track it", "section": "Protein panel"},
    ]
    epi_meta["exploration"]["dismissed"] = ["next:olink:group:Neurology", "next:confounders:treatment_arm"]
    epi_meta["dag"]["edges"] += [["pain_score", "dropped"], ["IL6", "pain_score"], ["treatment_arm", "sleep_hours"]]
    epi_meta["assumptions"] = [
        {"text": "Diary days are missing at random given the arm and early pain", "source": "dropout_model"},
        {"text": "A patient whose last diary week is before week 12 dropped out", "source": "completeness"},
    ]
    notebook = new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {"name": "python3", "display_name": "Python 3 (ipykernel)", "language": "python"},
            "language_info": {"name": "python"},
            "whybook": epi_meta,
        },
    )
    # Run it, and keep what the view keeps after a run.
    facts = run_and_keep(notebook, run_in, FACTS)
    labelled = label_tables(notebook.cells, labels(facts), "scripts/examples/pain_diary/make_later.py")
    next(cell for cell in notebook.cells if cell["id"] == "summary")["source"] = summary(facts)
    nbformat.validate(notebook)
    nbformat.write(notebook, path)
    print(f"wrote {path}: {len(notebook.cells)} cells, {len(notebook.metadata['whybook']['variables'])} variables kept, {labelled} tables labelled")
    print("facts:", json.dumps(facts))


if __name__ == "__main__":
    main()
