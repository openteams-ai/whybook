# Whybook

[![Github Actions Status](https://github.com/openteams-ai/whybook/actions/workflows/build.yml/badge.svg)](https://github.com/openteams-ai/whybook/actions/workflows/build.yml)
[![Sandbox](https://github.com/openteams-ai/whybook/actions/workflows/sandbox.yml/badge.svg)](https://github.com/openteams-ai/whybook/actions/workflows/sandbox.yml)
[![Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gh/openteams-ai/whybook/main?urlpath=lab/tree/pain_diary_demo.ipynb)

> [!WARNING]
> **Research prototype.** Whybook is a research prototype for the future of Jupyter interfaces: [whybook.dev](https://whybook.dev) describes the idea. Its features, settings and notebook metadata can change between releases without deprecation.

## You ask the questions. Agents write the code.

Whybook is a view of a Jupyter notebook for data analysis with AI, in which the analyst asks the questions and still understands every result. It has no chat box. The analyst picks one of the questions that Whybook offers, or types or says their own. The offers follow what the analyst points at (a column dragged onto a cell or clicked in Click mode, a region of a plot, a chip on a cell). The code comes from a template or from the AI model of the analyst's choice, and Whybook places the cell and runs it. Every constant, default and choice behind the result is shown on the cell, where the analyst can question it.

[whybook.dev](https://whybook.dev) also gives the evidence behind the idea, and [the roadmap](https://whybook.dev/roadmap.html) sets out the path to v1.

![Whybook showing the demo notebook in JupyterLab after Run all. Cell [4] carries the chips MIN_DAYS 14, inner join, ci bootstrap and n_boot 1000, and the Exploration panel counts the questions asked by type.](https://raw.githubusercontent.com/openteams-ai/whybook/main/screenshots/bench.png)

## What it does

- **Ask by pointing at the data.** The analyst drags a variable, a column, a file or a database table onto a cell, or clicks the two in Click mode, and Whybook offers up to 12 ranked questions of five types, each with a place in the notebook. Most of them run code from a template at once, with no model call.
- **Every choice in plain sight.** After a cell runs, Whybook reads its code against the live kernel and shows each value that the result depends on as a chip, such as `MIN_DAYS 14`, or `inner join ×2` for two merges that keep pandas' default. A constant defined in an imported file shows on the cell that uses it.
- **Question a plot.** Every mark of a plot drawn with the `whybook` helpers maps to rows of its data frame. Whybook counts the rows behind a selection, reports what differs there and offers questions about it.
- **Branch in parallel.** Shift+drop turns a question into a branch, and Alt+drop starts several branches at once. Each branch runs in its own kernel subshell (JEP 91, ipykernel 7), on the same data, and the notebook stays one list of cells.
- **Answers that need AI.** For a question that needs a new cell, an agent adds and runs the cells it needs, and ends with a short answer that links the cells that show it. An edit, a branch or a preview gets one cell. Every cell that a model wrote is marked, and one click removes the cells of a run.
- **Python and R.** In an R kernel, Whybook lists the variables, shows the chips and offers the questions, and a model writes the code of each answer in R. The templates write Python only.
- **A kernel in a sandbox.** "Python 3 (sandboxed)" sees the notebook's folder and no network, under bubblewrap on Linux and Seatbelt on macOS. `python -m whybook.sandbox <kernel name>` makes a sandboxed copy of any other kernel, such as R.

The notebook stays an ordinary `.ipynb` file: the questions, choices and assumptions go into its metadata. Whybook opens next to the classic notebook editor, and both share one notebook model and one kernel, so an edit in one shows in the other.

![A selection of weeks 14 to 24 on the plot of cell [4]. Whybook counts 2,050 rows and 262 patients behind it, reports that A minus B is +1.86 there and +1.33 elsewhere, and offers three questions, each with its place in the notebook.](https://raw.githubusercontent.com/openteams-ai/whybook/main/screenshots/plot-selection.png)

The data in the screenshots is synthetic: the demo cohort of `examples/pain_diary`.

## Install

Whybook needs Python 3.10 or later and JupyterLab 4.4 or later, in the 4.x series.

```bash
pip install "whybook[claude,kernel,demo,local,models]"
jupyter lab
```

`local` builds llama-cpp-python for the local models, with the system's C++ compiler, in about 4 minutes: without a compiler, leave it out of the list. Add `speech` for spoken questions transcribed by Moonshine in the Jupyter server, on Linux x86_64 or macOS 15 on Apple silicon.

To open a notebook in Whybook, right-click it in the file browser and choose Open With, then Whybook. On JupyterLab 4.6 and later, the sections of the Whybook panel can also move to the file browser.

## Try the demo

Clone this repository and open `pain_diary_demo.ipynb` from its root in Whybook, then press Run all: the notebook imports its helpers and data from `examples/pain_diary/`. `pain_diary_demo_6h.ipynb` is the same analysis after six more hours of work.

The questions from templates work with no AI model. Questions marked needs AI, and questions that the analyst types, need a model connected in the AI models panel: OpenRouter or Hugging Face after a sign-in, an API key of Anthropic, OpenAI, Google or Mistral AI, or a model server on this machine.

## What leaves the machine

Once a remote AI model is connected, Whybook sends it each table that it shows as a tile, to get a label, and asks it for more questions at each drop or click. With the setting "Keep data on this machine", no values, tables or pictures leave the machine, and `c.Whybook.keep_data_local = True` turns it on for every user of a Jupyter server.

## Development

Whybook is one Python package, `whybook`: the helpers that a notebook imports (`import whybook`), the server extension (`whybook.server`) and the frontend extension of the same name. From a clone of this repository:

```bash
pip install --editable ".[dev,test,claude,kernel,demo,speech]"
jupyter-builder develop . --overwrite
jupyter server extension enable whybook
jlpm build
```

Run `jlpm build` again after each change to the TypeScript source, or keep `jlpm watch` running beside `jupyter lab`. The Python tests run with `pytest whybook/server/tests`, and the Jest tests with `jlpm test`. The integration tests are in `ui-tests/`, whose README has their commands.

## Uninstall

```bash
pip uninstall whybook
```

## Troubleshoot

If you are seeing the frontend extension, but it is not working, check that the server extension is enabled:

```bash
jupyter server extension list
```

If the server extension is installed and enabled, but you are not seeing the frontend extension, check the frontend extension is installed:

```bash
jupyter labextension list
```

## License

Whybook is under the Apache License 2.0: see [LICENSE](LICENSE). The Seatbelt profiles in `whybook/sandbox/codex/` come from OpenAI Codex, under the same licence, with its LICENSE and NOTICE.
