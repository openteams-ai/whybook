"""Keys and tokens of the models that a user connects, kept on the server.

They go in one file, ``keys.json``, in Whybook's folder of Jupyter's data
folder (``data_dir``), which only the user can read and write: mode 0600 in a
folder of mode 0700. They never go in JupyterLab's settings, which are plain
JSON that the browser holds, nor in ``os.environ``, which every kernel
inherits. The browser learns whether a key exists, and never the key.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Any

from jupyter_core.paths import jupyter_data_dir


def data_dir() -> str:
    """Whybook's folder for what the server keeps per user: WHYBOOK_DATA_DIR, or whybook/ in Jupyter's data folder."""
    return os.environ.get("WHYBOOK_DATA_DIR") or os.path.join(jupyter_data_dir(), "whybook")


def write_private(path: str, value: Any) -> None:
    """Write JSON that only the user can read, in one step: a reader never sees half a file."""
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=folder, prefix=".whybook-", suffix=".json")
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(handle, "w") as out:
            json.dump(value, out, indent=1)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def read_json(path: str) -> dict[str, Any]:
    """A JSON object from a file, or an empty one when the file is missing or broken."""
    try:
        with open(path) as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


# The fields of an entry that are secrets: the key, and a sign-in's refresh token.
SECRETS = ("key", "refresh_token")


def now() -> str:
    """The time of a change to a key, in UTC, as the store writes it."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class KeyStore:
    """The keys of the providers, by provider: ``openrouter``, ``huggingface``, ``anthropic``, and so on.

    Besides the key, an entry keeps when it was saved (``saved``), by what
    sign-in (``signin``), ``checked: false`` for a key saved without a check
    of the provider, and ``refused``, the time a provider last refused it.
    """

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(data_dir(), "keys.json")

    def _entries(self) -> dict[str, dict[str, Any]]:
        return {name: entry for name, entry in read_json(self.path).items() if isinstance(entry, dict) and entry.get("key")}

    def get(self, name: str, field: str = "key") -> str | None:
        """The key, or another secret of the entry, for a call to the provider. Never send it to the browser."""
        entry = self._entries().get(name)
        return str(entry[field]) if entry and entry.get(field) else None

    def has(self, name: str) -> bool:
        return name in self._entries()

    def meta(self, name: str) -> dict[str, Any] | None:
        """What the store knows of a key, without its secrets: when it was saved, by what sign-in, and when it expires."""
        entry = self._entries().get(name)
        return {key: value for key, value in entry.items() if key not in SECRETS} if entry else None

    def set(self, name: str, key: str, **meta: Any) -> None:
        if not key:
            raise ValueError("a key cannot be empty")
        entries = self._entries()
        entries[name] = {**meta, "key": key, "saved": now()}
        write_private(self.path, entries)

    def confirm(self, name: str, key: str) -> None:
        """A provider took the key: it is no longer "not checked", nor refused.

        Only for the key that the request used, since the analyst may have
        saved another meanwhile, and the file is written only when it changes.
        """
        entries = self._entries()
        entry = entries.get(name)
        if not entry or entry["key"] != key or (entry.get("checked") is not False and "refused" not in entry):
            return
        entry.pop("checked", None)
        entry.pop("refused", None)
        write_private(self.path, entries)

    def refuse(self, name: str, key: str) -> None:
        """A provider refused the key: keep when, so that the panel says the key is wrong. The first refusal since the key last worked counts."""
        entries = self._entries()
        entry = entries.get(name)
        if not entry or entry["key"] != key or entry.get("refused"):
            return
        entry["refused"] = now()
        write_private(self.path, entries)

    def delete(self, name: str) -> bool:
        """Forget a key; False when there was none. The provider may keep it: sign out there too."""
        entries = self._entries()
        if entries.pop(name, None) is None:
            return False
        write_private(self.path, entries)
        return True
