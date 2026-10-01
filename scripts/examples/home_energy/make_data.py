"""Write the data of the home energy example: CSV and parquet files.

Everything is synthetic and deterministic: 360 homes over 2025, their
electricity meters, the weather in their four regions, and the two tariffs of
a trial. Part way through the year a quarter of the homes switched to a
time-of-use tariff, which makes electricity cheap at night and dear between
16:00 and 19:00. The homes chose it themselves, and homes with an electric car
chose it far more often.

    python scripts/examples/home_energy/make_data.py

- homes.csv: one row per home.
- weather.csv: one row per region and day.
- tariffs.csv: the price of each period of each tariff.
- readings.parquet: one row per home and day, as the meters report it.
- half_hourly.parquet: every half hour of two weeks, one in February and one
  in October, for every home.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

# The example's folder, where the notebook reads the files.
EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "home_energy"
SEED = 20260923
N_HOMES = 360
DAYS = pd.date_range("2025-01-01", "2025-12-31", freq="D")
REGIONS = ["north", "central", "south", "coast"]
# The temperature below which a home starts to heat. The helper module of the
# notebook assumes 15.5 °C, a common convention; these homes start at 14.
BALANCE_C = 14.0
SLOTS = 48
HOURS = np.arange(SLOTS) / 2
PEAK = (HOURS >= 16) & (HOURS < 19)
NIGHT = HOURS < 7
TARIFFS = pd.DataFrame(
    [
        ("flat", "all day", "00:00", "24:00", 0.30, 0.50),
        ("time of use", "night", "00:00", "07:00", 0.15, 0.55),
        ("time of use", "day", "07:00", "16:00", 0.28, 0.55),
        ("time of use", "peak", "16:00", "19:00", 0.45, 0.55),
        ("time of use", "evening", "19:00", "24:00", 0.28, 0.55),
    ],
    columns=["tariff", "period", "starts", "ends", "eur_per_kwh", "standing_eur_per_day"],
)


def homes(rng: np.random.Generator) -> pd.DataFrame:
    region = rng.choice(REGIONS, N_HOMES, p=[0.3, 0.3, 0.25, 0.15])
    built = rng.choice(["before 1950", "1950 to 1990", "after 1990"], N_HOMES, p=[0.25, 0.45, 0.3])
    newer = built == "after 1990"
    heating = np.where(
        rng.random(N_HOMES) < np.where(newer, 0.45, 0.2),
        "heat pump",
        np.where(rng.random(N_HOMES) < 0.22, "electric storage", "gas boiler"),
    )
    solar = rng.random(N_HOMES) < np.where(region == "south", 0.36, 0.2)
    ev = rng.random(N_HOMES) < 0.21
    # Homes pick the new tariff: an electric car makes it pay, and so do panels.
    chose = rng.random(N_HOMES) < 0.12 + 0.5 * ev + 0.1 * solar
    start = pd.to_datetime("2025-03-01") + pd.to_timedelta(rng.integers(0, 122, N_HOMES), unit="D")
    return pd.DataFrame(
        {
            "home_id": [f"H{i:03d}" for i in range(1, N_HOMES + 1)],
            "region": region,
            "floor_area_m2": np.clip(np.round(rng.lognormal(np.log(88), 0.3, N_HOMES)), 38, 240).astype(int),
            "occupants": rng.choice([1, 2, 3, 4, 5], N_HOMES, p=[0.28, 0.34, 0.16, 0.15, 0.07]),
            "built": built,
            "heating": heating,
            "has_solar": solar,
            "has_ev": ev,
            "tariff": np.where(chose, "time of use", "flat"),
            "tou_start": pd.Series(start).where(chose).dt.strftime("%Y-%m-%d"),
        }
    )


def weather(rng: np.random.Generator) -> pd.DataFrame:
    day_of_year = DAYS.dayofyear.to_numpy()
    season = np.sin(2 * np.pi * (day_of_year - 110) / 365)
    offset = {"north": -2.0, "central": 0.0, "south": 1.3, "coast": 0.9}
    swing = {"north": 1.0, "central": 1.0, "south": 1.05, "coast": 0.8}
    parts = []
    for region in REGIONS:
        noise = np.zeros(len(DAYS))
        for i in range(1, len(DAYS)):
            noise[i] = 0.75 * noise[i - 1] + rng.normal(0, 1.5)
        mean = 10.5 + offset[region] + 7.5 * swing[region] * season + noise
        sun = np.clip(4.4 + 3.4 * season + (0.6 if region == "south" else 0) + rng.normal(0, 1.8, len(DAYS)), 0, 14)
        rain = np.where(rng.random(len(DAYS)) < 0.4, rng.gamma(1.4, 3.2, len(DAYS)), 0.0)
        parts.append(
            pd.DataFrame(
                {
                    "date": DAYS.strftime("%Y-%m-%d"),
                    "region": region,
                    "mean_temp_c": mean.round(1),
                    "min_temp_c": (mean - rng.uniform(2.5, 6.5, len(DAYS))).round(1),
                    "sunshine_hours": sun.round(1),
                    "rain_mm": rain.round(1),
                }
            )
        )
    return pd.concat(parts, ignore_index=True)


def profile(peaks: list[tuple[float, float, float]]) -> np.ndarray:
    """A daily shape over the 48 half hours: bumps at (hour, width, weight), summing to 1."""
    shape = np.full(SLOTS, 0.15)
    for hour, width, weight in peaks:
        shape += weight * np.exp(-0.5 * ((HOURS - hour) / width) ** 2)
    return shape / shape.sum()


ACTIVITY = profile([(7.5, 1.0, 1.0), (13.0, 2.0, 0.5), (18.0, 1.6, 2.2), (21.0, 1.2, 1.0)])
HEATING = profile([(7.0, 1.5, 1.0), (18.5, 2.5, 1.2)])


def meters(rng: np.random.Generator, home: pd.DataFrame, climate: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """What each home takes from the grid, and gives back, every half hour: two arrays of home × day × slot."""
    n, d = len(home), len(DAYS)
    temp = climate.pivot(index="region", columns="date", values="mean_temp_c").loc[home["region"]].to_numpy()
    sun = climate.pivot(index="region", columns="date", values="sunshine_hours").loc[home["region"]].to_numpy()
    occupants = home["occupants"].to_numpy()[:, None]
    weekend = np.asarray(DAYS.dayofweek >= 5)[None, :]
    switch = pd.to_datetime(home["tou_start"]).to_numpy()[:, None]
    on_tou = (home["tariff"] == "time of use").to_numpy()[:, None] & (DAYS.to_numpy()[None, :] >= switch)

    # Always on, and what the people in the home do.
    base = np.broadcast_to((0.06 + 0.02 * occupants)[:, :, None], (n, d, SLOTS))
    activity_kwh = (2.4 + 1.5 * occupants) * np.where(weekend, 1.12, 1.0) * rng.lognormal(0, 0.12, (n, d))
    shape = np.broadcast_to(ACTIVITY, (n, d, SLOTS)).copy()
    # On the new tariff, timers move a share of the evening's use to the night.
    moved = shape[:, :, PEAK].sum(axis=2) * 0.14
    shape[:, :, PEAK] *= np.where(on_tou, 0.86, 1.0)[:, :, None]
    shape[:, :, NIGHT] += np.where(on_tou, moved, 0.0)[:, :, None] / NIGHT.sum()
    activity = activity_kwh[:, :, None] * shape * rng.lognormal(0, 0.3, (n, d, SLOTS))

    # Heating: heat pumps through the day, storage heaters charge at night.
    # Heat lost per square metre and degree, kWh a day: 6 kWh per degree for an old 100 m² house.
    insulation = home["built"].map({"before 1950": 0.06, "1950 to 1990": 0.045, "after 1990": 0.03}).to_numpy()
    heat = (home["floor_area_m2"].to_numpy() * insulation)[:, None] * np.maximum(0.0, BALANCE_C - temp)
    cop = np.clip(2.3 + 0.09 * temp, 1.8, 4.2)
    kind = home["heating"].to_numpy()[:, None]
    daily_heating = np.select(
        [kind == "heat pump", kind == "electric storage"],
        [heat / cop + 1.0, heat / 0.97 + 4.0],
        0.015 * heat,
    )
    night_share = np.where(kind == "electric storage", 1.0, 0.0)[:, :, None]
    night_shape = np.where(NIGHT, 1.0 / NIGHT.sum(), 0.0)
    heating = daily_heating[:, :, None] * (night_share * night_shape + (1 - night_share) * HEATING)

    # Electric cars: plugged in on arrival, or at 00:30 by a timer on the new tariff.
    ev = home["has_ev"].to_numpy()[:, None]
    charges = ev & (rng.random((n, d)) < np.where(weekend, 0.3, 0.42))
    energy = rng.uniform(6, 14, (n, d))
    timed = on_tou & (rng.random((n, d)) < 0.85)
    start = np.where(timed, 1, np.clip(np.round(rng.normal(36, 2, (n, d))), 30, 44)).astype(int)
    car = np.zeros((n, d, SLOTS))
    left = np.where(charges, energy, 0.0)
    for step in range(5):
        slot = np.minimum(start + step, SLOTS - 1)
        now = np.minimum(left, 3.5)
        np.put_along_axis(car, slot[:, :, None], np.take_along_axis(car, slot[:, :, None], 2) + now[:, :, None], axis=2)
        left = left - now

    demand = base + activity + heating + car

    # Solar panels: generation over the daylight hours, used first in the home.
    capacity = np.where(home["has_solar"], rng.uniform(2.5, 5.0, n), 0.0)[:, None, None]
    day_of_year = DAYS.dayofyear.to_numpy()
    daylight = 12 + 4 * np.sin(2 * np.pi * (day_of_year - 80) / 365)
    sunrise = 12 - daylight / 2
    arc = np.clip(np.sin(np.pi * (HOURS[None, :] - sunrise[:, None]) / daylight[:, None]), 0, None)
    clear = 0.25 + 0.75 * np.clip(sun / daylight[None, :], 0, 1)
    generation = capacity * 0.5 * 0.8 * arc[None, :, :] * clear[:, :, None]
    grid = np.maximum(0.0, demand - generation)
    export = np.maximum(0.0, generation - demand)
    return grid, export


def readings(rng: np.random.Generator, home: pd.DataFrame, grid: np.ndarray, export: np.ndarray) -> pd.DataFrame:
    """The meters' daily report, with the gaps and the errors that real meters have."""
    n, d = len(home), len(DAYS)
    frame = pd.DataFrame(
        {
            "home_id": np.repeat(home["home_id"].to_numpy(), d),
            "date": np.tile(DAYS.to_numpy(), n),
            "kwh_import": grid.sum(axis=2).ravel(),
            "kwh_peak": grid[:, :, PEAK].sum(axis=2).ravel(),
            "kwh_night": grid[:, :, NIGHT].sum(axis=2).ravel(),
            "kwh_export": export.sum(axis=2).ravel(),
        }
    )
    kept = rng.random(len(frame)) > 0.006
    # One meter in twelve loses its connection for three weeks to three months.
    for index in rng.choice(n, n // 12, replace=False):
        begin = int(rng.integers(0, d - 90))
        length = int(rng.integers(21, 91))
        kept[index * d + begin : index * d + begin + length] = False
    frame = frame[kept].reset_index(drop=True)
    # A few impossible days: a meter stuck at zero, and two that report a spike.
    broken = frame.sample(9, random_state=SEED).index
    frame.loc[broken[:5], ["kwh_import", "kwh_peak", "kwh_night"]] = 0.0
    frame.loc[broken[5:], "kwh_import"] = 999.9
    for column in ["kwh_import", "kwh_peak", "kwh_night", "kwh_export"]:
        frame[column] = frame[column].round(3).astype("float32")
    frame["home_id"] = frame["home_id"].astype("category")
    frame["date"] = pd.to_datetime(frame["date"]).dt.date
    return frame


def half_hours(home: pd.DataFrame, grid: np.ndarray) -> pd.DataFrame:
    """Every half hour of one week in February and one in October."""
    weeks = [pd.date_range("2025-02-10", periods=7), pd.date_range("2025-10-06", periods=7)]
    parts = []
    for week in weeks:
        index = [DAYS.get_loc(day) for day in week]
        values = grid[:, index, :]
        stamps = (week.to_numpy()[:, None] + pd.to_timedelta(HOURS, unit="h").to_numpy()[None, :]).ravel()
        parts.append(
            pd.DataFrame(
                {
                    "home_id": np.repeat(home["home_id"].to_numpy(), len(stamps)),
                    "timestamp": np.tile(stamps, len(home)),
                    "kwh": values.reshape(len(home), -1).ravel().round(3).astype("float32"),
                }
            )
        )
    frame = pd.concat(parts, ignore_index=True)
    frame["home_id"] = frame["home_id"].astype("category")
    return frame


def main() -> None:
    rng = np.random.default_rng(SEED)
    home = homes(rng)
    climate = weather(rng)
    grid, export = meters(rng, home, climate)
    home.to_csv(EXAMPLE / "homes.csv", index=False)
    climate.to_csv(EXAMPLE / "weather.csv", index=False)
    TARIFFS.to_csv(EXAMPLE / "tariffs.csv", index=False)
    readings(rng, home, grid, export).to_parquet(EXAMPLE / "readings.parquet", index=False, compression="zstd")
    half_hours(home, grid).to_parquet(EXAMPLE / "half_hourly.parquet", index=False, compression="zstd")
    for name in ["homes.csv", "weather.csv", "tariffs.csv", "readings.parquet", "half_hourly.parquet"]:
        print(f"{name}: {(EXAMPLE / name).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
