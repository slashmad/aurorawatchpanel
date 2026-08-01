#!/usr/bin/env python3
import re
import os
import time
import subprocess
import argparse
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ---------------------------
# Config
# ---------------------------
APP_DIR = Path(os.getenv("APP_DIR", str(Path(__file__).resolve().parent)))
ROOT = APP_DIR / "data" / "images" / "lyckebocam"
TMP_BASE = APP_DIR / "data" / "tmp"

TZ_NAME = "Europe/Stockholm"   # Window defined in local time
START_LOCAL = "15:00"          # Yesterday 15:00
END_LOCAL = "07:00"            # Today 07:00

FPS = 30
CRF = 23
PRESET = "veryfast"

FFMPEG_IMAGE = "jrottenberg/ffmpeg:4.4-ubuntu"

# Full images look like: Lyckebo_20260116T000521Z.jpg
RE_IMG = re.compile(r"^Lyckebo_(\d{8})T(\d{6})Z\.(jpg|jpeg|png)$", re.IGNORECASE)

def parse_hhmm(s: str) -> tuple[int, int]:
    hh, mm = s.split(":")
    return int(hh), int(mm)

def day_dir(root: Path, d) -> Path:
    return root / f"{d.year:04d}" / f"{d.month:02d}" / f"{d.day:02d}"

def file_ts_utc(name: str) -> datetime | None:
    m = RE_IMG.match(name)
    if not m:
        return None
    ymd = m.group(1)
    hms = m.group(2)
    return datetime.strptime(ymd + hms, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)

def collect_files_in_range(root: Path, start_utc: datetime, end_utc: datetime, dirs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for dd in dirs:
        if not dd.exists():
            continue
        for p in dd.iterdir():
            if not p.is_file():
                continue
            name_l = p.name.lower()
            if "_thumb" in name_l:
                continue
            ts = file_ts_utc(p.name)
            if not ts:
                continue
            if start_utc <= ts <= end_utc:
                files.append(p)

    files.sort(key=lambda p: file_ts_utc(p.name) or datetime.min.replace(tzinfo=timezone.utc))
    return files

def write_concat_list(tmp_dir: Path, files: list[Path]) -> Path:
    lst = tmp_dir / "concat.txt"
    with lst.open("w", encoding="utf-8") as f:
        for p in files:
            f.write(f"file '{str(p)}'\n")
    return lst

def run_ffmpeg_docker(workdir: Path, concat_list: Path, out_mp4: Path) -> None:
    # Mount /mnt so paths are valid inside container
    cmd = [
        "docker", "run", "--rm",
        "-v", "/mnt:/mnt",
        "-w", str(workdir),
        FFMPEG_IMAGE,
        "-hide_banner", "-loglevel", "warning",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_list),
        "-r", str(FPS),
        "-c:v", "libx264",
        "-preset", PRESET,
        "-crf", str(CRF),
        "-pix_fmt", "yuv420p",
        str(out_mp4),
    ]
    subprocess.check_call(cmd)

def parse_args():
    ap = argparse.ArgumentParser(description="Build Lyckebo timelapse for a chosen night window.")
    ap.add_argument(
        "--night",
        default="",
        help="Night start date in YYYY-MM-DD (local time). Example: 2026-01-17 means 2026-01-17 15:00 -> 2026-01-18 07:00",
    )
    return ap.parse_args()


def main() -> int:
    args = parse_args()

    tz = ZoneInfo(TZ_NAME)
    now_local = datetime.now(tz)

    if args.night:
        night_start_date = datetime.strptime(args.night, "%Y-%m-%d").date()
        night_end_date = night_start_date + timedelta(days=1)
    else:
        night_end_date = now_local.date()
        night_start_date = night_end_date - timedelta(days=1)

    sh, sm = parse_hhmm(START_LOCAL)
    eh, em = parse_hhmm(END_LOCAL)

    start_local = datetime(night_start_date.year, night_start_date.month, night_start_date.day, sh, sm, tzinfo=tz)
    end_local = datetime(night_end_date.year, night_end_date.month, night_end_date.day, eh, em, tzinfo=tz)

    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)

    # We expect frames in start-date folder and end-date folder
    y_dir = day_dir(ROOT, night_start_date)
    t_dir = day_dir(ROOT, night_end_date)

    files = collect_files_in_range(ROOT, start_utc, end_utc, [y_dir, t_dir])

    if len(files) < 2:
        print(f"Not enough frames: {len(files)}")
        print(f"Range local: {start_local} -> {end_local}")
        print(f"Range UTC:   {start_utc} -> {end_utc}")
        print(f"Dirs: {y_dir} , {t_dir}")
        return 0

    # Output goes into yesterday's folder (the night that was)
    out_dir = y_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    out_name = f"Lyckebo_timelapse_{night_start_date:%Y%m%d}_{START_LOCAL.replace(':','')}-{END_LOCAL.replace(':','')}.mp4"
    out_mp4 = out_dir / out_name

    TMP_BASE.mkdir(parents=True, exist_ok=True)
    tmp_dir = TMP_BASE / f"lyckebo_timelapse_{int(time.time())}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    concat_list = write_concat_list(tmp_dir, files)

    print(f"Frames: {len(files)}")
    print(f"Output: {out_mp4}")

    run_ffmpeg_docker(tmp_dir, concat_list, out_mp4)

    # Best-effort cleanup
    try:
        concat_list.unlink(missing_ok=True)
        tmp_dir.rmdir()
    except Exception:
        pass

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
