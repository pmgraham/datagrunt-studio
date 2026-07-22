import os
import shutil
from pathlib import Path

# Override the data directory to avoid conflicts with the running dev server
TEST_DATA_DIR = "/tmp/datagrunt-studio-test"
os.environ["STUDIO_DATA_DIR"] = TEST_DATA_DIR

# Clean up any leftover test data directory
path = Path(TEST_DATA_DIR)
if path.exists():
    shutil.rmtree(path, ignore_errors=True)
