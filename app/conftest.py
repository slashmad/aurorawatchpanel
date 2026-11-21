import os
import sys
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent
os.environ.setdefault("DATA_DIR", str(REPO_DIR / "tests/fixtures/data"))
os.environ.setdefault("ALLSKY_FS_ROOT", str(REPO_DIR / "tests/fixtures/allsky-images"))
os.chdir(APP_DIR)
sys.path.insert(0, str(APP_DIR))
