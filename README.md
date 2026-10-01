# Whybook

> [!WARNING]
> **Research prototype.** Whybook is a research prototype for the future of Jupyter interfaces, and the text below is its pitch. Its features, settings and notebook metadata can change between releases without deprecation.

## You ask the questions. Agents write the code.

Whybook is a view of a Jupyter notebook for data analysis with AI. It has no chat box. The analyst drags a column onto a cell and picks one of the questions it offers, or types one of their own. The view writes the cell, places it and runs it. Every constant, default and choice behind the result is shown on the cell, where the analyst can question it.

- Any `.ipynb` opens in the view, next to the classic notebook.
- The first question offered usually runs from a template, with no model call.
- Branches run in parallel in kernel subshells.

![The Whybook view of the demo notebook in JupyterLab after Run all. Cell [4] carries the chips MIN_DAYS 14, inner join, ci bootstrap and n_boot 1000, and the Exploration panel counts the questions asked by type.](screenshots/bench.png)

## A notebook view built around questions

Whybook opens any `.ipynb` file as a second view, next to the classic notebook. Both views share one notebook model and one kernel, so an edit in one shows in the other. Agents do most of the work, under one rule: the result is an ordinary notebook, and the questions, choices and assumptions go into its metadata. The analyst chooses how deep to go on each cell: its question, the choices on its chips, or its code.

- **Ask by pointing at the data.** Anything in the Variables and Contents panels can be dragged onto a cell, a variable or a column, and so can files and database tables. The view lists up to eight ranked questions of five types, each with a place in the notebook. Most questions run code from a template at once, with no model call. For those marked needs AI, an AI writes the code.
- **Every choice in plain sight.** After a cell runs, the view reads its code against the live kernel and lists the values that the result depends on. Each value becomes a short chip, its name and its value, such as `MIN_DAYS 14`, or `inner join ×2` for two merges that keep pandas' default. Constants defined in imported files are shown on the cell that uses them.
- **Question the result.** Every mark of a plot drawn by the view's helpers maps to rows of its data frame. The view counts the rows behind a selection, reports what differs there and offers questions about it.
- **Branch in parallel, keep one line of cells.** Shift+drop turns any question into a branch, and Alt+drop starts several branches at once. Each branch runs in its own kernel subshell (JEP 91, ipykernel 7), so branches run in parallel on the same data without copying it. The notebook stays a single list of cells, and there is no reactive execution.
- **One question, as many cells as it needs.** When a question needs AI, an agent answers it in the notebook. It adds and runs the cells that the question needs, and it ends with an answer of a few sentences that links the cells that show it. Each cell is marked as written by AI, and one click removes the cells of a run.

![A selection of weeks 14 to 24 on the plot of cell [4]. The view counts 2,050 rows and 262 patients behind it, reports that A minus B is +1.86 there and +1.33 elsewhere, and offers three questions, each with its place in the notebook.](screenshots/plot-selection.png)

The data in the screenshots is synthetic: the demo cohort of `examples/pain_diary`.

## Requirements

- JupyterLab 4.4 or later, in the 4.x series. On 4.6 and later, the sections of the Whybook panel can also move to the file browser.

## Install

```bash
pip install "whybook[claude,kernel,demo,local,models,speach]"
jupyter lab
```

`local` builds llama-cpp-python for the local models, with the system's C++ compiler, in about 4 minutes: without a compiler, leave it out of the list. To open a notebook in the view, right-click it in the file browser and choose Open With, Whybook. The demo notebook, `pain_diary_demo.ipynb`, is in this repository, with its data in `examples/pain_diary/`.

Once you connect a remote AI model, the view sends it each table that it shows as a tile, to get a label, and asks it for more questions at each drop or click. With the setting "Keep data on this machine", no values, tables or pictures leave the machine.

The extension is one Python package, `whybook`: the helpers a notebook imports (`import whybook`), the server extension (`whybook.server`) and the frontend extension of the same name. The view still reads the `epi` metadata and output types of notebooks from before 25 September 2026.

## Development

From a clone of this repository:

```bash
pip install --editable ".[dev,test,claude,kernel,demo, speach]"
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
