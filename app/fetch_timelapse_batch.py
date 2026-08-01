# app/fetch_timelapse_batch.py

import subprocess
from datetime import date, timedelta
from pathlib import Path
import sys

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

def find_image_files(instrument, channel, date_obj):
    batch_dir = IMAGE_ROOT / INSTRUMENTS[instrument] / channel
    year = date_obj.strftime("%Y")
    month = date_obj.strftime("%m")
    day = date_obj.strftime("%d")
    img_dir = batch_dir / year / month / day
    files = sorted(img_dir.glob("*.png")) + sorted(img_dir.glob("*.jpg"))
    return files, img_dir

def generate_timelapse_for_date(date: date, instrument: str, channel: str, video_dir: Path, img_files, image_prefix: str, ffmpeg_image: str = "jrottenberg/ffmpeg:4.4-ubuntu") -> Path:
    date_str = date.strftime("%Y%m%d")
    if not img_files:
        log(f"[{instrument}_{channel}] No matching images for {date}: {video_dir}")
        return None

    ext = img_files[0].suffix
    image_dir = img_files[0].parent
    pattern = f"{instrument}_{channel}_{date.strftime('%Y%m%d')}T*Z{ext}"
    output_file = video_dir / f"{instrument}_{channel}_{date.strftime('%Y%m%d')}.mp4"
    video_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{image_dir.absolute()}:/images:ro",
        "-v", f"{video_dir.absolute()}:/vacam:rw",
        ffmpeg_image,
        "-framerate", "25",
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
    except subprocess.CalledProcessError as err:
        log(f"[{instrument}_{channel}] Error in ffmpeg, images saved for troubleshooting.")
        return None
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

    for single_date in daterange(start_date, end_date):
        y, m = single_date.strftime("%Y"), single_date.strftime("%m")
        for img_type in types:
            if "_" not in img_type:
                log(f"Unknown image type {img_type}, skipping.")
                continue
            instrument, channel = img_type.split("_", 1)
            img_files, img_dir = find_image_files(instrument, channel, single_date)
            if not img_dir.exists():
                log(f"Image dir {img_dir} does not exist, skipping.")
                continue
            video_dir = VIDEO_ROOT / f"{instrument}_{channel}" / y / m
            prefix = f"{instrument}_{channel}_{single_date.strftime('%Y%m%d')}_"
            out = generate_timelapse_for_date(single_date, instrument, channel, video_dir, img_files, prefix)
            if out:
                log(f"[{instrument}_{channel}] Created timelapse: {out}")
            else:
                log(f"[{instrument}_{channel}] No timelapse made (missing images).")
