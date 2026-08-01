import requests
from datetime import datetime, timedelta
import os
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor
import threading

AIA_SOURCES = {
    "94": 8,
    "131": 9,
    "171": 10,
    "193": 11,
    "211": 12,
    "304": 13,
    "335": 14,
    "1600": 15,
    "1700": 16,
    "4500": 17,
}

def choose_interval_and_wavelength():
    start = input("Ange startdatum (YYYY-MM-DD): ").strip()
    end = input("Ange slutdatum (YYYY-MM-DD): ").strip()
    print("Tillgängliga våglängder (AIA):")
    for w in sorted(AIA_SOURCES.keys(), key=int):
        print(f"  {w} Å")
    wl = input("Ange våglängd (t.ex. 193): ").strip()
    if wl not in AIA_SOURCES:
        print("Fel våglängd, avslutar.")
        exit(1)
    return start, end, wl

def ensure_dir(path):
    if not os.path.exists(path):
        os.makedirs(path)

def daterange(start_date, end_date):
    for n in range(int((end_date - start_date).days) + 1):
        yield start_date + timedelta(n)

def download_image(dt, wl, source_id, out_dir, start, end, seen_ids, lock):
    dt_str = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        resp = requests.get(
            "https://api.helioviewer.org/v2/getClosestImage/",
            params={"date": dt_str, "sourceId": source_id},
            timeout=30
        )
        data = resp.json()
        jp2_id = data.get("id")
        actual_date = data.get("date", "")
        if not jp2_id or not actual_date:
            return False
        date_part = actual_date[:10]
        # Kontrollera att bilden är från rätt dag i intervallet
        if not (start <= date_part <= end):
            return False
        with lock:
            if jp2_id in seen_ids:
                return False
            seen_ids.add(jp2_id)
        year, month, day = date_part.split("-")
        date_dir = os.path.join(out_dir, year, month, day)
        ensure_dir(date_dir)
        # Spara filen med nytt format!
        actual_date_fmt = actual_date.replace("-", "").replace(":", "").replace(" ", "T")
        if not actual_date_fmt.endswith("Z"):
            actual_date_fmt += "Z"
        outname = f"SDO_{wl}_{actual_date_fmt}.png"
        outpath = os.path.join(date_dir, outname)
        if os.path.isfile(outpath):
            return True
        resp2 = requests.get(
            "https://api.helioviewer.org/v2/downloadImage/",
            params={
                "id": jp2_id,
                "format": "png",
                "imageScale": 1.0
            },
            timeout=60
        )
        if resp2.status_code == 200 and resp2.content:
            with open(outpath, "wb") as f:
                f.write(resp2.content)
            return True
    except Exception as e:
        print(f"\nFel för {dt_str}: {e}")
    return False

def main():
    start, end, wl = choose_interval_and_wavelength()
    source_id = AIA_SOURCES[wl]
    out_dir = f"/app/data/images/SDO_BATCH/{wl}"
    ensure_dir(out_dir)

    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end)
    step = timedelta(minutes=30)

    all_times = []
    for single_date in daterange(start_dt, end_dt):
        day_start = single_date.replace(hour=0, minute=0, second=0)
        day_end = single_date.replace(hour=23, minute=59, second=59)
        dt = day_start
        while dt <= day_end:
            all_times.append(dt)
            dt += step

    print(f"Hämtar SDO/AIA {wl} från {start} till {end} ... (parallellt, kan ta tid)")
    seen_ids = set()
    lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=10) as executor:  # max 3 trådar samtidigt!
        list(tqdm(
            executor.map(
                lambda t: download_image(t, wl, source_id, out_dir, start, end, seen_ids, lock),
                all_times
            ),
            total=len(all_times),
            desc="Bilder"
        ))

if __name__ == "__main__":
    main()
