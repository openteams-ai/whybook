"""Keys, tokens and passwords masked out of what goes to a model on another machine (masking.py).

The samples of keys are built from parts, so that no file of the repository
holds a string that a scanner of secrets reports.
"""

import json
import os
import types

import pytest

from whybook.server import agent, connection, decision_models, guard, masking, model_client
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore

from .test_agent import drive, request

OPENROUTER = Connection(provider="openrouter", model="openai/gpt-6")


@pytest.fixture(autouse=True)
def server(monkeypatch):
    """No token or root folder of a Jupyter server that an earlier test started, and no secret of the developer's environment.

    A failed assertion would print such a secret, and each test sets the variables it reads.
    """
    monkeypatch.setattr(masking, "_server", {})
    for name in list(os.environ):
        if masking.secret_name(name):
            monkeypatch.delenv(name)


def masked(text, known=None):
    return masking.Masker(known or {}).text(text)[0]


# Rule 1: known values


def test_an_environment_variable_named_as_a_secret_is_masked_wherever_its_value_appears(monkeypatch):
    monkeypatch.setenv("DB_PASSWORD", "hunter2-hunter2")
    masker = masking.Masker.for_config(Whybook())
    assert masker.text("connected as analyst with hunter2-hunter2\nok") == ("connected as analyst with [secret: DB_PASSWORD]\nok", 1)


@pytest.mark.parametrize(
    "name",
    [
        "OPENAI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "PGPASSWORD",
        "JUPYTERHUB_API_TOKEN",
        "SNAP_COOKIE",
        "SENTRY_DSN",
        "AZURE_STORAGE_CONNECTION_STRING",
        "dbPassword",
        "access_token",
        "basic_auth",
        "api_key_2",
        "X-API-Key",
    ],
)
def test_names_that_end_as_a_secret_s_name_hold_secrets(name):
    assert masking.secret_name(name)


@pytest.mark.parametrize(
    "name",
    ["PWD", "OLDPWD", "MAX_TOKENS", "SSH_AUTH_SOCK", "GPG_KEY", "AWS_ACCESS_KEY_ID", "auth_seq_id", "token_type", "TOKEN_FILEPATH", "password_hash", "sort_key", "author"],
)
def test_names_with_a_secret_s_word_before_their_end_hold_none(name):
    assert not masking.secret_name(name)


def test_a_word_is_masked_only_where_its_name_stands(monkeypatch):
    # Masked everywhere, "password" would also mask the name of the variable in the code.
    monkeypatch.setenv("DB_PASSWORD", "password")
    masker = masking.Masker.for_config(Whybook())
    assert masker.text("password = os.environ['DB_PASSWORD']") == ("password = os.environ['DB_PASSWORD']", 0)
    assert masker.text("DB_PASSWORD=password") == ("DB_PASSWORD=[secret: DB_PASSWORD]", 1)


def test_a_path_to_a_file_of_secrets_is_not_masked(monkeypatch, tmp_path):
    path = tmp_path / "service-account.json"
    path.write_text("{}")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(path))
    assert masking.Masker.for_config(Whybook()).text(f"reading {path}") == (f"reading {path}", 0)


def test_the_keys_of_the_ai_models_panel_are_masked():
    KeyStore().set("mistral", "mstrl-A1b2C3d4E5f6", signin="typed")
    assert masking.Masker.for_config(Whybook()).text("401 for mstrl-A1b2C3d4E5f6") == ("401 for [secret: mistral key]", 1)


def test_the_jupyter_server_s_token_is_masked():
    masking.register("0123456789abcdef0123456789abcdef", None)
    assert masking.Masker.for_config(Whybook()).text("the token is 0123456789abcdef0123456789abcdef") == ("the token is [secret: Jupyter token]", 1)


def test_the_secrets_of_the_dotenv_file_in_the_server_s_root_are_masked(tmp_path):
    (tmp_path / ".env").write_text('# keys\nexport HF_TOKEN="tok-A1b2C3d4E5f6"\nDEBUG=1\nDATA_DIR=data\n')
    masking.register(None, str(tmp_path))
    assert masking.known_values() == {"tok-A1b2C3d4E5f6": "HF_TOKEN"}


