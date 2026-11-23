"""Keys, tokens and passwords masked out of what goes to a model on another machine.

Every request to a remote model passes here before the review guard reads
it, whatever the guard's mode: ``connection.structured_call``, the question
and each tool result of an agent's run (``agent.run_events``, ``Run.call``),
and a decision model's request (``decision_models.ask``). Three rules find a
secret:

1. A known value: the value of an environment variable of the server whose
   name is a secret's (``secret_name``: OPENAI_API_KEY and PGPASSWORD, not
   PWD or MAX_TOKENS), a key or a refresh token of the AI models panel
   (keystore.py), the Jupyter server's token, TypeSafe's key, and a secret of
   the ``.env`` file in the server's root folder. A kernel starts with the
   server's environment, so these are also the kernel's values.
2. A documented format, by its prefix and length (``FORMATS``): an
   OpenRouter key, a GitHub token, a private key block and others.
3. A name: a string literal assigned or passed to a secret's name
   (``password = "..."``), a line ``NAME=value`` of such a name, a password
   in a URL or in a connection string (``Pwd=...;``), a query parameter
   (``?api_key=...``) and the credentials of an ``Authorization`` header.

Each secret becomes ``[secret: <name>]``, so that code written from the
prompt reads it from where it is kept, such as ``os.environ["DB_PASSWORD"]``.
A secret that rule 2 or 3 finds is masked wherever else it appears in the
same request, or later in the same agent's run, such as an output that
prints it, when it is distinct enough (``_distinct``): a word such as
"password" is masked only where its name stands. The masks do not reach the
analyst's notebook, only what leaves the machine.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

# The shortest value that is masked wherever it appears: a shorter one would also mask ordinary words.
# Rule 3 masks a value of any length where its name stands.
MIN_KNOWN = 8

PLACEHOLDER = "[secret: {}]"

# What the server extension registers when it starts (__init__.py): the token and the root folder of the Jupyter server.
_server: dict[str, str] = {}


def register(token: str | None, root_dir: str | None) -> None:
    """Keep the Jupyter server's token, a known value, and its root folder, where a ``.env`` file may hold secrets."""
    _server.clear()
    if token:
        _server["token"] = token
    if root_dir:
        _server["root_dir"] = root_dir


# The names of secrets, for every rule: the last part of the name, after any
# number at its end, is one of SECRET_WORDS or ends with one of SECRET_ENDINGS,
# or the last two parts are a kind of key and KEY: OPENAI_API_KEY,
# AWS_SECRET_ACCESS_KEY, PGPASSWORD, dbPassword, access_token, basic_auth.
# A word before the end does not count, so that auth_seq_id, token_type,
# TOKEN_FILEPATH and password_hash are not secrets' names.
SECRET_WORDS = frozenset(
    {"TOKEN", "SECRET", "SECRETS", "PASSWORD", "PASSWORDS", "PASSWD", "PASS", "PWD", "APIKEY", "CREDENTIAL", "CREDENTIALS", "COOKIE", "DSN", "AUTH"}
)
SECRET_ENDINGS = ("TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY")
KEY_KINDS = frozenset(
    {"API", "ACCESS", "SECRET", "PRIVATE", "SERVICE", "MASTER", "ENCRYPTION", "SIGNING", "ACCOUNT", "AUTH", "CLIENT", "APP", "SESSION", "LICENSE"}
)
# The current and the previous folder of a shell: PWD is a secret's word in DB_PWD.
NOT_SECRETS = frozenset({"PWD", "OLDPWD"})
NAME_PARTS = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")


def secret_name(name: str) -> bool:
    """Whether a variable, a key or a field of this name holds a secret."""
    if name.upper() in NOT_SECRETS:
        return False
    parts = [part.upper() for part in NAME_PARTS.findall(name)]
    while parts and parts[-1].isdigit():
        parts.pop()
    if not parts:
        return False
    if parts[-1] in SECRET_WORDS or parts[-1].endswith(SECRET_ENDINGS):
        return True
    return len(parts) > 1 and ((parts[-2] in KEY_KINDS and parts[-1] == "KEY") or (parts[-2], parts[-1]) == ("CONNECTION", "STRING"))


