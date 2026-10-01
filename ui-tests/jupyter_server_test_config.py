"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import os
from tempfile import mkdtemp

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# The view saves the Drag or Click choice and the layout as settings: keep the
# tests' settings out of the user's own settings directory.
c.LabApp.user_settings_dir = mkdtemp(prefix="galata-settings-")

# The connected model and the keys of the providers (whybook/server/keystore.py):
# kept out of the user's own Jupyter data folder.
os.environ["WHYBOOK_DATA_DIR"] = mkdtemp(prefix="galata-whybook-")

# Opening a notebook would ask Claude to label its table tiles: the tests
# answer those requests themselves, and the server refuses any that get past.
c.Whybook.describe_tables = False

# The tests were written for the Claude Code login as the connected model, which
# a server offers only with this flag (development only, under Anthropic's terms).
c.Whybook.claude_code_login = True

# No test may call Claude: each test answers the routes that would. A request
# that gets past a test's route, such as one whose pattern does not match the
# URL, reaches a CLI that does not exist and fails, and no model runs.
c.Whybook.claude_cli_path = "/nonexistent/whybook-tests-never-call-claude"

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
