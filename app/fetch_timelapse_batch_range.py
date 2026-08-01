# app/fetch_timelapse_batch_range.py

import subprocess
from datetime import date, timedelta
from pathlib import Path
import sys
import shutil
import tempfile

def log(*args, **kwargs):
    print(*args, **kwargs)

IMAGE_ROOT = Path("data/images")
VIDEO_ROOT = Path("data/suvi-timelapse")
INSTRUMENTS = {
    "SDO": "SDO_BATCH",
    "SOHO": "SOHO_BATCH"
}

def get_all_image_types():
    types = []
    for instr, base in INSTRUMENTS.items():
        batch_dir = IMAGE_ROOT / base
        if not batch_dir.exists():
            continue
        for channel_dir in batch_dir.iterdir():
            if not channel_dir.is_dir():
                continue
            types.append(f"{instr}_{channel_dir.name}")
    return sorted(types)

def find_all_images_for_period(instrument, channel, start_date, end_date):
    batch_dir = IMAGE_ROOT / INSTRUMENTS[instrument] / channel
    all_files = []
    date = start_date
    while date <= end_date:
        year = date.strftime("%Y")
        month = date.strftime("%m")
        day = date.strftime("%d")
        img_dir = batch_dir / year / month / day
        files = sorted(list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpg")))
        all_files.extend(files)
        date += timedelta(days=1)
    return all_files, batch_dir

def generate_timelapse_for_period(
    instrument, channel, video_dir, img_files, period_str, ffmpeg_image="jrottenberg/ffmpeg:4.4-ubuntu"
):
    if not img_files:
        log(f"[{instrument}_{channel}] No images for {period_str}")
        return None

    video_dir.mkdir(parents=True, exist_ok=True)
    listfile = video_dir / f"input_{instrument}_{channel}_{period_str}.txt"
    # Bygg listan
    with open(listfile, "w") as f:
        for img in img_files:
            img_abs = img.resolve()
            rel = img_abs.relative_to(IMAGE_ROOT.resolve())
            f.write(f"file '/images/{rel.as_posix()}'\n")

    output_file = video_dir / f"{instrument}_{channel}_{period_str}.mp4"

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{video_dir.absolute()}:/vacam:rw",
        "-v", f"{IMAGE_ROOT.resolve()}:/images:ro",
        ffmpeg_image,
        "-f", "concat",
        "-safe", "0",
        "-i", f"/vacam/{listfile.name}",      # <--- ingen -framerate här!
        "-r", "120",                          # <--- sätt framerate här istället!
        "-c:v", "libx264",
        "-crf", "26",
        "-preset", "slow",
        "-vf", "format=yuv420p",
        f"/vacam/{output_file.name}"
    ]

    log(f"[{instrument}_{channel}] Skapar månads-timelapse: {' '.join(str(x) for x in cmd)}")
    try:
        subprocess.run(cmd, check=True)
        log(f"[{instrument}_{channel}] Timelapse skapad: {output_file}")
    except subprocess.CalledProcessError as err:
        log(f"[{instrument}_{channel}] ffmpeg error")
        return None
    finally:
        if listfile.exists():
            listfile.unlink()
    return output_file

def daterange(start_date, end_date):
    for n in range(int((end_date - start_date).days) + 1):
        yield start_date + timedelta(n)

def choose_interval_and_type():
    print("Ange startdatum (YYYY-MM-DD): ", end="")
    start = input().strip()
    print("Ange slutdatum (YYYY-MM-DD): ", end="")
    end = input().strip()
    types = get_all_image_types()
    print("\nTillgängliga instrument/kanaler:")
    for t in types:
        print(f"  {t}")
    print('Tryck Enter för att skapa för alla, eller ange kanal (t.ex. "SDO_193"): ', end="")
    sel = input().strip()
    if sel and sel in types:
        return start, end, [sel]
    elif sel:
        print("Fel kanal, avslutar.")
        sys.exit(1)
    return start, end, types

if __name__ == '__main__':
    # Menybaserad variant!
    start, end, types = choose_interval_and_type()
    start_date = date.fromisoformat(start)
    end_date = date.fromisoformat(end)

    for img_type in types:
        if "_" not in img_type:
            log(f"Unknown image type {img_type}, skipping.")
            continue
        instrument, channel = img_type.split("_", 1)
        img_files, img_root = find_all_images_for_period(instrument, channel, start_date, end_date)
        if not img_files:
            log(f"[{img_type}] Inga bilder för perioden {start} till {end}.")
            continue
        y, m = start_date.strftime("%Y"), start_date.strftime("%m")
        period_str = f"{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}"
        video_dir = VIDEO_ROOT / f"{instrument}_{channel}" / y / m
        out = generate_timelapse_for_period(instrument, channel, video_dir, img_files, period_str)
        if out:
            log(f"[{img_type}] Skapade timelapse: {out}")
        else:
            log(f"[{img_type}] Ingen timelapse (saknar bilder).")