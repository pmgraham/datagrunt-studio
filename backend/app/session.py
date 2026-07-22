from pathlib import Path

from app import datagrunt_service as svc
from app.config import load_settings
from app.query_engine import QueryEngine
from app.session_registry import SessionRegistry

SETTINGS = load_settings()
_SEED_DIR = Path(__file__).resolve().parent.parent / "seed"


class StudioSession:
    def __init__(self) -> None:
        self._engine = QueryEngine(SETTINGS.data_dir / "session.duckdb")
        self._registry = SessionRegistry(self._engine)
        self.parquet_dir = SETTINGS.data_dir / "parquet"
        self.upload_dir = SETTINGS.data_dir / "uploads"
        self._seeded = False

    def ensure_seeded(self) -> None:
        if not self._seeded:
            self._seeded = True
            try:
                self.seed()
            except Exception:
                self._seeded = False
                raise

    @property
    def engine(self) -> QueryEngine:
        self.ensure_seeded()
        return self._engine

    @property
    def registry(self) -> SessionRegistry:
        self.ensure_seeded()
        return self._registry

    def seed(self) -> None:
        self._seeded = True
        self._registry.reset()
        for csv_name in ("raw_sales_data.csv", "region_master.csv"):
            result = svc.parse_csv(_SEED_DIR / csv_name, self.parquet_dir)
            self._registry.add_from_parquet(csv_name, "csv", result.parquet_path)
        for result in svc.parse_excel(_SEED_DIR / "q4_forecast.xlsx", self.parquet_dir):
            self._registry.add_from_parquet("q4_forecast.xlsx", "excel", result.parquet_path, result.sheet)


SESSION = StudioSession()
