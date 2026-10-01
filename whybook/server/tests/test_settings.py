"""Settings written before the rename, as c.Future, still apply."""

from traitlets.config import Config

from whybook.server import with_old_settings
from whybook.server.config import Whybook


def test_a_setting_of_the_old_name_applies():
    config = Config()
    config.Future.describe_tables = False
    with_old_settings(config)
    assert Whybook(config=config).describe_tables is False


def test_the_new_name_wins_over_the_old_one():
    config = Config()
    config.Future.agent_max_cells = 3
    config.Future.describe_tables = False
    config.Whybook.agent_max_cells = 5
    with_old_settings(config)
    settings = Whybook(config=config)
    assert settings.agent_max_cells == 5
    assert settings.describe_tables is False


def test_settings_of_the_new_name_alone_are_kept():
    config = Config()
    config.Whybook.describe_tables = False
    with_old_settings(config)
    assert Whybook(config=config).describe_tables is False
