"""How a cell shows a table, text and a figure, in the prompts of an agent and of a one-cell answer, and in the templates (design iteration 1.101).

In the recorded takes of the two demo videos, on NHEFS and on the Youth Risk
Behavior Survey, models wrote 261 cells in Python: 239 in agents' runs and 22
as one-cell answers. 24 cells of agents ended on a string, each on
frame.to_string(index=False): IPython shows its repr, quoted and on one line,
and the bench showed the first word of cell [7] of the final take,
"variable". Both cells that drew a figure ended on fig, and the figure
showed twice: matplotlib's inline backend also shows every open figure when
the cell ends. 101 cells of agents printed a table, 91 as text and 10 as
dictionaries. The owner: "Notebooks are about excellent presentation of
outputs".

The prompts get rules for the kernel's language: for Python, IPython's
display; for R, IRdisplay, since xeus-r shows the last value of a cell as
plain text. A language without an entry gets neither. The tests check what
the prompts hold; no model runs, so no test shows that a model follows the
rules. Two tests run each ending that the rules name, in an ipykernel with
the view's plot hooks and in an R kernel, and check what it shows. The
templates' code shows a table where it printed one, or showed a Series.
"""

import sys
import warnings

import pytest

from whybook.server import agent, claude, solve
from whybook.server.config import Whybook

from .test_agent import claude_code_sdk, drive, request

# What each rule says, in the prompts' words.
PYTHON_RULES = {
    "a table": 'Show a table as a data frame, rounded and with readable column names, such as "Selected %" in place of sel_pct: end the cell with it, or call display() on each of several.',
    "never printed": "Never print a table, with print() or with to_string().",
    "text": "Print text with print(), and never end the cell on a string: IPython shows it quoted, on one line.",
    "a figure once": "IPython shows every open figure when the cell ends: end with plt.show(), never with fig, and call plt.close(fig) after display(fig).",
    "a trailing ;": "A ; at the end of the last line hides a value nobody needs, such as the list that plt.plot returns.",
}
R_RULES = {
    "a table": (
        'Show a table as a data frame, rounded and with readable column names, such as "Selected %" in place of sel_pct, with'
        " IRdisplay::display(frame), one call for each table: xeus-r shows a frame at the end of a cell as plain text."
    ),
    "never printed": "Never print a table, with print() or with cat().",
    "text": "Write text with cat(), and never end the cell on a string: R shows it quoted, after [1].",
}
RULES = {"python": PYTHON_RULES, "r": R_RULES}
QUESTION = {"text": "How did quitters and continuers differ in 1971?", "type": "descriptive"}


def words(text):
    return " ".join(text.split())


def prompts(language):
    """The system prompts of an agent and of a one-cell answer, for a kernel of this language."""
    return words(request(language=language).system_prompt()), words(solve.system_prompt(language))


@pytest.mark.parametrize(("language", "rule"), [(language, rule) for language, rules in sorted(RULES.items()) for rule in sorted(rules)])
def test_the_prompts_have_the_rule_of_the_kernel_s_language(language, rule):
    for prompt in prompts(language):
        assert RULES[language][rule] in prompt
    if language == "python":
        assert RULES[language][rule] in words(solve.SYSTEM_PROMPT)


def test_each_language_gets_its_own_rules_and_a_language_without_an_entry_none():
    python, r, julia = (prompts(language) for language in ("python", "r", "julia"))
    for prompt in python:
        assert "IRdisplay" not in prompt and "cat()" not in prompt
    for prompt in r:
        assert "IPython" not in prompt and "plt." not in prompt and "to_string" not in prompt
    for prompt in julia:
        assert not any(rule in prompt for rules in RULES.values() for rule in rules.values())
        assert "IPython" not in prompt and "IRdisplay" not in prompt


