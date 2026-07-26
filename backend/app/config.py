import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    result_row_cap: int = 200
    backend_host: str = "127.0.0.1"
    backend_port: int = 8000


def default_data_dir() -> Path:
    """A per-user private location for session data.

    /tmp is world-readable and world-writable: any other local account could
    read every imported dataset, and because the directory is created with
    exist_ok=True, someone who pre-creates the path owns it and can redirect
    Studio's writes through a symlink.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    # The XDG Base Directory spec requires relative values to be ignored;
    # honouring one would silently resolve it against the process's CWD.
    xdg_is_usable = bool(xdg) and Path(xdg).is_absolute()
    base = Path(xdg) if xdg_is_usable else Path.home() / ".local" / "share"
    return base / "datagrunt-studio"


def ensure_private_dir(path: Path) -> None:
    """Create (or tighten) the data directory so only its owner can read it.

    Ownership is checked before chmod, not after: POSIX chmod requires the
    caller to already own the target, so attempting it first against a
    directory owned by another user raises a bare PermissionError and the
    clearer RuntimeError below is never reached. Checking first means a
    foreign-owned directory always produces the intended diagnostic.

    mkdir's mode is masked by the umask and ignored outright when the
    directory already exists, so the chmod is not redundant for the
    directory-we-own case.
    """
    path.mkdir(parents=True, exist_ok=True, mode=0o700)

    if hasattr(os, "getuid") and path.stat().st_uid != os.getuid():
        raise RuntimeError(f"Refusing to use data directory {path}: it is owned by another user.")

    path.chmod(0o700)


def load_settings() -> Settings:
    configured = os.environ.get("STUDIO_DATA_DIR")
    data_dir = Path(configured).resolve() if configured else default_data_dir().resolve()
    ensure_private_dir(data_dir)
    return Settings(data_dir=data_dir)
