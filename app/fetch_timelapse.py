# app/fetch_timelapse.py

import subprocess
from datetime import date, datetime
from pathlib import Path
from utils import log
import sys

# Sökvägar
IMAGE_ROOT = Path("data/images")
VIDEO_ROOT = Path("data/suvi-timelapse")

def generate_timelapse_for_date(date: date, image_dir: Path, video_dir: Path, image_prefix: str, ffmpeg_image: str = "jrottenberg/ffmpeg:4.4-ubuntu") -> Path:
    date_str = date.strftime("%Y%m%d")
    pattern = f"{image_prefix}{date_str}T*.jpg"
    output_file = video_dir / f"{image_prefix}{date_str}.mp4"
    video_dir.mkdir(parents=True, exist_ok=True)
    image_files = sorted(image_dir.glob(pattern))
    if not image_files:
        log(f"[{image_prefix.rstrip('_')}] No matching images: {image_dir}/{pattern}")
        return None

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
    log(f"[{image_prefix.rstrip('_')}] Creating timelapse: {' '.join(str(x) for x in cmd)}")
    try:
        subprocess.run(cmd, check=True)
        log(f"[{image_prefix.rstrip('_')}] Timelapse created: {output_file}")
        # Delete all matching frames after successful timelapse creation (handles files added during ffmpeg run)
        deleted = 0
        for img in image_dir.glob(pattern):
            try:
                img.unlink()
                deleted += 1
            except Exception as e:
                log(f"  Could not delete {img}: {e}")
        log(f"[{image_prefix.rstrip('_')}] Deleted {deleted} frames for {pattern}")
    except subprocess.CalledProcessError as err:
        log(f"[{image_prefix.rstrip('_')}] Error in ffmpeg, images saved for troubleshooting.")
        return None
    return output_file

EXCLUDED_FOLDERS = {"synoptic", "coronal-holes", "lyckebocam"}
def get_all_image_types():
    allowed_prefixes = ("SUVI_", "SDO_")
    out = []
    for d in IMAGE_ROOT.iterdir():
        if not d.is_dir():
            continue
        name = d.name
        if name.lower() in EXCLUDED_FOLDERS:
            continue
        if name.startswith(allowed_prefixes):
            out.append(name)
    return out

if __name__ == '__main__':
    # Usage: python3 fetch_timelapse.py YYYY-MM-DD [<image_type>]
    if len(sys.argv) < 2 or len(sys.argv) > 3:
        log("Usage: fetch_timelapse.py YYYY-MM-DD [<image_type>]")
        sys.exit(1)

    date_obj = date.fromisoformat(sys.argv[1])
    y, m = date_obj.strftime("%Y"), date_obj.strftime("%m")

    # Hantera prefix/kanal
    if len(sys.argv) == 3:
        types = [sys.argv[2]]
    else:
        types = get_all_image_types()

    for img_type in types:
        image_dir = IMAGE_ROOT / img_type
        if not image_dir.exists():
            log(f"Image dir {image_dir} does not exist, skipping.")
            continue
        # Skapa output-mapp per år/månad och kanal
        video_dir = VIDEO_ROOT / img_type / y / m
        prefix = img_type + "_"
        out = generate_timelapse_for_date(date_obj, image_dir, video_dir, prefix)
        if out:
            log(f"[{prefix.rstrip('_')}] Created timelapse: {out}")
        else:
            log(f"[{prefix.rstrip('_')}] No timelapse made (missing images).")
