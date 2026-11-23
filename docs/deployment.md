# Configuration for administrators

An administrator sets Whybook's settings for every user of a Jupyter server with `c.Whybook.<name> = <value>` lines in `jupyter_server_config.py`, or with `--Whybook.<name>=<value>` on the command line of `jupyter lab`. [Configuring a Jupyter Server](https://jupyter-server.readthedocs.io/en/stable/users/configuration.html), in the Jupyter Server documentation, describes that file and the folders where Jupyter looks for it. Whybook shows a setting that the server locks as greyed, with "Fixed on the server:" and the name of the server's setting under it. On JupyterHub, the lines go into the configuration of the users' servers, such as `jupyter_server_config.py` in their image, or into `c.Spawner.args`:

```python
c.Spawner.args = ["--Whybook.openrouter_zdr_only=True", "--Whybook.review_guard=ask"]
```

Nebari runs JupyterHub, so the same applies there.

Whybook masks keys, tokens and passwords in every prompt to a model outside the machine, and no setting turns this off: [Security and privacy](security.md) describes the rules. Keep the keys of model providers out of the environment of the users' servers all the same, since every kernel inherits that environment, and every cell can read it. The AI models panel keeps each user's keys in their own Jupyter data folder instead.

## Scenarios

### One analyst on a laptop

The defaults fit. When the first notebook opens, the screen "Three ways to use models" asks the analyst how the models may read the data, and the AI models panel changes the choice later. With OpenRouter, "Zero data retention (OpenRouter)" is on.

### Data that must stay on the machine

Patient records, personal data or data under contract: local models read the data, and a hosted model writes the code from the names, kinds and sizes of the variables and from what the local models wrote about them.

```python
c.Whybook.way_to_use_models = "data-stays-here"
c.Whybook.review_guard = "reject"
```

No rows of a table, printed outputs or pictures leave the machine, and the review guard holds back what its rules flag in a prompt, without a question. The labels of tables need a local model, `pip install "whybook[local]"`, and a question about a picture cannot be asked.

### Nothing leaves your network

The models run on this machine or on a model server in your network, such as Ollama, LM Studio, llama.cpp or vLLM.

```python
c.Whybook.way_to_use_models = "all-local"
```

Whybook refuses every model whose server has an address outside the machine and its network: the address must be a loopback, private or link-local one, or a host name with only such addresses. Decision models then run only through TypeSafe's API at such an address. The code that a model writes is as good as the local model.

### A team on JupyterHub or Nebari, with OpenRouter

Each user signs in with OpenRouter in the AI models panel, and the key stays in their own data folder.

```python
c.Whybook.openrouter_zdr_only = True
c.Whybook.review_guard = "ask"
c.Whybook.agent_budget_usd = 1.0
```

Every request through OpenRouter goes only to providers that keep neither the prompt nor the answer, not even to detect abuse. Gemini models then cannot answer, and the labels and titles come from the connected model. The review guard asks each user about what its rules flag, and no user can turn it off. An agent's run stops when it passes one US dollar, where the price of the model is known. To keep tables out of the requests for labels, add `c.Whybook.describe_tables = False`: local models still write the labels.

### Teaching and demos without a model

No setting is needed. The questions from templates work without a model, so nothing leaves the machine. [The demo on Binder](https://mybinder.org/v2/gh/openteams-ai/whybook/main?urlpath=lab/tree/examples/pain_diary/pain_diary_cohort.ipynb) runs this way in the browser.

## Settings

The server's settings that decide what leaves the machine, and what the models may cost:

| Setting | Default | What it does |
| --- | --- | --- |
| `way_to_use_models` | `""` | Locks the way to use models for every user: `"remote"`, `"data-stays-here"` or `"all-local"`. Empty, each user chooses. |
| `keep_data_local` | `False` | Keeps the data on this machine for every user, as the setting "Keep data on this machine" does. |
| `openrouter_zdr` | `False` | Turns zero data retention on OpenRouter on for every user. |
| `openrouter_zdr_only` | `False` | Turns zero data retention on for every user, and skips the providers that keep requests to detect abuse (Safety Retention), as OpenRouter's privacy setting "ZDR only" does. |
| `review_guard` | `""` | Locks the mode of the review guard for every user: `"ask"` or `"reject"`. Empty, each user chooses, and Ask is the default. |
| `describe_tables` | `True` | `False` stops the requests for labels and captions to models outside the machine. Local models still write them. |
| `agent_budget_usd` | `2.0` | Stops an agent's run when its cost passes this many US dollars, where the price of the model is known. |
| `agent_max_cells` | `200` | The most cells that one agent's run adds. |
| `agent_max_turns` | `400` | The most turns of one agent's run. |
| `claude_budget_usd` | `0.5` | Stops one call to a model when its cost passes this many US dollars. |
| `claude_code_login` | `False` | Offers Claude with the Claude Code login of the machine. It is for development only: Anthropic's terms do not allow a product to offer that login to its users. |
