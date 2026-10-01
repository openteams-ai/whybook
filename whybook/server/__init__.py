"""The Jupyter server extension of Whybook: its routes and its settings."""

from traitlets.config import Config

from .config import Whybook
from .routes import setup_route_handlers


def with_old_settings(config: Config) -> None:
    """Settings written before the rename, as c.Future.<name>, still apply.

    A value set as c.Whybook.<name> takes precedence over the same name
    set as c.Future.<name>.
    """
    if "Future" in config:
        merged = Config(config.Future)
        merged.merge(config.Whybook)
        config.Whybook = merged


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    with_old_settings(server_app.config)
    config = Whybook(parent=server_app)
    setup_route_handlers(server_app.web_app, config)
    server_app.log.info(
        f"Registered the Whybook server extension, questions ranked by {config.question_ranker}"
    )
