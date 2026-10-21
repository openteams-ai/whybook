# Changelog

## 0.5.0

### New

- Questions show code in the code font and data in bold: "What if `reml` were `False` in the `fit` of **model_data**?".
- What-if questions name the call that they change: "What if the merge with **patients** were an outer join?".
- Chips show a GitHub URL as its repository, file path and branch, instead of the whole URL.
- Variables explored also counts Series and numpy arrays.
- Users can run `python -m whybook.demo` to write the demo notebook and its data into a folder.

### Changed

- Whybook upgrades notebooks older than nbformat 4.5 to 4.5, so they keep their variables and branches after a reload.
- Whybook writes the version of its metadata into the notebooks it changes, so later releases can migrate them.
- Interrupt Kernel stops Run all, as in JupyterLab's notebook.
- Empty code cells no longer run.
- Several empty code cells in a row show as one line, such as "6 empty code cells".
- Tables show in full up to 10 rows, instead of 5.

### Fixed

- The Variables panel and the chips work in notebooks that use a Python builtin's name for a variable, such as `type`.
- The Variables panel shows the terms of statsmodels models fitted on arrays.
- A notebook saved after Run all no longer opens marked as changed.
- More small fixes from running 49 public notebooks in Whybook.

### Security

- Markdown that a model writes into a reproduction no longer loads images from other sites.
- The review guard now checks R code that an agent writes.
- The review guard now checks what Whybook sends to decision models.
- When the server keeps the data on this machine, marking a remote model server as local no longer sends it the data.
- Marking a notebook's data as synthetic, or "Allow for this session", no longer bypasses a guard set with `c.Whybook.review_guard`.
- Sign out and Forget key now delete a key typed for a model server, such as vLLM.
- The review guard flags model code that reads Whybook's saved keys.
- Kernels no longer inherit `TYPESAFE_API_KEY` from the server.

## 0.4.0

### New

- Jupyter Notebook 7 support.
- A first-run screen asks which of three ways to use AI models.
- Admins can use `c.Whybook.way_to_use_models` to set the way for every user, and `"all-local"` to refuse every model outside the network.
- Small decision models can sort your questions and choose where each answer goes.
- A question about alternatives, such as two models, starts a parallel branch for each.
- Under the Ask button, users can preview the answer first, or put it where a model suggests.
- When the offered questions likely miss what the analyst wants, a model adds one.

### Changed

- An agent's run can take up to 200 cells, instead of 8.
- As many branches run at once as the machine has processors, instead of 8.
- The demo notebook moved to `examples/pain_diary/pain_diary_cohort.ipynb`.
- Releases use PyPI trusted publishing, with attestations.

### Fixed

- Small fixes from two rounds of testing by hand.

## 0.3.0

### New

- The review guard checks every prompt before it goes to a model on another machine, and code that an AI wrote before it runs. Use `c.Whybook.review_guard` to set it for every user.
- In an R notebook, a model writes its answers and branches in R.
- Dropping a column onto a model's cell offers "Does the effect of treatment_arm on pain_score differ by site?".
- Users can choose the items of Whybook's toolbar in the setting "Whybook toolbar".
- The demo opens on Binder, with no install.

### Changed

- An agent fixes a failed cell in place, instead of adding a new one.
- "Find more defaults with AI" shows a chip only for a default that can change a result.
- Whybook's toolbar shows the progress of Run all, as JupyterLab's notebook does.
- The sandboxed kernel is tested on macOS as well as Linux.

### Fixed

- Fixes from recording the demo videos.

## 0.2.0

### Changed

- The package no longer installs the kernel "SAS (licence needed)".

## 0.1.0

### New

- First release on PyPI, for JupyterLab 4.4 or later.
