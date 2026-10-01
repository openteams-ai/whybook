import sys
from pathlib import Path

import pytest

pytest_plugins = ("pytest_jupyter.jupyter_server", )


@pytest.fixture(autouse=True)
def whybook_data(tmp_path, monkeypatch):
    """Whybook's folder of keys and the connection, per test: never the user's own (keystore.data_dir).

    The tests offer the Claude Code login (c.Whybook.claude_code_login), which
    most of them were written for, and no test calls Claude: each fakes the SDK
    or the call. test_connection.py checks the default, with the login off.
    """
    folder = tmp_path / "whybook-data"
    monkeypatch.setenv("WHYBOOK_DATA_DIR", str(folder))
    monkeypatch.setenv("WHYBOOK_CLAUDE_CODE_LOGIN", "1")
    return folder


@pytest.fixture
def jp_server_config(jp_server_config):
    return {
        "ServerApp": {
            "jpserver_extensions": {"whybook": True},
            # Test against a server which requires authentication on all endpoints
            "allow_unauthenticated_access": False,
        }
    }


@pytest.fixture(scope="session")
def demo():
    """The demo notebook's kernel state, in-process. Takes about ten seconds."""
    sys.path.insert(0, str(Path(__file__).parent / "whybook" / "server" / "tests"))
    from demo_state import DemoState

    state = DemoState()
    yield state
    state.close()
