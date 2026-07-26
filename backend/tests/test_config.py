import os
import stat
from pathlib import Path

import pytest

from app.config import default_data_dir, ensure_private_dir, load_settings


def test_default_is_not_shared_tmp():
    assert not str(default_data_dir()).startswith("/tmp/")


def test_default_honours_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert default_data_dir() == tmp_path / "datagrunt-studio"


def test_relative_xdg_data_home_is_ignored(monkeypatch, tmp_path):
    """The XDG spec requires a relative value to be ignored; honouring one
    would silently resolve it against the process's CWD instead."""
    monkeypatch.setenv("XDG_DATA_HOME", "relative/path")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert default_data_dir() == tmp_path / ".local" / "share" / "datagrunt-studio"


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


def test_foreign_owned_directory_raises_before_chmod(monkeypatch, tmp_path):
    """Ownership must be checked before chmod: POSIX chmod requires the
    caller to already own the target, so a foreign-owned directory makes the
    real chmod syscall itself raise a bare PermissionError. Simulate that
    directly (monkeypatching os.getuid alone does not: it fakes what Python
    sees, but the real chmod syscall checks the process's actual OS-level
    UID, which is unaffected, so chmod would still silently succeed here).
    A fake chmod reproduces the real failure so this test actually pins the
    ordering rather than only the after-the-fact comparison."""
    target = tmp_path / "foreign"
    target.mkdir(mode=0o700)
    real_uid = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: real_uid + 1)

    def fake_chmod(self, mode):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(Path, "chmod", fake_chmod)

    with pytest.raises(RuntimeError, match="owned by another user"):
        ensure_private_dir(target)


def test_env_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_DATA_DIR", str(tmp_path / "explicit"))
    assert load_settings().data_dir == (tmp_path / "explicit").resolve()
