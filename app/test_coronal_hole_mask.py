# /app/test_coronal_hole_mask.py
from pathlib import Path
from datetime import datetime, timezone
import argparse
import cv2
import numpy as np

# Keep paths in sync with detect_coronal_hole.py
IMAGE_DIR = Path("/app/data/images/SDO_193")
HOLE_DIR = Path("/app/data/images/coronal-holes")
HOLE_DIR.mkdir(parents=True, exist_ok=True)

def load_latest_image() -> Path | None:
    files = sorted([f for f in IMAGE_DIR.glob("SDO_193_*.jpg") if "_thumb" not in f.name], reverse=True)
    return files[0] if files else None

def compute_masks(gray: np.ndarray, thresh_val: int = 70):
    """Return (mask_circle, mask_dark, bbox or None) following detect_coronal_hole.py logic."""
    if gray.ndim == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    cx, cy = w // 2, h // 2
    radius = int(0.47 * w)

    # Sun disk mask
    yy, xx = np.ogrid[:h, :w]
    mask_circle = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2

    # Dark (coronal hole) mask inside disk
    mask_dark = (gray < thresh_val) & mask_circle

    # Largest contour bbox (if any)
    contours, _ = cv2.findContours(mask_dark.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bbox = None
    if contours:
        largest = max(contours, key=cv2.contourArea)
        x, y, w_box, h_box = cv2.boundingRect(largest)
        bbox = (x, y, w_box, h_box)

    return mask_circle, mask_dark, bbox

def save_debug_outputs(img_bgr: np.ndarray, mask_circle: np.ndarray, mask_dark: np.ndarray, bbox):
    """Write debug images to HOLE_DIR."""
    # 1) save input (scaled)
    h, w = img_bgr.shape[:2]
    scale = 900 / max(h, w)
    img_small = cv2.resize(img_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(HOLE_DIR / "DEBUG_input.jpg"), img_small, [int(cv2.IMWRITE_JPEG_QUALITY), 90])

    # 2) save masks (uint8)
    cv2.imwrite(str(HOLE_DIR / "DEBUG_sun_circle.jpg"), (mask_circle * 255).astype(np.uint8))
    cv2.imwrite(str(HOLE_DIR / "DEBUG_dark_mask.jpg"), (mask_dark * 255).astype(np.uint8))

    # 3) overlay (semi-transparent)
    overlay = img_bgr.copy()
    # blue for disk, red for dark mask
    disk_rgba = np.zeros_like(img_bgr, dtype=np.uint8)
    disk_rgba[..., 1] = 120  # green-ish for disk
    hole_rgba = np.zeros_like(img_bgr, dtype=np.uint8)
    hole_rgba[..., 2] = 200  # red for dark areas

    # alpha-blend only on masked pixels
    alpha_disk = 0.15
    alpha_hole = 0.35
    overlay[mask_circle] = cv2.addWeighted(img_bgr[mask_circle], 1 - alpha_disk, disk_rgba[mask_circle], alpha_disk, 0)
    overlay[mask_dark] = cv2.addWeighted(overlay[mask_dark], 1 - alpha_hole, hole_rgba[mask_dark], alpha_hole, 0)

    # draw contours and bbox for the largest hole
    cnts, _ = cv2.findContours(mask_dark.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        cv2.drawContours(overlay, cnts, -1, (0, 255, 255), 2)
    if bbox:
        x, y, bw, bh = bbox
        cv2.rectangle(overlay, (x, y), (x + bw, y + bh), (255, 255, 0), 2)

    cv2.imwrite(str(HOLE_DIR / "DEBUG_overlay.jpg"), overlay, [int(cv2.IMWRITE_JPEG_QUALITY), 92])

def main():
    ap = argparse.ArgumentParser(description="Visualize coronal-hole mask used by detector.")
    ap.add_argument("--image", type=str, default="", help="Path to SDO_193 image (if omitted, latest is used).")
    ap.add_argument("--thresh", type=int, default=70, help="Threshold value (default: 70 to match detector).")
    args = ap.parse_args()

    img_path = Path(args.image) if args.image else load_latest_image()
    if not img_path or not img_path.exists():
        print("No SDO_193 image found. Expected under:", IMAGE_DIR)
        return

    img_bgr = cv2.imread(str(img_path), cv2.IMREAD_COLOR)
    if img_bgr is None:
        print("Failed to read image:", img_path)
        return

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    mask_circle, mask_dark, bbox = compute_masks(gray, args.thresh)

    area_fraction = mask_dark.sum() / max(1, mask_circle.sum())
    print(f"[INFO] Image: {img_path.name}")
    print(f"[INFO] Threshold: {args.thresh}")
    print(f"[INFO] area_fraction = {area_fraction:.4f}")
    print(f"[INFO] bbox = {bbox}")

    save_debug_outputs(img_bgr, mask_circle, mask_dark, bbox)
    print(f"[OK] Wrote:")
    print(f"  - {HOLE_DIR / 'DEBUG_input.jpg'}")
    print(f"  - {HOLE_DIR / 'DEBUG_sun_circle.jpg'}")
    print(f"  - {HOLE_DIR / 'DEBUG_dark_mask.jpg'}")
    print(f"  - {HOLE_DIR / 'DEBUG_overlay.jpg'}")

if __name__ == "__main__":
    main()
