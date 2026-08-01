from datetime import datetime, timedelta
from pathlib import Path
import csv

from utils import get_db, log


EXPORT_DIR = Path("/app/data/exports")


def export_30_days():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    db = get_db()
    cutoff = datetime.utcnow() - timedelta(days=30)
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    with db.cursor() as cur:
        # 1) Solar wind (speed, density, Bt, Bz, By)
        cur.execute(
            """
            SELECT timestamp, speed, density, bt, bz, `by`
            FROM solarwind
            WHERE timestamp >= %s
            ORDER BY timestamp ASC
            """,
            (cutoff_str,),
        )
        solarwind_rows = cur.fetchall()

        # 2) IRF magnetometer (KIR + TOP, alla komponenter)
        cur.execute(
            """
            SELECT station, timestamp, deflection, kirx, kiry, kirz, kirf
            FROM magnetometer
            WHERE timestamp >= %s
            ORDER BY timestamp ASC
            """,
            (cutoff_str,),
        )
        mag_rows = cur.fetchall()

        # 3) HP-index (hp30/hp60 + ap30/ap60)
        cur.execute(
            """
            SELECT timestamp, hp30, ap30, hp60, ap60
            FROM hp_index
            WHERE timestamp >= %s
            ORDER BY timestamp ASC
            """,
            (cutoff_str,),
        )
        hp_rows = cur.fetchall()

        # 4) Kp-index (planetary Kp)
        cur.execute(
            """
            SELECT timestamp, kp
            FROM kp_index
            WHERE timestamp >= %s
            ORDER BY timestamp ASC
            """,
            (cutoff_str,),
        )
        kp_rows = cur.fetchall()

    db.close()

    # ---- write CSV files ----

    # 1) solarwind_30d.csv
    sw_path = EXPORT_DIR / "solarwind_30d.csv"
    with sw_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "speed", "density", "bt", "bz", "by"])
        for r in solarwind_rows:
            w.writerow([
                r["timestamp"],
                r["speed"],
                r["density"],
                r["bt"],
                r["bz"],
                r["by"],
            ])

    # 2) magnetometer_irf_30d.csv
    mag_path = EXPORT_DIR / "magnetometer_irf_30d.csv"
    with mag_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "station",
            "timestamp",
            "deflection",
            "kirx",
            "kiry",
            "kirz",
            "kirf",
        ])
        for r in mag_rows:
            w.writerow([
                r["station"],
                r["timestamp"],
                r["deflection"],
                r["kirx"],
                r["kiry"],
                r["kirz"],
                r["kirf"],
            ])

    # 3) hp_index_30d.csv
    hp_path = EXPORT_DIR / "hp_index_30d.csv"
    with hp_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "hp30", "ap30", "hp60", "ap60"])
        for r in hp_rows:
            w.writerow([
                r["timestamp"],
                r["hp30"],
                r["ap30"],
                r["hp60"],
                r["ap60"],
            ])

    # 4) kp_index_30d.csv
    kp_path = EXPORT_DIR / "kp_index_30d.csv"
    with kp_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "kp"])
        for r in kp_rows:
            w.writerow([
                r["timestamp"],
                r["kp"],
            ])

    log(f"Exported 30 days to {EXPORT_DIR}")


if __name__ == "__main__":
    export_30_days()
