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
            "What ranks the candidate questions. 'heuristic' runs offline with no"
            " external service. 'jev' sends the candidates to TypeSafe Jev through"
            " the Cloudflare AI REST API and falls back to 'heuristic' on failure."
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
        8,
        help="The most cells an agent adds for one question, branches included.",
    ).tag(config=True)

    agent_max_turns = Int(
        30,
        help="The most turns of one agent run: each tool call and its answer is one.",
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

    jev_account_id = Unicode(help="Cloudflare account id for Jev.").tag(config=True)

    jev_api_token = Unicode(help="Cloudflare API token for Jev.").tag(config=True)

    jev_model = Unicode("typesafe/jev", help="Model name in the Cloudflare catalogue.").tag(
        config=True
    )

    jev_timeout = Float(10.0, help="Seconds to wait for Jev before falling back.").tag(
        config=True
    )

    @default("jev_account_id")
    def _default_jev_account_id(self):
        return os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")

    @default("jev_api_token")
    def _default_jev_api_token(self):
        return os.environ.get("CLOUDFLARE_API_TOKEN", "")

    @property
    def jev_configured(self) -> bool:
        return bool(self.jev_account_id and self.jev_api_token)

    typesafe_api_key = Unicode(
        help=(
            "TypeSafe API key for Jev, which can sort the questions the analyst types."
            " The TYPESAFE_API_KEY environment variable by default."
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
