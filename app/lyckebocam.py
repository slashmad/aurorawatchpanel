import os
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

PAGE_URL = "https://lyckebosommargard.se/auroracam/"
OUT_DIR = "./lyckebo_auroracam"
TIMEOUT = 20

def normalize_webcam_url(url: str) -> str:
    # De verkar ibland ha dubbel slash efter Webcam ("/Webcam//fil.JPG")
    url = re.sub(r"/Webcam/+", "/Webcam/", url)
    return url

def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)

    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; auroracam-saver/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    r = requests.get(PAGE_URL, headers=headers, timeout=TIMEOUT)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")

    # Leta efter första länken som pekar på Webcam-bilder
    a = soup.find("a", href=lambda h: isinstance(h, str) and "/wp-content/uploads/Webcam/" in h)
    if not a or not a.get("href"):
        print("Hittade ingen bildlänk på sidan.", file=sys.stderr)
        return 2

    img_url = normalize_webcam_url(urljoin(PAGE_URL, a["href"]))
    filename = os.path.basename(urlparse(img_url).path)
    if not filename:
        print(f"Kunde inte läsa filnamn från URL: {img_url}", file=sys.stderr)
        return 3

    out_path = os.path.join(OUT_DIR, filename)
    if os.path.exists(out_path):
        print(f"Redan hämtad: {out_path}")
        return 0

    # Cache-bust (ibland onödigt, men skadar inte)
    bust_url = img_url + ("&" if "?" in img_url else "?") + f"ts={int(time.time())}"

    img_r = requests.get(bust_url, headers={"User-Agent": headers["User-Agent"]}, timeout=TIMEOUT, stream=True)
    img_r.raise_for_status()

    tmp_path = out_path + ".part"
    with open(tmp_path, "wb") as f:
        for chunk in img_r.iter_content(chunk_size=1024 * 256):
            if chunk:
                f.write(chunk)

    os.replace(tmp_path, out_path)
    print(f"Sparade: {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
