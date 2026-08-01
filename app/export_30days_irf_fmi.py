# /app/export_30days_irf_fmi.py
#
# Exporterar 30 dygns magnetometerdata (IRF + FMI)
# joinat mot NOAA/DSCOVR-solarwind till två CSV-filer:
#   /app/data/exports/irf_noaa_30d.csv
#   /app/data/exports/fmi_noaa_30d.csv

from datetime import datetime, timedelta
from pathlib import Path
import csv

from utils import get_db, log

EXPORT_DIR = Path("/app/data/exports")


def export_30_days_irf_fmi(days: int = 30) -> None:
    """Exportera IRF + FMI magnetometerdata joinat med solarwind."""
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    cutoff = datetime.utcnow() - timedelta(days=days)
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    cur = conn.cursor()

    # ---- IRF + solarwind ----
    # Tabellen "magnetometer" har KIR/TOP osv:
    #   station, timestamp, deflection, kirx, kiry, kirz, kirf
    log(f"Export IRF + solarwind från {cutoff_str} ...")
    cur.execute(
        """
        SELECT
            m.station,
            m.timestamp,
            m.kirx AS x,
            m.kiry AS y,
            m.kirz AS z,
            m.kirf AS f,
            s.speed,
            s.density,
            s.bt,
            s.bz,
            s.`by`
        FROM magnetometer AS m
        JOIN solarwind AS s
          ON s.timestamp = m.timestamp
        WHERE m.timestamp >= %s
        ORDER BY m.timestamp ASC, m.station ASC
        """,
        (cutoff_str,),
    )
    irf_rows = cur.fetchall()

    irf_path = EXPORT_DIR / "irf_noaa_30d.csv"
    with irf_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "station",
                "timestamp",
                "x_nT",
                "y_nT",
                "z_nT",
                "f_nT",
                "speed_km_s",
                "density_cm3",
                "bt_nT",
                "bz_nT",
                "by_nT",
            ]
        )
        for r in irf_rows:
            w.writerow(
                [
                    r["station"],
                    r["timestamp"],
                    r["x"],
                    r["y"],
                    r["z"],
                    r["f"],
                    r["speed"],
                    r["density"],
                    r["bt"],
                    r["bz"],
                    r["by"],
                ]
            )
    log(f"Skrev {len(irf_rows)} rader till {irf_path}")

    # ---- FMI + solarwind ----
    # Tabellen "magnetometer_fmi":
    #   station, timestamp, x, y, z
    log(f"Export FMI + solarwind från {cutoff_str} ...")
    cur.execute(
        """
        SELECT
            f.station,
            f.timestamp,
            f.x,
            f.y,
            f.z,
            s.speed,
            s.density,
            s.bt,
            s.bz,
            s.`by`
        FROM magnetometer_fmi AS f
        JOIN solarwind AS s
          ON s.timestamp = f.timestamp
        WHERE f.timestamp >= %s
        ORDER BY f.timestamp ASC, f.station ASC
        """,
        (cutoff_str,),
    )
    fmi_rows = cur.fetchall()

    fmi_path = EXPORT_DIR / "fmi_noaa_30d.csv"
    with fmi_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "station",
                "timestamp",
                "x_nT",
                "y_nT",
                "z_nT",
                "speed_km_s",
                "density_cm3",
                "bt_nT",
                "bz_nT",
                "by_nT",
            ]
        )
        for r in fmi_rows:
            w.writerow(
                [
                    r["station"],
                    r["timestamp"],
                    r["x"],
                    r["y"],
                    r["z"],
                    r["speed"],
                    r["density"],
                    r["bt"],
                    r["bz"],
                    r["by"],
                ]
            )
    log(f"Skrev {len(fmi_rows)} rader till {fmi_path}")

    cur.close()
    conn.close()
    log("Export IRF/FMI + NOAA klar.")


if __name__ == "__main__":
    export_30_days_irf_fmi(days=30)
