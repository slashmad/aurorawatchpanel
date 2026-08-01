import requests
from datetime import datetime, timedelta
import os
from tqdm import tqdm

# Lista över vanliga SDO/AIA våglängder och deras sourceId i Helioviewer
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

def choose_date_and_wavelength():
    datum = input("Ange datum (YYYY-MM-DD): ").strip()
    print("Tillgängliga våglängder (AIA):")
    for w in sorted(AIA_SOURCES.keys()):
        print(f"  {w} Å")
    wl = input("Ange våglängd (t.ex. 193): ").strip()
    if wl not in AIA_SOURCES:
        print("Fel våglängd, avslutar.")
        exit(1)
    return datum, wl

def ensure_dir(path):
    if not os.path.exists(path):
        os.makedirs(path)

def main():
    datum, wl = choose_date_and_wavelength()
    source_id = AIA_SOURCES[wl]
    out_dir = f"/app/data/images/SDO_BATCH/{wl}"
    ensure_dir(out_dir)

    start_dt = datetime.fromisoformat(datum + "T00:00:00")
    end_dt = datetime.fromisoformat(datum + "T23:59:59")
    step = timedelta(minutes=5)
    times = []
    dt = start_dt
    while dt <= end_dt:
        times.append(dt)
        dt += step

    print(f"Hämtar SDO/AIA {wl} för {datum} ... (kan ta tid)")
    seen_ids = set()
    for dt in tqdm(times, desc="Bilder"):
        dt_str = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        # (resten av loopen som förut, samma kod som tidigare)
        resp = requests.get(
            "https://api.helioviewer.org/v2/getClosestImage/",
            params={"date": dt_str, "sourceId": source_id}
        )
        data = resp.json()
        jp2_id = data.get("id")
        actual_date = data.get("date", "")
        if not jp2_id or jp2_id in seen_ids or not actual_date.startswith(datum):
            continue
        seen_ids.add(jp2_id)

        # Skapa datum-mapp
        date_part = actual_date[:10]  # "YYYY-MM-DD"
        year, month, day = date_part.split("-")
        date_dir = os.path.join(out_dir, year, month, day)
        ensure_dir(date_dir)

        outname = f"{date_part.replace('-','')}_{wl}A_{actual_date.replace(':','').replace('-','').replace('T','_').replace('Z','')}.png"
        outpath = os.path.join(date_dir, outname)
        if os.path.isfile(outpath):
            continue

        resp2 = requests.get(
            "https://api.helioviewer.org/v2/downloadImage/",
            params={
                "id": jp2_id,
                "format": "png",
                "imageScale": 1.0
            }
        )
        if resp2.status_code == 200 and resp2.content:
            with open(outpath, "wb") as f:
                f.write(resp2.content)
        # ... (ingen print per bild behövs längre – tqdm visar progress!)

if __name__ == "__main__":
    main()