def test_typesafe_s_key_is_masked():
    config = Whybook(typesafe_api_key="ts-A1b2C3d4E5f6")
    assert masking.Masker.for_config(config).text("key ts-A1b2C3d4E5f6") == ("key [secret: TypeSafe key]", 1)


def test_a_value_is_masked_as_a_json_string_holds_it():
    known = {'ab"cd\\1234': "SECRET_X"}
    assert masked(json.dumps({"output": 'ab"cd\\1234'}), known) == '{"output": "[secret: SECRET_X]"}'


# Rule 2: documented formats

HEX = "0123456789abcdef"
FORMATS = [
    ("OpenRouter key", "sk-or-v1-" + HEX * 4),
    ("Anthropic key", "sk-ant-api03-" + "Ab1-" * 10),
    ("OpenAI key", "sk-proj-" + "Ab1_" * 6),
    ("API key", "sk-" + "a1B2" * 6),
    ("AWS access key", "AKIA" + "ABCDEFGHIJ234567"),
    ("GitHub token", "ghp_" + "A1b2" * 9),
    ("GitHub token", "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1" + "_" + "x" * 59),
    ("GitLab token", "glpat-" + "A1b2C3d4E5f6G7h8I9j0"),
    ("Google API key", "AIza" + "A1b2C3d4E5" * 3 + "F6g7H"),
    ("Google OAuth secret", "GOCSPX-" + "A1b2C3d4E5f6G7h8I9j0K1l2"),
    ("Google OAuth token", "ya29." + "A1b2C3d4E5f6G7h8I9j0"),
    ("Stripe key", "sk" + "_live_" + "A1b2C3d4E5f6G7h8"),
    ("Slack token", "xox" + "b-" + "123456789012-" + "A1b2C3d4E5"),
    ("Slack webhook", "https://hooks.slack.com/services/" + "T00000000/B00000000/" + "X" * 24),
    ("npm token", "npm_" + "A1b2C3d4E5f6" * 3),
    ("PyPI token", "pypi-AgEIcHlwaS5vcmc" + "A1b2" * 13),
    ("SendGrid key", "SG." + "A1b2C3d4E5f6G7h8I9j0K1" + "." + "A1b2C3d4E5f6G7h8I9j0K1l2"),
    ("Hugging Face token", "hf_" + "A1b2C3d4E5" * 3 + "F6g7"),
    ("Databricks token", "dapi" + HEX * 2),
    ("Atlassian token", "ATATT3" + "xFfGF0" * 4),
    ("Doppler token", "dp.pt." + "A1b2C3d4E5f6G7h8I9j0K1"),
    ("Linear key", "lin_api_" + "A1b2C3d4" * 5),
    ("Shopify token", "shpat_" + HEX * 2),
    ("DigitalOcean token", "dop_v1_" + HEX * 4),
    ("Telegram bot token", "123456789:AA" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
    ("age key", "AGE-SECRET-KEY-1" + "QWERTYUIOPASDFGHJKLZXCVBNM234567" + "QWERTYUIOPASDFGHJKLZXCVBNM"),
    ("JSON web token", "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "A1b2C3d4E5f6G7h8"),
    ("extended private key", "xprv" + "9s21ZrQH143K" * 9),
    ("private key", "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END " + "PRIVATE KEY-----"),
]


@pytest.mark.parametrize(("label", "sample"), FORMATS, ids=[f"{label} {index}" for index, (label, _) in enumerate(FORMATS)])
def test_a_key_of_a_documented_format_is_masked(label, sample):
    assert masked(f"result: {sample} (cached)") == f"result: [secret: {label}] (cached)"


def test_a_private_key_block_is_masked_in_the_json_of_a_prompt():
    block = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nAbCdEf==\n-----END " + "RSA PRIVATE KEY-----\n"
    assert masked(json.dumps({"outputs": block})) == '{"outputs": "[secret: private key]\\n"}'


@pytest.mark.parametrize(
    "text",
    [
        "sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'",
        "id = '123e4567-e89b-12d3-a456-426614174000'",
        "https://user@example.com/path",
        "S20240115A00123456789",
    ],
)
def test_hashes_ids_and_urls_without_a_password_are_not_masked(text):
    assert masked(text) == text


# Rule 3: names


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('password = "Tr0ub4dor&3"', 'password = "[secret: password]"'),
        ("connect(user='sa', password='pw')", "connect(user='sa', password='[secret: password]')"),
        ('{"api_key": "abc-123-def"}', '{"api_key": "[secret: api_key]"}'),
        ('api_key <- "r-secret-1234"', 'api_key <- "[secret: api_key]"'),
        ('os.environ["HF_TOKEN"] = "tok-1234"', 'os.environ["HF_TOKEN"] = "[secret: HF_TOKEN]"'),
        ("HOME=/home/u\nDB_PASSWORD=hunter2hunter2\nLANG=C", "HOME=/home/u\nDB_PASSWORD=[secret: DB_PASSWORD]\nLANG=C"),
        ('"Driver={SQL Server};Server=db;Uid=sa;Pwd=Summer2026!;"', '"Driver={SQL Server};Server=db;Uid=sa;Pwd=[secret: Pwd];"'),
        ("AccountName=acct;AccountKey=AbC+dEf/123==;EndpointSuffix=core", "AccountName=acct;AccountKey=[secret: AccountKey];EndpointSuffix=core"),
        ("create_engine('postgresql://analyst:pw@db.internal/sales')", "create_engine('postgresql://analyst:[secret: password in a URL]@db.internal/sales')"),
        ("get('https://api.example.com/data?api_key=abc123DEF456&page=2')", "get('https://api.example.com/data?api_key=[secret: api_key]&page=2')"),
        ("Authorization: Basic YWRtaW46V2ludGVyMjAyNg==", "Authorization: Basic [secret: Authorization]"),
        ("headers = {'Authorization': 'Bearer abcdefghijklmnop123'}", "headers = {'Authorization': 'Bearer [secret: Authorization]'}"),
        ('curl -H "X-API-Key: A1b2C3d4E5f6" https://x', 'curl -H "X-API-Key: [secret: X-API-Key]" https://x'),
    ],
)
def test_a_secret_is_masked_where_its_name_stands(text, expected):
    assert masked(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "password = getpass()",
        'PASSWORD=os.environ.get("X")',
        'password = f"{pw}"',
        'password = "${DB_PASSWORD}"',
        'if token == "the":',
        "connect(\n    token=token\n)",
        "headers = {'hibp-api-key': HIBP_KEY}",
        'max_tokens = "512"',
        'auth_seq_id = "_pdbx_poly_seq_scheme.auth_seq_id"',
        "PWD=/home/analyst/project",
    ],
)
def test_code_that_reads_a_secret_from_elsewhere_is_not_masked(text):
    assert masked(text) == text


