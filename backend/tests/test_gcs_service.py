import pytest

from app import gcs_service
from app.gcs_service import (
    PDF_SUFFIXES,
    download_object_bytes,
    is_importable_object,
    resolve_object_name,
)


def test_is_importable_object_accepts_supported_suffixes():
    assert is_importable_object("data/sales.csv")
    assert is_importable_object("sales.PARQUET")
    assert is_importable_object("nested/deep/doc.json")


def test_is_importable_object_rejects_everything_else():
    assert not is_importable_object("README.md")
    assert not is_importable_object("noextension")
    assert not is_importable_object("archive/")


def test_resolve_object_name_appends_filename_to_folder_paths():
    assert resolve_object_name("exports/", "sales", "csv") == "exports/sales.csv"
    assert resolve_object_name("", "sales", "parquet") == "sales.parquet"
    assert resolve_object_name("   ", "sales", "json") == "sales.json"


def test_resolve_object_name_appends_missing_extension():
    assert resolve_object_name("exports/q4", "sales", "csv") == "exports/q4.csv"


def test_resolve_object_name_keeps_matching_extension():
    assert resolve_object_name("exports/q4.csv", "sales", "csv") == "exports/q4.csv"
    assert resolve_object_name("exports/Q4.CSV", "sales", "csv") == "exports/Q4.CSV"


def test_resolve_object_name_tolerates_pasted_gs_uri_and_leading_slash():
    assert resolve_object_name("gs://my-bucket/exports/q4.csv", "sales", "csv") == "exports/q4.csv"
    assert resolve_object_name("gs://my-bucket", "sales", "csv") == "sales.csv"
    assert resolve_object_name("/exports/q4.csv", "sales", "csv") == "exports/q4.csv"


def test_is_importable_object_with_pdf_suffixes():
    assert is_importable_object("docs/Invoice 2024.PDF", PDF_SUFFIXES)
    assert not is_importable_object("data/sales.csv", PDF_SUFFIXES)
    assert not is_importable_object("noextension", PDF_SUFFIXES)


def test_list_objects_filters_by_suffix_set(monkeypatch):
    class FakeBlob:
        def __init__(self, name):
            self.name = name
            self.size = 10
            self.updated = None

    class FakeBlobIterator(list):
        prefixes = {"docs/archive/"}

    class FakeClient:
        def list_blobs(self, bucket, prefix="", delimiter="/"):
            return FakeBlobIterator([FakeBlob("docs/a.pdf"), FakeBlob("docs/b.csv"), FakeBlob("docs/c.txt")])

    monkeypatch.setattr(gcs_service, "_client", lambda project=None: FakeClient())

    pdf_listing = gcs_service.list_objects("alpha", "docs/", PDF_SUFFIXES)
    assert [f.name for f in pdf_listing["files"]] == ["docs/a.pdf"]
    assert pdf_listing["folders"] == ["docs/archive/"]

    default_listing = gcs_service.list_objects("alpha", "docs/")
    assert [f.name for f in default_listing["files"]] == ["docs/b.csv"]


def test_download_object_bytes(monkeypatch):
    class FakeBlob:
        def download_as_bytes(self):
            return b"%PDF-1.4 fake"

    class FakeBucket:
        def blob(self, name):
            assert name == "docs/invoice.pdf"
            return FakeBlob()

    class FakeClient:
        def bucket(self, name):
            assert name == "alpha"
            return FakeBucket()

    monkeypatch.setattr(gcs_service, "_client", lambda project=None: FakeClient())
    assert download_object_bytes("alpha", "docs/invoice.pdf") == b"%PDF-1.4 fake"


def test_client_permission_error_surfaces_credentials_hint(monkeypatch):
    def raise_permission_error(project=None):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(gcs_service.storage, "Client", raise_permission_error)
    with pytest.raises(gcs_service.GcsCredentialsError):
        gcs_service._client()


def test_list_projects_permission_error_surfaces_credentials_hint(monkeypatch):
    def raise_permission_error():
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(gcs_service.resourcemanager_v3, "ProjectsClient", raise_permission_error)
    with pytest.raises(gcs_service.GcsCredentialsError):
        gcs_service.list_projects()


