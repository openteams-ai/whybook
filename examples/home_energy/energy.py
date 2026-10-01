"""The shared helpers of the home energy analysis.

The notebook imports them, so their defaults do not show in its cells: the
Whybook view shows them on the cells that use them.
"""

from __future__ import annotations

# Heating degree days count the degrees by which a day's mean temperature
# falls below this one. 15.5 °C is a common convention; nobody has checked it
# against these homes.
BASE_TEMP_C = 15.5

# A home counts when its meter reported on this share of the days. Meters
# that lose their connection leave gaps of weeks.
MIN_COVERAGE = 0.9


def drop_gappy(readings, min_coverage=MIN_COVERAGE):
    """Keep the homes whose meter reported on at least ``min_coverage`` of the days."""
    days = readings["date"].nunique()
    coverage = readings.groupby("home_id", observed=True)["date"].nunique() / days
    keep = coverage[coverage >= min_coverage].index
    return readings[readings["home_id"].isin(keep)]


def add_degree_days(daily, base=BASE_TEMP_C):
    """Add ``hdd``: how far each day's mean temperature fell below ``base``, in degrees."""
    return daily.assign(hdd=(base - daily["mean_temp_c"]).clip(lower=0))
