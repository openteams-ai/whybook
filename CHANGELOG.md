# Changelog

## 0.7.0

### New

- Whybook masks keys, tokens and passwords in every prompt before it goes to a model outside your machine, such as an API key in a cell or a password that an output prints. The model sees `[secret: <name>]` in their place.
- A new setting, "Allow Safety Retention (OpenRouter)", sits under "Zero data retention (OpenRouter)". Turn it off to skip providers that keep requests to detect abuse, such as Google for its Gemini models.
- Jais-3 3.7B is a new local model for laptops with 16 GB. It can label tables and give the questions you type their type.
- Administrators can require zero data retention without Safety Retention for every user with `c.Whybook.openrouter_zdr_only = True`.
- The user documentation in `docs/`, with pages on security and privacy and on configuring a server for a team.

### Changed

- Whybook needs JupyterLab 4.6.6 or later.
- The local Decider models use newer versions, decider-2b v12 and decider-4b v3. If you use one, download it again in the settings.

### Fixed

- A custom local model whose chat template is like Jais-3's no longer fails on labels or on the questions you type.

## 0.6.0

### New

- Drex Max by Nace.AI is a new decision model. It suggests where an answer goes better than the other decision models.
- Qwen3.5 4B replaces Qwen3 4B among the local models for laptops with 16 GB. It gives the questions you type the right type more often. If you chose Qwen3 4B, Whybook switches to Qwen3.5 4B: download it in the settings.

### Changed

- Whybook needs Python 3.11 or later.
- Local models need llama-cpp-python 0.3.37 or later. Ministral 3 no longer needs an extra copy of its file, so you can delete `~/.cache/whybook/models`.
- Spoken questions need moonshine-voice 0.1.6 or later. Download your Moonshine model again in the settings.
- On OpenRouter, More questions now use GPT-6 Luna by default, because OpenRouter no longer serves Mercury 2.5.
- Decider by Perplexity now uses version 1.3, and D1 by Liquid AI uses D1.2.
- Mercury Decide is gone, because OpenRouter no longer serves it. If you chose it, Whybook uses its built-in rules.
- Jev through TypeSafe's own API now asks for Jev 1.13, which did better than Jev 1.14 in our tests.
- Kev 4B now works only with "Zero data retention (OpenRouter)" turned off.

### Fixed

- "AI is retrying" shows again with Pydantic AI 2.60 or later.
- On Python 3.14, a call of `warnings.filterwarnings` no longer shows as a chip.

### Security

- With the Claude Code login, Claude Code no longer reads a file that a cell or a question names with `@`, and no longer sends it with the prompt.

## 0.5.1

### Fixed

- The Variables panel shows the columns of data frames after a plain `pip install whybook`.
- The preview of an answer and the strip of a branch show a question's code in the code font, instead of backticks.
- When a question is asked while Whybook is still drawing the notebook, Whybook now scrolls to the answer.
- The decision model Decider by Perplexity works again, as version 1.2.
- `python -m whybook.demo` names the packages that the demo needs, when one of them is missing.

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