async def test_the_rules_reach_the_agent_s_model_through_the_claude_agent_sdk(monkeypatch):
    from .test_claude import ResultMessage

    sdk = claude_code_sdk(lambda SystemMessage: [ResultMessage(is_error=False, subtype="success", errors=[], total_cost_usd=0.01)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    for language in ("python", "r"):
        await drive(agent.run_events(request(language=language), Whybook(), agent.claude_driver), [])
        sent = words(sdk.options[-1].system_prompt)
        assert all(rule in sent for rule in RULES[language].values())


async def test_the_rules_reach_the_model_of_a_one_cell_answer(monkeypatch):
    systems = []

    async def by_claude(prompt, **options):
        systems.append(words(options["system_prompt"]))
        yield {"type": "result", "output": {"summary": "s", "code": "x = 1", "assumptions": [], "follow_up": []}, "model": "claude", "cost_usd": 0.01}

    monkeypatch.setattr(claude, "structured_call", by_claude)
    for language in ("python", "r"):
        asked = solve.SolveRequest.from_json({"question": QUESTION, "placement": "new", "language": language})
        assert [event["type"] async for event in solve.solve(asked, Whybook())] == ["result"]
    python, r = systems
    assert all(rule in python for rule in PYTHON_RULES.values()) and not any(rule in python for rule in R_RULES.values())
    assert all(rule in r for rule in R_RULES.values()) and not any(rule in r for rule in PYTHON_RULES.values())


def test_the_random_slope_test_of_a_template_shows_as_a_table():
    np = pytest.importorskip("numpy")
    pd = pytest.importorskip("pandas")
    smf = pytest.importorskip("statsmodels.formula.api")
    from whybook.server.questions.cells import CellInfo, random_slope_code

    # 20 patients over 8 weeks, each with an intercept and a slope of their own.
    rng = np.random.default_rng(7)
    patient = np.repeat(np.arange(20), 8)
    week = np.tile(np.arange(8), 20)
    pain = 5 - 0.2 * week + rng.normal(0, 1, 20)[patient] + rng.normal(0, 0.15, 20)[patient] * week + rng.normal(0, 0.5, len(week))
    weekly = pd.DataFrame({"patient_id": patient, "week": week, "pain": pain})
    cell = CellInfo("c5", "[5]", 'fit = smf.mixedlm("pain ~ week", data=weekly, groups="patient_id", re_formula="~week").fit()', formulas=("pain ~ week",))
    namespace = {"weekly": weekly, "smf": smf}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        exec(random_slope_code(cell), namespace)  # noqa: S102  the view runs the same code in the kernel
    table = namespace["random_slope_test"]
    # A Series showed as plain text, with "dtype: float64" under it.
    assert isinstance(table, pd.DataFrame) and list(table.columns) == ["likelihood ratio test"]
    assert list(table.index) == ["log likelihood, slope", "log likelihood, intercept only", "LR", "p (chi-squared, 2 df, conservative)"]


SETUP = 'import pandas as pd\nimport matplotlib.pyplot as plt\nframe = pd.DataFrame({"variable": ["age", "sex"], "description": ["AGE IN 1971", "0: MALE 1: FEMALE"]})'
FIGURE = "fig, ax = plt.subplots()\nax.plot([1, 2], [3, 4])\n"


def test_each_ending_that_the_python_rules_name_shows_what_they_say(tmp_path, monkeypatch):
    pytest.importorskip("jupyter_client")
    pytest.importorskip("pandas")
    pytest.importorskip("matplotlib")
    from .test_plot_hooks import Kernel, call

    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(tmp_path / "runtime"))
    kernel = Kernel(tmp_path)
    try:
        kernel.wait(kernel.send(call("plot_hooks", {}), silent=True))
        kernel.wait(kernel.send(SETUP))

        def outputs(code):
            return kernel.outputs[kernel.wait(kernel.send(code))]

        def figures(code):
            return sum("image/png" in data for data in outputs(code))

        # A figure: ending on it shows it twice, as cell [18] of the final take did.
        assert figures(FIGURE + "fig") == 2
        assert figures(FIGURE + "plt.show()") == 1
        assert figures(FIGURE + "display(fig)\nplt.close(fig)") == 1
        assert figures(FIGURE + "display(fig)") == 2
        # A trailing ; hides the value of the last line.
        shown = outputs(FIGURE + "ax.set_title('x')")
        assert [sorted(data) for data in shown][0] == ["text/plain"] and shown[0]["text/plain"].startswith("Text(")
        hidden = outputs(FIGURE + "ax.set_title('x');")
        assert len(hidden) == 1 and "image/png" in hidden[0]
        # A string shows quoted, on one line; printed, it shows as the text it holds.
        (string,) = outputs("frame.to_string(index=False)")
        assert sorted(string) == ["text/plain"]
        assert string["text/plain"].startswith("'variable") and "\\n" in string["text/plain"]
        printed = kernel.wait(kernel.send("print(frame.to_string(index=False))"))
        assert kernel.outputs[printed] == [] and kernel.stdout[printed].startswith("variable") and "\n" in kernel.stdout[printed]
        # A frame shows as a table, at the end of the cell or with display() for each of several.
        assert all("text/html" in data for data in outputs("frame"))
        assert [("text/html" in data) for data in outputs("display(frame)\ndisplay(frame.head(1))")] == [True, True]
    finally:
        kernel.close()


def test_each_ending_that_the_r_rules_name_shows_what_they_say(tmp_path):
    pytest.importorskip("jupyter_client")
    from jupyter_client.manager import start_new_kernel

    from .test_r_analysis import R_KERNEL

    if R_KERNEL is None:
        pytest.skip("no R kernelspec: TESTING.md has the commands for xeus-r")
    manager, client = start_new_kernel(kernel_name=R_KERNEL, cwd=str(tmp_path))

    def run(code):
        """What a cell shows: each output's MIME types and plain text, and what it printed."""
        msg_id = client.execute(code, store_history=False)
        shown, printed = [], ""
        while True:
            msg = client.get_iopub_msg(timeout=120)
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            kind, content = msg["msg_type"], msg["content"]
            if kind in ("display_data", "execute_result"):
                shown.append(content["data"])
            elif kind == "stream":
                printed += content["text"]
            elif kind == "error":
                raise AssertionError(f"{content['ename']}: {content['evalue']}")
            elif kind == "status" and content["execution_state"] == "idle":
                return shown, printed

    try:
        run('frame <- data.frame(variable = c("age", "sex"), share = c(0.41, 0.59))')
        # The last value of a cell shows as plain text, as a print does.
        shown, _ = run("frame")
        assert [sorted(data) for data in shown] == [["text/plain"]]
        # IRdisplay shows it as a table, with its size in the caption, which the view reads.
        shown, _ = run("IRdisplay::display(frame)\nIRdisplay::display(frame[1, ])")
        assert [("text/html" in data) for data in shown] == [True, True]
        assert "<table" in shown[0]["text/html"] and "A data.frame: 2 × 2" in shown[0]["text/html"]
        # A string shows quoted, after [1]; cat writes the text it holds.
        shown, _ = run('paste("n =", nrow(frame))')
        assert shown[0]["text/plain"].startswith('[1] "n = 2"')
        shown, printed = run('cat("n =", nrow(frame), "\\n")')
        assert shown == [] and printed == "n = 2 \n"
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)
