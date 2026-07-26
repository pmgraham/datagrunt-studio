import logging
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


def test_explicit_dir_foreign_owner_is_warned_not_raised(monkeypatch, tmp_path, caplog):
    """The regression this guards: an operator who points STUDIO_DATA_DIR at
    a specific directory has made a deliberate placement decision, so
    foreign ownership there is expected rather than suspicious (e.g. a
    container bind mount created by the host user but written to by the
    containerized app user -- see backend/Dockerfile's uid 1001 `studio`
    user). It must be logged, not raised."""
    target = tmp_path / "bind-mount"
    target.mkdir(mode=0o700)
    real_uid = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: real_uid + 1)

    with caplog.at_level(logging.WARNING, logger="app.config"):
        ensure_private_dir(target, strict_ownership=False)

    assert "owned by" in caplog.text


def test_explicit_dir_chmod_failure_is_warned_not_raised(monkeypatch, tmp_path, caplog):
    """A bind mount commonly refuses chmod outright, regardless of
    ownership. Once the caller has explicitly chosen this directory,
    tightening its permissions is best-effort: log and move on rather than
    crash the whole backend over a mode change."""
    target = tmp_path / "readonly-ish"
    target.mkdir(mode=0o700)

    def fake_chmod(self, mode):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(Path, "chmod", fake_chmod)

    with caplog.at_level(logging.WARNING, logger="app.config"):
        ensure_private_dir(target, strict_ownership=False)

    assert "permissions" in caplog.text.lower()


def test_load_settings_survives_container_style_foreign_ownership(monkeypatch, tmp_path):
    """The actual regression, reproduced end-to-end: `make up` bind-mounts
    .container-data (created on the host via `mkdir -p`, so owned by the
    host user) into the backend container, which runs as uid 1001 (see
    backend/Dockerfile). st_uid can never match getuid() in that setup, so
    load_settings() must not raise merely because STUDIO_DATA_DIR points at
    a foreign-owned directory."""
    target = tmp_path / "container-data"
    target.mkdir(mode=0o700)
    monkeypatch.setenv("STUDIO_DATA_DIR", str(target))
    real_uid = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: real_uid + 1)

    assert load_settings().data_dir == target.resolve()


def test_load_settings_default_dir_still_rejects_foreign_ownership(monkeypatch, tmp_path):
    """The flip side of the fix: with no STUDIO_DATA_DIR set, load_settings()
    must keep hard-failing on a foreign-owned default directory -- that is
    the symlink-hijack protection default_data_dir() exists for, and it
    must not be weakened by the container carve-out above."""
    monkeypatch.delenv("STUDIO_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    target = tmp_path / "datagrunt-studio"
    target.mkdir(mode=0o700)
    real_uid = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: real_uid + 1)

    with pytest.raises(RuntimeError, match="owned by another user"):
        load_settings()


def test_env_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_DATA_DIR", str(tmp_path / "explicit"))
    assert load_settings().data_dir == (tmp_path / "explicit").resolve()


def test_allowed_buckets_defaults_to_empty(monkeypatch):
    monkeypatch.delenv("STUDIO_GCS_ALLOWED_BUCKETS", raising=False)
    assert load_settings().gcs_allowed_buckets == frozenset()


def test_allowed_buckets_parses_a_comma_separated_list(monkeypatch):
    monkeypatch.setenv("STUDIO_GCS_ALLOWED_BUCKETS", "partner-drop, vendor-inbox")
    assert load_settings().gcs_allowed_buckets == frozenset({"partner-drop", "vendor-inbox"})


def test_allowed_buckets_discards_blank_entries(monkeypatch):
    monkeypatch.setenv("STUDIO_GCS_ALLOWED_BUCKETS", "alpha,,   ,beta")
    assert load_settings().gcs_allowed_buckets == frozenset({"alpha", "beta"})
