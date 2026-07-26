import os
import stat

from app.config import default_data_dir, ensure_private_dir, load_settings


def test_default_is_not_shared_tmp():
    assert not str(default_data_dir()).startswith("/tmp/")


def test_default_honours_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert default_data_dir() == tmp_path / "datagrunt-studio"


def test_created_directory_is_private(tmp_path):
    target = tmp_path / "fresh"
    ensure_private_dir(target)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700


def test_permissive_existing_directory_is_tightened(tmp_path):
    target = tmp_path / "loose"
    target.mkdir(mode=0o777)
    os.chmod(target, 0o777)
    ensure_private_dir(target)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700


def test_env_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_DATA_DIR", str(tmp_path / "explicit"))
    assert load_settings().data_dir == (tmp_path / "explicit").resolve()