def test_the_rules_read_the_json_of_a_prompt():
    prompt = json.dumps({"cells": [{"code": 'password = "Tr0ub4dor&3"\nengine = connect(password)'}]})
    assert json.loads(masked(prompt))["cells"][0]["code"] == 'password = "[secret: password]"\nengine = connect(password)'


def test_a_secret_found_in_code_is_masked_where_an_output_prints_it():
    prompt = json.dumps({"cells": [{"code": 'token = "zq9-ABC-777"', "outputs": "zq9-ABC-777"}]})
    masker = masking.Masker({})
    text, count = masker.text(prompt)
    assert json.loads(text)["cells"][0] == {"code": 'token = "[secret: token]"', "outputs": "[secret: token]"}
    assert count == 1
    # Later in the same run, a result that prints it.
    assert masker.text("zq9-ABC-777 again") == ("[secret: token] again", 1)


def test_masking_a_masked_text_gives_the_same_text():
    once = masked('password = "Tr0ub4dor&3"\nDB_PASSWORD=hunter2hunter2\nsk-or-v1-' + HEX * 4)
    assert masking.Masker({}).text(once) == (once, 0)


# Where the requests go


@pytest.fixture
def sent(monkeypatch):
    """The prompts that structured calls send to the connected model, OpenRouter, from a fake call."""
    prompts = []

    async def by_pydantic(chosen, key, prompt, **options):
        prompts.append(prompt)
        yield {"type": "result", "output": {}, "model": chosen.model, "cost_usd": None}

    monkeypatch.setattr(model_client, "structured_call", by_pydantic)
    connection.save(OPENROUTER)
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    return prompts


async def structured(prompt, config=None):
    return [event async for event in connection.structured_call(prompt, schema={}, system_prompt="s", config=config or Whybook(), effort="low")]


