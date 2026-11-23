# Security and privacy

Nothing leaves the machine until a model outside it is connected in the AI models panel. Questions from templates need no model. [Every use of AI in Whybook](https://whybook.dev/#ai-uses) lists what each task sends.

## What leaves the machine

The screen "Three ways to use models" asks how the models may read the data when the first notebook opens:

| Way | What leaves the machine |
| --- | --- |
| Frontier models for everything | The code of the cells, tables, pictures and variables, as each task needs them. |
| Data stays on this machine | Descriptions, code, questions and the text of markdown cells. Never the rows of a table, a printed output or a picture. |
| All local | Nothing, when the model that writes the code runs on this machine. With a model server in your network, its prompts go there and no further. |

The setting "Keep data on this machine" in the AI models panel gives the second way: only models on this machine read outputs and variables. A model outside the machine then gets the names, kinds and sizes of the variables, and what the local models wrote about the data. The labels of tables then need a local model, and a question about a picture cannot be asked.

## Keys, tokens and passwords in prompts

Whybook masks secrets in every prompt before it goes to a model outside the machine, whatever the mode of the review guard. A secret becomes `[secret: <name>]`, so that code that the model writes reads it from where it is kept, such as `os.environ["DB_PASSWORD"]`. The notebook does not change: only what leaves the machine is masked. When a prompt held secrets, the progress line of the request says how many were masked.

Three rules are used to find a secret:

1. A value that the server knows: the value of an environment variable whose name ends as a secret's name does, such as `OPENAI_API_KEY`, `PGPASSWORD` or `JUPYTERHUB_API_TOKEN`, a key of the AI models panel, the Jupyter server's token, and a secret of the `.env` file in the server's root folder. A kernel starts with the server's environment, so these are also the kernel's values.
2. A documented format of a key, such as an OpenRouter, Anthropic or OpenAI key, an AWS access key, a GitHub token, a Hugging Face token, a Slack webhook or a private key block.
3. A name: a string assigned or passed to a secret's name, a line `NAME=value` of such a name, a password in a URL or in a connection string, a key in a query parameter of a URL, and the credentials of an `Authorization` header.

For example, the code of a cell goes to the model like this:

```python
# In the notebook
engine = create_engine("postgresql://analyst:Summer2026!@db.internal/sales")
client = OpenAI(api_key="sk-proj-...")

# In the prompt
engine = create_engine("postgresql://analyst:[secret: password in a URL]@db.internal/sales")
client = OpenAI(api_key="[secret: api_key]")
```

A secret that rule 2 or 3 finds is also masked wherever else it appears in the same request, or later in the same agent's run, such as an output that prints it.

These secrets reach a model unmasked:

- A secret that only the kernel holds and that has no name or format that the rules know, such as a password that a cell reads with `getpass()` and then prints.
- A secret shorter than 8 characters, or of letters only and shorter than 16, except where its name stands. Masked everywhere, a word such as `password` would also change the code's own words.
- The text in a picture.
- Any prompt to a model that runs on this machine, since that prompt does not leave it.

The Variables panel lists a string that looks like a key, a token or a password with its length only, and never sends its text to a model.

## Keys of the model providers

The keys and sign-ins of the AI models panel are in one file, `keys.json`, in Whybook's folder of Jupyter's data folder (`jupyter --data-dir`). Only the user can read the file. The keys never go into JupyterLab's settings, which the browser holds, nor into the server's environment, which every kernel inherits, and the browser never receives a key.

## Zero data retention on OpenRouter

OpenRouter sends each request to one of the companies that serve the model. With "Zero data retention (OpenRouter)" on, the default, Whybook asks OpenRouter to send it only to those that keep neither the prompt nor the answer, and the list of models leaves out a model that no such company serves.

Some of these companies keep the prompt and the answer to detect abuse, which OpenRouter calls Safety Retention: Google does so for its Gemini models on Vertex. "Allow Safety Retention (OpenRouter)" is on by default, as Safety Retention is for a self-serve OpenRouter account. With it off, Whybook skips those companies, and a model that only they serve cannot answer. The labels and titles, whose default model is Gemini 3.5 Flash-Lite, then come from the connected model.

Your OpenRouter account has privacy settings of its own, which apply to every request of your key, from Whybook or from anywhere else:

- In Settings, Privacy, the choice "ZDR only" for Google models and for all other models leaves out Safety Retention for every request.
- OpenRouter stores prompts and answers only when you turn its logging of them on.
- A guardrail with the Sensitive Info preset "Secrets" set to Redact replaces keys of common formats in prompts, before the provider receives them. OpenRouter itself still receives the key.

OpenRouter's lists give what OpenRouter knows of each company's policy. Whybook cannot check whether a company keeps to it.

## The review guard

The review guard reads every prompt before it goes to a model outside the machine, for identifiers, personal details, small counts and keys. It also reads the code that a model wrote before it runs, for network access, reading secrets, deleting files and other risky steps. Its mode decides what happens to what it flags:

- Ask shows what the guard flagged, and waits for your answer.
- Reject holds back what the guard flagged, and the work goes on.
- None checks nothing.

A guard model on this machine can also read the prompts and the code, in addition to the rules. You choose the mode in the AI models panel, and an administrator can lock it for every user with `c.Whybook.review_guard`.

## The sandboxed kernel

The kernel "Python 3 (sandboxed)" sees the notebook's folder and no network, under bubblewrap on Linux and Seatbelt on macOS, and holds no secrets in its environment. `python -m whybook.sandbox <kernel name>` makes a sandboxed copy of another kernel, such as R. The review guard asks about less in the sandbox, since code there cannot reach the network or the files outside the folder.

## Report a security problem

Report a security problem privately, never in a public issue, as [the security policy](https://github.com/openteams-ai/whybook/blob/main/.github/SECURITY.md) describes.
