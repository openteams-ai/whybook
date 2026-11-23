# User guide

Whybook is a view of a Jupyter notebook in JupyterLab. The analyst drags a variable onto a cell, selects part of a plot, or types a question, and Whybook offers the questions that the analysis could ask next. Questions from templates need no AI model. For a question that needs one, an agent adds and runs the cells of the answer. The notebook stays an ordinary `.ipynb` file.

- [Security and privacy](security.md): what leaves the machine, the providers of the models, and how Whybook keeps keys and passwords out of prompts.
- [Configuration for administrators](deployment.md): the server's settings for a laptop, a team server, data that must stay on the machine, and models that run only in your network.

## Install

Whybook needs Python 3.11 or later, and JupyterLab 4.6.6 or a later 4.x release.

```bash
pip install "whybook[kernel,demo,models]"
jupyter lab
```

The extra `local` adds small AI models that run in the Jupyter server, and `speech` adds spoken questions. When a kernel runs in another environment, install `whybook[kernel]` there too.

## Open a notebook in Whybook

Right-click a notebook in the file browser and choose Open With, then Whybook. With a notebook open in JupyterLab's notebook editor, "Open Notebook in Whybook" in the command palette does the same. A new notebook starts from the Whybook section of the Launcher.

To try Whybook on the demo, write it into a folder and open its notebook:

```bash
python -m whybook.demo pain_diary
jupyter lab pain_diary/pain_diary_cohort.ipynb
```

## Connect a model

The item of the status bar that starts with "AI:" opens the AI models panel. Connect a model there: OpenRouter after a sign-in, a Hugging Face access token, an API key of Anthropic, OpenAI, Google or Mistral AI, or a model server on this machine, such as Ollama. When the first notebook opens, the screen "Three ways to use models" asks how the models may read the data, and [Security and privacy](security.md) describes each way.

## Settings

The AI models panel holds the settings that decide what leaves the machine: "Keep data on this machine", "Zero data retention (OpenRouter)", "Allow Safety Retention (OpenRouter)", the review guard, and the model of each task. Every setting is also in JupyterLab's Settings Editor, under Whybook. An administrator can lock some of them for every user, as [Configuration for administrators](deployment.md) describes.

## Get help

Report a problem or ask a question in [the issues](https://github.com/openteams-ai/whybook/issues). Report a security problem privately, as [the security policy](https://github.com/openteams-ai/whybook/blob/main/.github/SECURITY.md) describes.