async def test_a_structured_call_sends_the_prompt_masked(sent):
    await structured('password = "Tr0ub4dor&3"')
    assert sent == ['password = "[secret: password]"']


async def test_a_structured_call_says_how_many_secrets_were_masked(sent):
    found = await structured('password = "Tr0ub4dor&3"')
    assert found[0] == {"type": "progress", "stage": "guard", "message": "1 secret masked before the request left this machine", "elapsed": 0.0}


async def test_the_review_guard_reads_the_masked_prompt(sent, monkeypatch):
    read = []

    async def check_prompt(text, settings, emit, to, what="a prompt", threads=4):
        read.append(text)
        return guard.Outcome(True, text)

    monkeypatch.setattr(guard, "check_prompt", check_prompt)
    await structured('password = "Tr0ub4dor&3"', connection.for_request(Whybook(), {"guard": {"mode": "ask"}}))
    assert read == ['password = "[secret: password]"']


async def test_a_model_on_this_machine_gets_the_prompt_unmasked(sent):
    connection.save(Connection(provider="ollama", model="llama", local=True))
    await structured('password = "Tr0ub4dor&3"')
    assert sent == ['password = "Tr0ub4dor&3"']


async def run_with_secret_in_the_cell():
    """An agent's run on a question about a cell that holds a password: the prompt that the agent read, and the run's events."""
    seen = []

    async def driver(run, asked, config):
        seen.append(asked.prompt())
        return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": "m", "cost_usd": None}

    asked = request(cell={"label": "[1]", "source": 'engine = connect(password="Tr0ub4dor&3")'})
    found = [event async for event in agent.run_events(asked, Whybook(), driver)]
    return seen[0], found


async def test_an_agent_reads_the_question_and_the_notebook_masked():
    prompt, _ = await run_with_secret_in_the_cell()
    assert json.loads(prompt)["cell"]["source"] == 'engine = connect(password="[secret: password]")'


async def test_an_agent_s_run_says_how_many_secrets_its_question_held():
    _, found = await run_with_secret_in_the_cell()
    assert masking.progress(1) in found


async def run_printing_the_environment(monkeypatch):
    """An agent's run whose one cell prints the kernel's environment, which holds a password: the run's events."""
    monkeypatch.setenv("DB_PASSWORD", "hunter2-hunter2")
    steps = [("run_cell", {"title": "Environment", "code": "print(os.environ)"}), ("finish", {"answer": "done"})]
    results = [{"status": "ok", "cell": "[2]", "outputs": [{"kind": "text", "text": "{'DB_PASSWORD': 'hunter2-hunter2', 'LANG': 'C'}"}]}]
    return await drive(agent.run_events(request(), Whybook(), agent.scripted(steps)), results)


async def test_a_tool_result_reaches_the_agent_masked(monkeypatch):
    found = await run_printing_the_environment(monkeypatch)
    assert found[-1]["results"][0]["outputs"][0]["text"] == "{'DB_PASSWORD': '[secret: DB_PASSWORD]', 'LANG': 'C'}"


async def test_an_agent_s_run_says_how_many_secrets_a_tool_result_held(monkeypatch):
    assert masking.progress(1) in await run_printing_the_environment(monkeypatch)


async def test_a_decision_model_gets_the_request_masked():
    KeyStore().set("openrouter", "sk-or-v1-" + "0" * 32, signin="openrouter")
    posted = []

    async def openrouter(url, **options):
        posted.append(json.loads(options["body"]))
        answer = {"type": "choice", "choice": "descriptive", "probabilities": {"descriptive": 0.9, "causal": 0.1}}
        return types.SimpleNamespace(body=json.dumps({"answers": {"type": answer}, "usage": {"cost": 0.0}}).encode())

    asked = {
        "state": {"question": "Why does the load fail?", "cell": "engine = create_engine('postgresql://analyst:pw@db/sales')"},
        "questions": {"type": {"type": "choice", "instructions": "Which type?", "criteria": {"descriptive": "Describes", "causal": "Asks why"}}},
    }
    await decision_models.ask(decision_models.model_of("decision:clef"), asked, Whybook(), openrouter)
    assert posted[0]["state"]["cell"] == "engine = create_engine('postgresql://analyst:[secret: password in a URL]@db/sales')"