def _secret_value(value: str, minimum: int = 1) -> bool:
    """Whether a value found by a rule can be a secret: long enough, and not a placeholder, a template or a file's path."""
    if len(value) < minimum or "[secret:" in value or value.startswith(("[", "$", "{", "<", "%(", "*")):
        return False
    # A path names a file of secrets, such as GOOGLE_APPLICATION_CREDENTIALS: the path is not one.
    return not (os.path.isabs(value) and os.path.exists(value))


def _distinct(value: str) -> bool:
    """Whether a secret can be masked wherever it appears: a word such as "password" would also mask the code's own words."""
    return _secret_value(value, MIN_KNOWN) and (not value.isalpha() or len(value) >= 16)


def _dotenv(folder: str | None) -> dict[str, str]:
    """The secrets of the ``.env`` file in a folder, by value: its lines ``NAME=value`` whose name is a secret's."""
    if not folder:
        return {}
    try:
        with open(os.path.join(folder, ".env"), encoding="utf-8") as handle:
            lines = handle.read(1_000_000).splitlines()
    except (OSError, UnicodeDecodeError):
        return {}
    found = {}
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export ") :]
        if line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip().strip("'\"")
        if secret_name(name) and _distinct(value):
            found.setdefault(value, name)
    return found


def known_values(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Rule 1: each secret that the server holds, by value, with the name that its placeholder gives."""
    from .keystore import SECRETS, KeyStore, read_json

    found: dict[str, str] = {}
    for name, value in os.environ.items():
        value = value.strip()
        if secret_name(name) and _distinct(value):
            found.setdefault(value, name)
    for provider, entry in read_json(KeyStore().path).items():
        for field in SECRETS:
            value = entry.get(field) if isinstance(entry, dict) else None
            if isinstance(value, str) and _distinct(value):
                found.setdefault(value, f"{provider} {'key' if field == 'key' else 'token'}")
    token = _server.get("token")
    if token and _distinct(token):
        found.setdefault(token, "Jupyter token")
    for value, name in {**_dotenv(_server.get("root_dir")), **(extra or {})}.items():
        found.setdefault(value, name)
    return found


# Rule 2: documented formats of keys and tokens, by their prefix and length.
# The secret is the whole match, or its group "value" where it has one.
FORMATS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (label, re.compile(pattern))
    for label, pattern in (
        # Its lines may be joined by line breaks, or by "\n" in the JSON of a prompt.
        ("private key", r"(?s)-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:(?!-----).)*(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----)?"),
        ("OpenRouter key", r"\bsk-or-v1-[0-9a-f]{64}\b"),
        ("Anthropic key", r"\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{32,}"),
        ("OpenAI key", r"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}"),
        ("API key", r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}"),
        ("AWS access key", r"\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b"),
        ("GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"),
        ("GitLab token", r"\bglpat-[A-Za-z0-9_-]{20,}"),
        ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
        ("Google OAuth secret", r"\bGOCSPX-[A-Za-z0-9_-]{24,}"),
        ("Google OAuth token", r"\bya29\.[A-Za-z0-9_-]{20,}"),
        ("Stripe key", r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"),
        ("Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{20,}"),
        ("Slack webhook", r"https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,}"),
        ("npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
        ("PyPI token", r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}"),
        ("SendGrid key", r"\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"),
        ("Hugging Face token", r"\bhf_[A-Za-z0-9]{30,}\b"),
        ("Databricks token", r"\bdapi[0-9a-f]{32}(?:-\d+)?\b"),
        ("Atlassian token", r"\bATATT3[A-Za-z0-9_=-]{20,}"),
        ("Doppler token", r"\bdp\.(?:pt|st|ct|sa|scim|audit)\.[A-Za-z0-9]{20,}"),
        ("Linear key", r"\blin_api_[A-Za-z0-9]{32,}"),
        ("Shopify token", r"\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b"),
        ("DigitalOcean token", r"\bdo[por]_v1_[a-f0-9]{64}\b"),
        ("Telegram bot token", r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b"),
        ("age key", r"\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b"),
        ("JSON web token", r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
        ("extended private key", r"\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,}"),
    )
)

# Rule 3: names. The secret is the group "value" of a match, written in place,
# however short, where secret_name reads its name as a secret's.
#
# A string literal assigned or passed to a name, or a dictionary's value under
# one, as Python, R, JSON or YAML write it, also in the JSON of a prompt, where
# a quote is \" and a line break \n: password = "...", password="...",
# "password": "...", password <- "...", os.environ["API_KEY"] = "...".
NAMED_LITERAL = re.compile(
    r"""(?:(?<![A-Za-z0-9_\\])|(?<=\\[nrt]))(?P<q0>\\?["']?)(?P<name>[A-Za-z_][A-Za-z0-9_-]*)(?P=q0)\]?\s*(?:=|:|<-)\s*(?P<prefix>[rRbBuUfF]{0,2})(?P<q1>\\?["'])(?P<value>[^"'\\\n]+)(?P=q1)"""
)
# A line NAME=value, as an environment, a .env file or an INI file print it: at the start of the
# line, unlike a keyword argument of code on a line of its own, and with no code in the value.
NAMED_LINE = re.compile(
    r"""(?:^|(?<=\n)|(?<=\\n))(?:export[ \t]+)?(?P<name>[A-Za-z_][A-Za-z0-9_.-]*)=(?P<value>[^\s"'\\()\[\]{},]+)(?=$|\n|\\n|[ \t]|\\?["'])"""
)
# A query parameter of a URL: ?api_key=... or &token=...
QUERY_PART = re.compile(r"""[?&](?P<name>[A-Za-z0-9_.-]+)=(?P<value>[^&#\s"'\\<>]+)""")
# Query parameters of signed URLs, whose names are not a secret's by the rules above.
SIGNED_QUERY = frozenset({"sig", "signature", "x-amz-signature", "x-amz-security-token", "x-amz-credential", "x-goog-signature", "x-goog-credential"})
# A password or a key in a connection string, Pwd=...; or AccountKey=...: a part after a ";",
# or a first part followed by one, so that password=getpass() in code is no such part.
CONNECTION_WORDS = r"(?P<name>pwd|password|passwd|accountkey|sharedaccesskey|sharedaccesssignature)[ \t]*=[ \t]*(?P<value>[^;\"'\s\\]+)"
CONNECTION_PART = re.compile(r"""(?i)(?<=;)[ \t]*""" + CONNECTION_WORDS + r"""(?=;|\\?["']|\s|$)""")
CONNECTION_FIRST = re.compile(r"""(?i)(?:^|(?<=["'])|(?<=\\"))[ \t]*""" + CONNECTION_WORDS + r"""(?=;)""")
# The password of a URL, however short: the user and the host stay, for the code that connects.
URL_PASSWORD = re.compile(r"""\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#@:"'\\]*:(?P<value>[^\s/?#@"'\\]+)@""")
# The credentials of an Authorization header, and a header that holds a key.
AUTHORIZATION = re.compile(
    r"""(?i)\b(?P<name>(?:proxy-)?authorization)\\?["']?\s*[:=]\s*\\?["']?\s*(?:basic|bearer|token|apikey)\s+(?P<value>[A-Za-z0-9._~+/=-]+)"""
)
# As a request writes it (-H "X-API-Key: ..."): a dictionary's quoted value is NAMED_LITERAL's, and an unquoted one is code.
KEY_HEADER = re.compile(r"""(?i)\b(?P<name>x-api-key|api-key|x-auth-token|x-access-token|private-token):\s*(?P<value>[A-Za-z0-9._~+/=-]+)""")


# Each rule of names, with the label of its placeholder from a match, or None for a match that holds no secret.
NAMED_RULES: tuple[tuple[re.Pattern[str], Any], ...] = (
    (URL_PASSWORD, lambda match: "password in a URL"),
    # An f-string is code, whatever it holds.
    (NAMED_LITERAL, lambda match: match.group("name") if secret_name(match.group("name")) and "f" not in match.group("prefix").lower() else None),
    (NAMED_LINE, lambda match: match.group("name") if secret_name(match.group("name")) and match.group("value") != match.group("name") else None),
    (QUERY_PART, lambda match: match.group("name") if secret_name(match.group("name")) or match.group("name").lower() in SIGNED_QUERY else None),
    (CONNECTION_PART, lambda match: match.group("name")),
    (CONNECTION_FIRST, lambda match: match.group("name")),
    (AUTHORIZATION, lambda match: match.group("name")),
    (KEY_HEADER, lambda match: match.group("name")),
)


def progress(count: int, elapsed: float = 0.0) -> dict[str, Any]:
    """The progress event of the view's strip for the secrets masked in a request."""
    secrets = "1 secret" if count == 1 else f"{count} secrets"
    return {"type": "progress", "stage": "guard", "message": f"{secrets} masked before the request left this machine", "elapsed": elapsed}


class Masker:
    """Masks the secrets of the texts of one request, or of one agent's run, with what it learns of them on the way."""

    def __init__(self, known: dict[str, str]) -> None:
        # Each secret by value, with the name of its placeholder.
        self.known = dict(known)

    @classmethod
    def for_config(cls, config: Any) -> Masker:
        """A masker with the server's known values, and TypeSafe's key of the config."""
        typesafe = getattr(config, "typesafe_api_key", "") or ""
        return cls(known_values({typesafe: "TypeSafe key"} if len(typesafe) >= MIN_KNOWN else None))

    def _formats(self, text: str) -> None:
        """Rule 2: each key of a documented format joins the known values."""
        for label, pattern in FORMATS:
            for match in pattern.finditer(text):
                if _distinct(match.group(0)):
                    self.known.setdefault(match.group(0), label)

    def _names(self, text: str, found: set[str]) -> str:
        """Rule 3: each secret by a name, written in place; one long enough to mask elsewhere joins the known values."""
        for pattern, label_of in NAMED_RULES:

            def replace(match: re.Match[str]) -> str:
                value, label = match.group("value"), label_of(match)
                if label is None or not _secret_value(value):
                    return match.group(0)
                if _distinct(value):
                    self.known.setdefault(value, label)
                found.add(value)
                start, end = match.span("value")
                return match.group(0)[: start - match.start()] + PLACEHOLDER.format(label) + match.group(0)[end - match.start() :]

            text = pattern.sub(replace, text)
        return text

    def _known(self, text: str, found: set[str]) -> str:
        """Rule 1, and what rules 2 and 3 found: each known value, also as a JSON string holds it, the longest first."""
        forms: dict[str, tuple[str, str]] = {}
        for value, name in self.known.items():
            forms.setdefault(value, (value, name))
            forms.setdefault(json.dumps(value)[1:-1], (value, name))
        if not forms:
            return text
        pattern = re.compile("|".join(re.escape(form) for form in sorted(forms, key=len, reverse=True)))

        def replace(match: re.Match[str]) -> str:
            value, name = forms[match.group(0)]
            found.add(value)
            return PLACEHOLDER.format(name)

        return pattern.sub(replace, text)

    def text(self, text: str) -> tuple[str, int]:
        """The text with each secret written as ``[secret: <name>]``, and the number of secrets it held."""
        if not text:
            return text, 0
        found: set[str] = set()
        self._formats(text)
        masked = self._known(self._names(text, found), found)
        return masked, len(found)

    def value(self, value: Any) -> tuple[Any, int]:
        """A JSON value with each of its strings masked, and the number of secrets they held."""
        total = 0

        def walk(item: Any) -> Any:
            nonlocal total
            if isinstance(item, str):
                masked, count = self.text(item)
                total += count
                return masked
            if isinstance(item, dict):
                return {key: walk(inner) for key, inner in item.items()}
            if isinstance(item, (list, tuple)):
                return [walk(inner) for inner in item]
            return item

        masked = walk(value)
        return masked, total
