"""Server-side settings, set with ``c.Whybook.<name>`` in ``jupyter_server_config.py``."""

import os

from traitlets import Bool, Enum, Float, Int, Unicode, default
from traitlets.config import Configurable

EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]


class Whybook(Configurable):
    """Settings for question ranking and for the calls to Claude."""

    question_ranker = Enum(
        ["heuristic", "jev"],
        default_value="heuristic",
        help=(
            "Reported in the server's status. The rules rank the candidate questions,"
            " and the model chosen under Question order in the settings orders them again."
        ),
    ).tag(config=True)

    claude_code_login = Bool(
        help=(
            "Offer Claude with the Claude Code login on this machine, for development only:"
            " Anthropic's terms do not allow a product to offer that login to its users."
            " Off by default; turn it on with --Whybook.claude_code_login=True, or with the"
            " WHYBOOK_CLAUDE_CODE_LOGIN environment variable set to 1."
        ),
    ).tag(config=True)

    @default("claude_code_login")
    def _default_claude_code_login(self):
        return os.environ.get("WHYBOOK_CLAUDE_CODE_LOGIN", "").lower() in ("1", "true", "yes")

    claude_model = Unicode(
        None,
        allow_none=True,
        help="Model for calls to Claude. None uses the default model of the Claude Code CLI.",
    ).tag(config=True)

    claude_cli_path = Unicode(
        None,
        allow_none=True,
        help="Claude Code CLI to run. None uses the CLI bundled with claude-agent-sdk.",
    ).tag(config=True)

    claude_budget_usd = Float(
        0.5,
        help=(
            "Stop one call to Claude when its cost passes this many US dollars."
            " With a subscription login the cost is notional, but the limit still"
            " stops a runaway call."
        ),
    ).tag(config=True)

    question_effort = Enum(
        EFFORT_LEVELS,
        default_value="low",
        help="Effort level when Claude suggests questions.",
    ).tag(config=True)

    solve_effort = Enum(
        EFFORT_LEVELS,
        default_value="medium",
        help="Effort level when Claude writes a cell that answers a question.",
    ).tag(config=True)

    describe_tables = Bool(
        True,
        help=(
            "Ask Claude for labels and captions: a description of one to three words"
            " and a headline for the tables that the bench shows as tiles, and a"
            " summary of a data frame in Contents. A table goes as the notebook"
            " displays it, cut to 3,000 characters, with the code of its cell; a"
            " frame goes as its name, size and first 60 column names and types."
            " False turns these requests to Claude off for every user of the server;"
            " a local model, which keeps the data on the machine, still runs."
        ),
    ).tag(config=True)

    openrouter_zdr = Bool(
        False,
        help=(
            "Send requests through OpenRouter only to providers that keep neither the prompt"
            " nor the answer (zero data retention), for every user of the server. A model"
            " with no such provider then refuses the request. When True, the setting shows"
            " as fixed in Whybook; when False, each user chooses with the setting 'Zero"
            " data retention (OpenRouter)', which is on unless the user turns it off."
        ),
    ).tag(config=True)

    zero_data_retention = Bool(
        True,
        help=(
            "Zero data retention for the calls of one request, as the user's setting chose"
            " it: a route's copy of this config turns it off for a request that says so"
            " (connection.for_request). Not a setting of the server: openrouter_zdr pins it."
        ),
    )

    @property
    def zdr(self) -> bool:
        """Whether requests through OpenRouter go only to providers that keep no data: the server pins it, or the request asks for it."""
        return self.openrouter_zdr or self.zero_data_retention

    task_model = Unicode(
        "remote",
        help=(
            "The remote model of the task of one request, as the user's settings chose it:"
            " 'remote' for the connected model, a tier such as 'remote:fast', or a model of"
            " the connected provider (tiers.py). A route's copy of this config holds it"
            " (connection.for_request). Not a setting of the server."
        ),
    )

    huggingface_client_id = Unicode(
        help=(
            "The client id of Whybook's Hugging Face OAuth app, a public app (no secret) with"
            " the inference-api scope, for 'Sign in with Hugging Face' with a device code. The"
            " WHYBOOK_HUGGINGFACE_CLIENT_ID environment variable by default. Without it, the AI"
            " models panel takes a Hugging Face access token instead. No other application's"
            " client id is used."
        ),
    ).tag(config=True)

    @default("huggingface_client_id")
    def _default_huggingface_client_id(self):
        return os.environ.get("WHYBOOK_HUGGINGFACE_CLIENT_ID", "")

    agent_max_cells = Int(
        200,
        help=(
            "The most cells that one agent run adds, in every notebook, branches included: a guard"
            " against a run that goes wrong, such as one that adds cells in a loop. The prompt asks"
            " the agent for fewer than 4 cells in most answers, and the analyst's setting"
            " agentMaxCells can set a lower limit."
        ),
    ).tag(config=True)

    agent_max_turns = Int(
        400,
        help=(
            "The most turns of one agent run, each tool call and its answer one: a guard against a"
            " run that goes wrong. A run that writes an analysis again in another language takes a"
            " turn for each of its cells."
        ),
    ).tag(config=True)

    agent_budget_usd = Float(
        2.0,
        help=(
            "Stop an agent run when its cost passes this many US dollars. A run makes"
            " several calls, so it has a cap of its own, above claude_budget_usd."
        ),
    ).tag(config=True)

    agent_effort = Enum(
        EFFORT_LEVELS,
        default_value="medium",
        help="Effort level when an agent answers a question with several cells.",
    ).tag(config=True)

    keep_data_local = Bool(
        False,
        help=(
            "Keep the data on this machine for every user of the server: only local"
            " models read outputs and variables, and the remote model and Jev get"
            " names, kinds and the local models' descriptions, and write code. No"
            " values, tables, printed outputs or pictures leave the machine. When"
            " True, the setting shows as fixed in Whybook; when False, each user"
            " chooses with the setting 'Keep data on this machine'."
        ),
    ).tag(config=True)

    way_to_use_models = Enum(
        ["", "remote", "data-stays-here", "all-local"],
        default_value="",
        help=(
            "Set the way to use models for every user, so that Whybook does not ask"
            " with its screen 'Three ways to use models'. 'remote': a hosted model"
            " reads what each task needs and writes the code. 'data-stays-here': only"
            " models on this machine read outputs and variables, as with"
            " keep_data_local = True, and a hosted model writes the code. 'all-local':"
            " the data stays as with 'data-stays-here', and the server refuses every"
            " model that does not run on this machine or in its network: a model"
            " server whose address is a loopback, private or link-local one, or a host"
            " name with only such addresses (network.py). When empty, each user"
            " chooses on that screen or in the settings."
        ),
    ).tag(config=True)

    @property
    def data_stays_here(self) -> bool:
        """Whether the data stays on this machine for every user: keep_data_local, or a way to use models that keeps it here."""
        return self.keep_data_local or self.way_to_use_models in ("data-stays-here", "all-local")

    @property
    def network_only(self) -> bool:
        """Whether the server refuses every model that does not run on this machine or in its network."""
        return self.way_to_use_models == "all-local"

    review_guard = Enum(
        ["", "ask", "reject"],
        default_value="",
        help=(
            "Fix the mode of the review guard for every user: 'ask' or 'reject'. The"
            " guard checks each prompt before it goes to a model on another machine,"
            " and code that a model wrote before it runs. When empty, each user"
            " chooses with the setting 'Review guard', which can also turn it off."
        ),
    ).tag(config=True)

    local_threads = Int(
        4,
        help=(
            "CPU threads for a local model. On an 8-core virtual machine, 4 were"
            " the fastest: research/local-models.md."
        ),
    ).tag(config=True)

    describe_effort = Enum(
        EFFORT_LEVELS,
        default_value="low",
        help="Effort level when Claude describes tables.",
    ).tag(config=True)

    decision_timeout = Float(
        10.0, help="Seconds to wait for a decision model (decision_models.py) before the view keeps the rules' answer."
    ).tag(config=True)

    typesafe_api_key = Unicode(
        help=(
            "TypeSafe API key, for Jev through TypeSafe's own API when the AI models panel holds no"
            " OpenRouter key (decision_models.py). The TYPESAFE_API_KEY environment variable by default."
        )
    ).tag(config=True)

    typesafe_base_url = Unicode(
        help="The TypeSafe API: TYPESAFE_BASE_URL, or https://api.typesafe.ai."
    ).tag(config=True)

    typesafe_model = Unicode(
        help="The Jev model of the TypeSafe API: TYPESAFE_DEFAULT_MODEL, or jev-latest."
    ).tag(config=True)

    @default("typesafe_api_key")
    def _default_typesafe_api_key(self):
        return os.environ.get("TYPESAFE_API_KEY", "")

    @default("typesafe_base_url")
    def _default_typesafe_base_url(self):
        return os.environ.get("TYPESAFE_BASE_URL") or "https://api.typesafe.ai"

    @default("typesafe_model")
    def _default_typesafe_model(self):
        return os.environ.get("TYPESAFE_DEFAULT_MODEL") or "jev-latest"
