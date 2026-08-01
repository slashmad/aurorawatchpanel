# ---- app/fetch_enlil_fits.py ----
import os
import requests
from bs4 import BeautifulSoup

BASE_URLS = {
    "enlil": "https://services.swpc.noaa.gov/images/animations/enlil/",
    "ccor1": "https://services.swpc.noaa.gov/images/animations/ccor1/",
    "lasco-c2": "https://services.swpc.noaa.gov/images/animations/lasco-c2/",
    "lasco-c3": "https://services.swpc.noaa.gov/images/animations/lasco-c3/",
}

OUTDIR = "data/noaa_anim"

def clear_folder(folder):
    for f in os.listdir(folder):
        fp = os.path.join(folder, f)
        try:
            if os.path.isfile(fp):
                os.remove(fp)
        except Exception as e:
            print(f"Could not remove {fp}: {e}")

def fetch_and_store(product, url):
    target_dir = os.path.join(OUTDIR, product)
    os.makedirs(target_dir, exist_ok=True)
    print(f"\n-- {product.upper()} --")

    # Lista filer på NOAA (utom latest.jpg)
    r = requests.get(url)
    soup = BeautifulSoup(r.text, "html.parser")
    links = [
        a['href'] for a in soup.find_all('a', href=True)
        if any(a['href'].lower().endswith(ext) for ext in ['.gif', '.png', '.jpg', '.jpeg', '.mp4'])
        and not a['href'].lower().endswith('latest.jpg')
    ]
    remote_files = set(os.path.basename(l) for l in links)
    local_files = set(f for f in os.listdir(target_dir) if os.path.isfile(os.path.join(target_dir, f)))

    # Hämta endast filer som saknas
    new_files = remote_files - local_files
    if not new_files:
        print("Inga nya filer att hämta.")
    for fname in new_files:
        full_url = url + fname
        outpath = os.path.join(target_dir, fname)
        print(f"Laddar ned {full_url} -> {outpath}")
        try:
            resp = requests.get(full_url, stream=True, timeout=60)
            with open(outpath, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
        except Exception as e:
            print(f"Fel vid hämtning av {full_url}: {e}")

    # (Valfritt) Radera lokala filer som inte längre finns på NOAA:
    obsolete = local_files - remote_files
    for fname in obsolete:
        try:
            os.remove(os.path.join(target_dir, fname))
            print(f"Tog bort {fname} (finns ej längre på NOAA)")
        except Exception as e:
            print(f"Kunde ej ta bort {fname}: {e}")


def main():
    for prod, url in BASE_URLS.items():
        fetch_and_store(prod, url)

import time

if __name__ == "__main__":
    while True:
        main()
        print("Fetch klar, väntar 1 timme...")
        time.sleep(3600)  # kör igen om 1 timme