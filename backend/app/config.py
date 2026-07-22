import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    result_row_cap: int = 200
    backend_host: str = "127.0.0.1"
    backend_port: int = 8000


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("STUDIO_DATA_DIR", "/tmp/datagrunt-studio")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    return Settings(data_dir=data_dir)
