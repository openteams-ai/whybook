"""Synthetic pain-diary cohort for the Whybook demo.

Everything here is made up: 318 patients in two treatment arms at four
sites, a daily pain diary kept in a wide weekly layout, and a panel of
4 812 proteins measured once per patient. The generators are deterministic.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

N_PATIENTS = 318
SITES = ["north", "south", "east", "west"]
PANELS = {
    "Inflammation": 1104,
    "Cardiometabolic": 1472,
    "Neurology": 1180,
    "Oncology": 1056,
}
NAMED = {
    "Inflammation": ["IL6", "CXCL10", "TNF", "IL8", "MMP9", "CCL2", "IL1B", "IL10", "IL17A"],
    "Cardiometabolic": ["VEGFA", "LEP"],
    "Neurology": ["NGF", "BDNF", "GDNF"],
}
SEED = 20260922

# Patients need this many diary days to count as adherent. Shorter
# diaries are too sparse for a weekly trajectory. Nobody has checked
# whether the result depends on it.
MIN_DAYS = 14


def drop_sparse(df, min_days=MIN_DAYS):
    """Keep patients with at least ``min_days`` diary days."""
    keep = df.groupby("patient_id").size() >= min_days
    return df[df["patient_id"].isin(keep[keep].index)]


def _patient_ids():
    return [f"P{i:03d}" for i in range(1, N_PATIENTS + 1)]


def _latent():
    """Per-patient traits shared by all generators."""
    rng = np.random.default_rng(SEED)
    ids = _patient_ids()
    arm = np.where(rng.permutation(N_PATIENTS) % 2 == 0, "A", "B")
    site = rng.choice(SITES, N_PATIENTS, p=[0.35, 0.3, 0.2, 0.15])
    inflammation = rng.normal(0, 1, N_PATIENTS)
    baseline = 5.2 + 0.7 * inflammation + rng.normal(0, 0.8, N_PATIENTS)
    slope = np.where(arm == "B", -0.075, -0.03) + rng.normal(0, 0.02, N_PATIENTS)
    # 27 patients give up within two weeks; the rest keep a diary for 15 to 28 weeks.
    days = rng.integers(105, 195, N_PATIENTS)
    sparse = rng.choice(N_PATIENTS, 27, replace=False)
    days[sparse] = rng.integers(3, 14, 27)
    return pd.DataFrame(
        {
            "patient_id": ids,
            "arm": arm,
            "site": site,
            "inflammation": inflammation,
            "baseline": baseline,
            "slope": slope,
            "days": days,
            "cycle_start": rng.integers(0, 28, N_PATIENTS),
        }
    )


def load_patients():
    """One row per patient: arm, site and baseline characteristics."""
    rng = np.random.default_rng(SEED + 1)
    latent = _latent()
    bmi = rng.normal(27, 5, N_PATIENTS).round(1)
    bmi[rng.random(N_PATIENTS) < 0.05] = np.nan
    return pd.DataFrame(
        {
            "patient_id": latent["patient_id"],
            "treatment_arm": pd.Categorical(latent["arm"]),
            "site": pd.Categorical(latent["site"]),
            "age": rng.normal(36, 7, N_PATIENTS).clip(18, 55).round().astype(int),
            "bmi": bmi,
            "parity": rng.poisson(1.1, N_PATIENTS).clip(0, 4),
            "stage": pd.Categorical(
                rng.choice(["I", "II", "III", "IV"], N_PATIENTS, p=[0.3, 0.3, 0.25, 0.15]),
                categories=["I", "II", "III", "IV"],
                ordered=True,
            ),
        }
    )


def load_diary_raw():
    """The diary as exported: one row per patient-week, one column per day.

    Days a patient did not log are empty. Half of the arm A patients with
    high baseline pain stop logging between days 35 and 45.
    """
    rng = np.random.default_rng(SEED + 2)
    latent = _latent()
    rows = []
    for patient in latent.itertuples():
        stop = patient.days
        if patient.arm == "A" and patient.baseline > 5.0 and rng.random() < 0.5:
            stop = min(stop, int(rng.integers(35, 46)))
        for week in range(1, (stop - 1) // 7 + 2):
            row = {"patient_id": patient.patient_id, "week": week}
            row["analgesic_use"] = rng.choice(["none", "otc", "opioid"], p=[0.5, 0.4, 0.1])
            row["notes"] = rng.choice(["", "", "", "bad night", "flare", "travelling"])
            row["cycle_start"] = patient.cycle_start
            for day in range(1, 8):
                diary_day = (week - 1) * 7 + day
                logged = diary_day <= stop and rng.random() > 0.08
                cycle_day = (patient.cycle_start + diary_day - 1) % 28 + 1
                sleep = rng.normal(7, 1.1) if logged else np.nan
                pain = (
                    patient.baseline
                    + patient.slope * diary_day
                    + (1.3 if cycle_day <= 5 else 0.0)
                    - 0.35 * ((sleep if logged else 7) - 7)
                    + rng.normal(0, 1.3)
                )
                row[f"pain_{day}"] = float(np.clip(np.round(pain), 0, 10)) if logged else np.nan
                row[f"sleep_{day}"] = round(float(sleep), 1) if logged and rng.random() > 0.03 else np.nan
                row[f"mood_{day}"] = float(np.clip(6 - np.ceil(pain / 2.2), 1, 5)) if logged and rng.random() > 0.05 else np.nan
            rows.append(row)
    return pd.DataFrame(rows)


def to_long(raw):
    """One row per patient-day from the wide weekly layout."""
    parts = []
    for day in range(1, 8):
        part = raw[["patient_id", "week", "analgesic_use", "notes", "cycle_start"]].copy()
        part["diary_day"] = (raw["week"] - 1) * 7 + day
        part["pain_score"] = raw[f"pain_{day}"]
        part["sleep_hours"] = raw[f"sleep_{day}"]
        part["mood"] = raw[f"mood_{day}"]
        parts.append(part)
    long = pd.concat(parts).dropna(subset=["pain_score"])
    long["cycle_day"] = (long["cycle_start"] + long["diary_day"] - 1) % 28 + 1
    long["bleeding"] = long["cycle_day"] <= 5
    long["analgesic_use"] = pd.Categorical(long["analgesic_use"], categories=["none", "otc", "opioid"])
    columns = ["patient_id", "diary_day", "week", "pain_score", "sleep_hours", "analgesic_use", "cycle_day", "bleeding", "mood", "notes"]
    return long[columns].sort_values(["patient_id", "diary_day"]).reset_index(drop=True)


def load_olink():
    """Protein panel: one row per patient, 4 812 proteins in four assay panels.

    ``attrs["whybook"]["groups"]`` records which panel each protein belongs to,
    which the Whybook view uses to group the columns.
    """
    rng = np.random.default_rng(SEED + 3)
    latent = _latent()
    columns, groups = [], {}
    for panel, size in PANELS.items():
        named = NAMED.get(panel, [])
        names = named + [f"{panel[:3].upper()}{i:04d}" for i in range(1, size - len(named) + 1)]
        groups[panel] = names
        columns.extend(names)
    values = rng.normal(0, 1, (N_PATIENTS, len(columns)))
    index = {name: i for i, name in enumerate(columns)}
    values[:, index["IL6"]] = 0.8 * latent["inflammation"] + rng.normal(0, 0.6, N_PATIENTS)
    values[:, index["NGF"]] = 0.5 * latent["baseline"] + rng.normal(0, 0.8, N_PATIENTS)
    missing = rng.random(values.shape) < rng.uniform(0, 0.15, len(columns))
    values[missing] = np.nan
    frame = pd.DataFrame(values.round(3), columns=columns)
    frame.insert(0, "patient_id", latent["patient_id"])
    frame.attrs["whybook"] = {"groups": groups, "grouped_by": "assay panel"}
    return frame


def write_clinic_db(path):
    """Clinic records in a SQLite file, as the clinic's system exports them.

    `visits` has three to six rows per patient: C-reactive protein, which
    follows the same inflammation as IL6, blood pressure, and the analgesic
    dose, which follows baseline pain. `sites` has one row per site.
    """
    import os
    import sqlite3
    from contextlib import closing

    rng = np.random.default_rng(SEED + 4)
    latent = _latent()
    rows = []
    for patient in latent.itertuples():
        for week in np.sort(rng.choice(26, rng.integers(3, 7), replace=False)):
            rows.append(
                {
                    "patient_id": patient.patient_id,
                    "week": int(week),
                    "crp_mg_l": round(float(np.exp(1.0 + 0.45 * patient.inflammation + rng.normal(0, 0.35))), 2),
                    "systolic_bp": int(rng.normal(118, 12)),
                    "analgesic_dose_mg": int(max(0, round((200 + 60 * (patient.baseline - 5) + rng.normal(0, 40)) / 50) * 50)),
                }
            )
    sites = pd.DataFrame({"site": SITES, "region": ["urban", "urban", "rural", "rural"], "clinicians": [6, 5, 3, 2]})
    if os.path.exists(path):
        os.remove(path)
    with closing(sqlite3.connect(path)) as db:
        pd.DataFrame(rows).to_sql("visits", db, index=False)
        sites.to_sql("sites", db, index=False)
        db.commit()

