"""All GCS access for Studio lives here — a thin wrapper over the
google-cloud-storage SDK. Auth is Application Default Credentials only."""

from dataclasses import dataclass
from pathlib import Path

from google.auth.exceptions import DefaultCredentialsError
from google.cloud import resourcemanager_v3, storage

IMPORTABLE_SUFFIXES = {".csv", ".parquet", ".json", ".xlsx", ".xls"}
PDF_SUFFIXES = {".pdf"}

CREDENTIALS_HINT = "No Google Cloud credentials found — run `gcloud auth application-default login`."


class GcsError(Exception):
    """A GCS operation failed in a way the user can act on."""


class GcsCredentialsError(GcsError):
    def __init__(self) -> None:
        super().__init__(CREDENTIALS_HINT)


class GcsDestinationError(GcsError):
    """The requested destination bucket is not an allowed export target."""


@dataclass(frozen=True)
class GcsObject:
    name: str
    size: int
    updated: str | None


def is_importable_object(name: str, suffixes: set[str] = IMPORTABLE_SUFFIXES) -> bool:
    return Path(name).suffix.lower() in suffixes


def resolve_object_name(path: str, basename: str, fmt: str) -> str:
    """Normalize a user-entered destination into a GCS object name.

    Tolerates a pasted gs:// URI (scheme and bucket are dropped), a leading
    slash, a bare folder prefix (filename is appended), and a missing
    extension (the format's extension is appended).
    """
    cleaned = path.strip()
    if cleaned.startswith("gs://"):
        remainder = cleaned[len("gs://") :]
        cleaned = remainder.split("/", 1)[1] if "/" in remainder else ""
    cleaned = cleaned.lstrip("/")
    if not cleaned or cleaned.endswith("/"):
        return f"{cleaned}{basename}.{fmt}"
    if not cleaned.lower().endswith(f".{fmt}"):
        return f"{cleaned}.{fmt}"
    return cleaned


def _client(project: str | None = None) -> storage.Client:
    try:
        return storage.Client(project=project)
    except (DefaultCredentialsError, OSError) as exc:
        raise GcsCredentialsError() from exc


def list_projects() -> list[dict]:
    """Accessible ACTIVE projects, for the project picker.

    Buckets are project-scoped and the ADC default project rarely matches
    where a user's data lives, so the UI picks a project before listing
    buckets.
    """
    try:
        client = resourcemanager_v3.ProjectsClient()
    except (DefaultCredentialsError, OSError) as exc:
        raise GcsCredentialsError() from exc
    request = resourcemanager_v3.SearchProjectsRequest(query="state:ACTIVE")
    return [
        {"id": p.project_id, "name": p.display_name or p.project_id} for p in client.search_projects(request=request)
    ]


def list_buckets(project: str | None = None) -> list[str]:
    return [b.name for b in _client(project).list_buckets()]


def list_objects(bucket: str, prefix: str = "", suffixes: set[str] = IMPORTABLE_SUFFIXES) -> dict:
    """One level of folder-style listing: importable files plus subfolders."""
    blobs = _client().list_blobs(bucket, prefix=prefix, delimiter="/")
    files = [
        GcsObject(
            name=b.name,
            size=b.size or 0,
            updated=b.updated.isoformat() if b.updated else None,
        )
        for b in blobs
        if is_importable_object(b.name, suffixes)
    ]
    # prefixes is populated only after the blob iterator is consumed above.
    return {"folders": sorted(blobs.prefixes), "files": files}


def download_object(bucket: str, name: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _client().bucket(bucket).blob(name).download_to_filename(str(dest))
    return dest


def download_object_bytes(bucket: str, name: str) -> bytes:
    return _client().bucket(bucket).blob(name).download_as_bytes()


def upload_file(local_path: Path, bucket: str, name: str) -> str:
    _client().bucket(bucket).blob(name).upload_from_filename(str(local_path))
    return f"gs://{bucket}/{name}"


def assert_upload_allowed(
    bucket: str,
    project: str,
    *,
    allowed_buckets: frozenset[str] = frozenset(),
    allowed_projects: frozenset[str] = frozenset(),
) -> None:
    """Raise GcsDestinationError unless `bucket` is a permitted export destination.

    Exporting is a credentialed write with a caller-chosen destination, so it is
    the one place a request can carry data *out* using the host's identity.
    The guarantee is narrow, not sweeping: destinations are limited to buckets
    the caller's credentials can list in the *named* project, which is why a
    bucket the attacker merely owns is not reachable by default. It is not
    airtight — an attacker who has already arranged for the operator's identity
    to hold list access on a project they control (Google role grants take
    effect immediately, with no acceptance step from the grantee) can still
    satisfy this check with a bucket they can read. So this raises the bar
    rather than eliminating the class of attack.

    The two allowlists are keyword-only because they mean OPPOSITE things when
    empty, and a positional swap would invert the check with no type error:
    an empty ``allowed_buckets`` permits no extra buckets, while an empty
    ``allowed_projects`` applies no project restriction at all. Configuring
    projects is what stops the legal destination set being derivable from the
    request, since the project itself arrives in it.

    The allowlist is checked first and short-circuits the API call, so a bucket
    granted directly outside the operator's own projects still works.
    """
    if bucket in allowed_buckets:
        return
    if allowed_projects and project not in allowed_projects:
        raise GcsDestinationError(
            f"Project {project!r} is not an allowed export destination. "
            "Name it in STUDIO_GCS_ALLOWED_PROJECTS to permit exports to it."
        )
    if bucket in set(list_buckets(project)):
        return
    raise GcsDestinationError(
        f"Bucket {bucket!r} is not an export destination for project {project!r}. "
        "Choose a bucket in that project, or name it in STUDIO_GCS_ALLOWED_BUCKETS."
    )
