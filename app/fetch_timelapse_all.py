# app/fetch_timelapse.py

import subprocess
from datetime import date, datetime
from pathlib import Path
import sys

def log(*args, **kwargs):
    print(*args, **kwargs)

IMAGE_ROOT = Path("data/images")
VIDEO_ROOT = Path("data/suvi-timelapse")
EXCLUDED_FOLDERS = {"synoptic"}

# Instrument/katalognamn → undermapp
INSTRUMENTS = {
    "SDO": "SDO_BATCH",
    "SOHO": "SOHO_BATCH"
}

def get_all_image_types():
    # Ger alla möjliga instrument_kanal, t.ex. SDO_193, SOHO_195
    types = []
    for instr, base in INSTRUMENTS.items():
        batch_dir = IMAGE_ROOT / base
        if not batch_dir.exists():
            continue
        for channel_dir in batch_dir.iterdir():
            if not channel_dir.is_dir():
                continue
            types.append(f"{instr}_{channel_dir.name}")
    return types

def find_image_files(instrument, channel, date_obj):
    batch_dir = IMAGE_ROOT / INSTRUMENTS[instrument] / channel
    year = date_obj.strftime("%Y")
    month = date_obj.strftime("%m")
    day = date_obj.strftime("%d")
    img_dir = batch_dir / year / month / day
    # Hämta alla PNG och JPG i rätt dag-mapp
    files = sorted(img_dir.glob("*.png")) + sorted(img_dir.glob("*.jpg"))
    return files, img_dir

def generate_timelapse_for_date(date: date, instrument: str, channel: str, video_dir: Path, img_files, image_prefix: str, ffmpeg_image: str = "jrottenberg/ffmpeg:4.4-ubuntu") -> Path:
    date_str = date.strftime("%Y%m%d")
    if not img_files:
        log(f"[{instrument}_{channel}] No matching images for {date}: {video_dir}")
        return None

    # Skapa glob-mönster för docker/ffmpeg (alla PNG eller JPG på datumet med prefix)
    ext = img_files[0].suffix  # .png eller .jpg
    image_dir = img_files[0].parent
    pattern = f"{image_prefix}{date_str}_*{ext}"
    output_file = video_dir / f"{image_prefix}{date_str}.mp4"
    video_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{image_dir.absolute()}:/images:ro",
        "-v", f"{video_dir.absolute()}:/vacam:rw",
        ffmpeg_image,
        "-framerate", "12",
        "-pattern_type", "glob",
        "-i", f"/images/{pattern}",
        "-c:v", "libx264",
        "-crf", "26",
        "-preset", "slow",
        "-vf", "format=yuv420p",
        f"/vacam/{output_file.name}"
    ]
    log(f"[{instrument}_{channel}] Creating timelapse: {' '.join(str(x) for x in cmd)}")
    try:
        subprocess.run(cmd, check=True)
        log(f"[{instrument}_{channel}] Timelapse created: {output_file}")
        # Ta bort bilder efteråt (valfritt, kommentera bort om du vill spara!)
        for img in img_files:
            try:
                img.unlink()
            except Exception as e:
                log(f"  Kunde inte ta bort {img}: {e}")
    except subprocess.CalledProcessError as err:
        log(f"[{instrument}_{channel}] Error in ffmpeg, images saved for troubleshooting.")
        return None
    return output_file

if __name__ == '__main__':
    # Usage: python3 fetch_timelapse.py YYYY-MM-DD [<instrument_kanal>]
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        log("Usage: fetch_timelapse.py YYYY-MM-DD [<instrument_kanal>]")
        sys.exit(1)

    date_obj = date.fromisoformat(sys.argv[1])
    y, m = date_obj.strftime("%Y"), date_obj.strftime("%m")

    # Hantera prefix/kanal
    if len(sys.argv) == 3:
        types = [sys.argv[2]]
    else:
        types = get_all_image_types()

    for img_type in types:
        # Tolka "SDO_193", "SOHO_195" osv
        if "_" not in img_type:
            log(f"Unknown image type {img_type}, skipping.")
            continue
        instrument, channel = img_type.split("_", 1)
        img_files, img_dir = find_image_files(instrument, channel, date_obj)
        if not img_dir.exists():
            log(f"Image dir {img_dir} does not exist, skipping.")
            continue
        video_dir = VIDEO_ROOT / instrument / channel / y / m
        prefix = f"{date_obj.strftime('%Y%m%d')}_{channel}A_"
        # Skapa "prefix" som matchar filnamn t.ex. 20240517_193A_...
        out = generate_timelapse_for_date(date_obj, instrument, channel, video_dir, img_files, prefix)
        if out:
            log(f"[{instrument}_{channel}] Created timelapse: {out}")
        else:
            log(f"[{instrument}_{channel}] No timelapse made (missing images).")