def test_list_objects_includes_excel_suffixes(monkeypatch):
    class FakeBlob:
        def __init__(self, name):
            self.name = name
            self.size = 10
            self.updated = None

    class FakeBlobIterator(list):
        prefixes = set()

    class FakeClient:
        def list_blobs(self, bucket, prefix="", delimiter="/"):
            return FakeBlobIterator([FakeBlob("docs/a.xlsx"), FakeBlob("docs/b.xls"), FakeBlob("docs/c.txt")])

    monkeypatch.setattr(gcs_service, "_client", lambda project=None: FakeClient())
    listing = gcs_service.list_objects("alpha", "docs/")
    assert [f.name for f in listing["files"]] == ["docs/a.xlsx", "docs/b.xls"]


def test_assert_upload_allowed_accepts_a_bucket_in_the_project(monkeypatch):
    monkeypatch.setattr(gcs_service, "list_buckets", lambda project=None: ["alpha", "beta"])
    gcs_service.assert_upload_allowed("alpha", "proj")


def test_assert_upload_allowed_rejects_a_bucket_outside_the_project(monkeypatch):
    monkeypatch.setattr(gcs_service, "list_buckets", lambda project=None: ["alpha"])
    with pytest.raises(gcs_service.GcsDestinationError) as excinfo:
        gcs_service.assert_upload_allowed("attacker-bucket", "proj")
    message = str(excinfo.value)
    assert "attacker-bucket" in message
    assert "STUDIO_GCS_ALLOWED_BUCKETS" in message


def test_assert_upload_allowed_forwards_the_project_to_list_buckets(monkeypatch):
    seen = {}

    def fake_list(project=None):
        seen["project"] = project
        return ["alpha"]

    monkeypatch.setattr(gcs_service, "list_buckets", fake_list)
    gcs_service.assert_upload_allowed("alpha", "my-proj")
    assert seen["project"] == "my-proj"


def test_assert_upload_allowed_honours_the_allowlist_without_listing(monkeypatch):
    def boom(project=None):
        raise AssertionError("list_buckets must not be called for an allowlisted bucket")

    monkeypatch.setattr(gcs_service, "list_buckets", boom)
    gcs_service.assert_upload_allowed("partner-drop", "proj", allowed_buckets=frozenset({"partner-drop"}))


def test_assert_upload_allowed_accepts_a_project_in_the_allowlist(monkeypatch):
    monkeypatch.setattr(gcs_service, "list_buckets", lambda project=None: ["alpha"])
    gcs_service.assert_upload_allowed("alpha", "proj", allowed_projects=frozenset({"proj"}))


def test_assert_upload_allowed_rejects_a_project_outside_the_allowlist(monkeypatch):
    def boom(project=None):
        raise AssertionError("list_buckets must not be called for a refused project")

    monkeypatch.setattr(gcs_service, "list_buckets", boom)
    with pytest.raises(gcs_service.GcsDestinationError) as excinfo:
        gcs_service.assert_upload_allowed("alpha", "attacker-proj", allowed_projects=frozenset({"proj"}))
    message = str(excinfo.value)
    assert "attacker-proj" in message
    assert "STUDIO_GCS_ALLOWED_PROJECTS" in message


def test_assert_upload_allowed_ignores_an_empty_project_allowlist(monkeypatch):
    # Empty means "no project restriction" -- the opposite of what an empty
    # bucket allowlist means. This pins that asymmetry.
    monkeypatch.setattr(gcs_service, "list_buckets", lambda project=None: ["alpha"])
    gcs_service.assert_upload_allowed("alpha", "any-project-at-all")


def test_allowlisted_bucket_bypasses_a_project_restriction(monkeypatch):
    # STUDIO_GCS_ALLOWED_BUCKETS exists for a bucket granted outside the
    # operator's own projects, so a project restriction must not veto it.
    def boom(project=None):
        raise AssertionError("list_buckets must not be called for an allowlisted bucket")

    monkeypatch.setattr(gcs_service, "list_buckets", boom)
    gcs_service.assert_upload_allowed(
        "partner-drop",
        "some-other-project",
        allowed_buckets=frozenset({"partner-drop"}),
        allowed_projects=frozenset({"proj"}),
    )
