"""The Jupyter server extension of Whybook: its routes and its settings."""

import os

from . import masking
from .config import Whybook
from .routes import setup_route_handlers


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    config = Whybook(parent=server_app)
    # Every kernel that the server starts inherits its environment, so TypeSafe's key goes from there into the settings.
    config.typesafe_api_key = config.typesafe_api_key
    os.environ.pop("TYPESAFE_API_KEY", None)
    # The token of the server, masked in prompts wherever an output prints it, and the folder of its .env file.
    identity = getattr(server_app, "identity_provider", None)
    masking.register(getattr(identity, "token", None) or None, getattr(server_app, "root_dir", None))
    setup_route_handlers(server_app.web_app, config)
    server_app.log.info(
        f"Registered the Whybook server extension, questions ranked by {config.question_ranker}"
    )
