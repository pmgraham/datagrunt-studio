from pydantic import BaseModel, Field


class ColumnDTO(BaseModel):
    name: str
    type: str


class DatasetDTO(BaseModel):
    id: str
    name: str
    type: str
    table: str
    columns: list[ColumnDTO]
    sheet: str | None = None
    schema_name: str


class SchemaRequest(BaseModel):
    schema_name: str


class CleanParams(BaseModel):
    datasetId: str
    op: str
    column: str | None = None
    value: str | None = None
    newName: str | None = None
    castType: str | None = None


class JoinParams(BaseModel):
    leftId: str
    rightId: str
    leftKey: str
    rightKey: str
    how: str = "inner"


class QueryRequest(BaseModel):
    mode: str
    sql: str | None = None
    clean: CleanParams | None = None
    clean_pipeline: list[CleanParams] | None = None
    join: JoinParams | None = None
    saveAs: str | None = None


class StatementResultDTO(BaseModel):
    columns: list[str] = []
    rows: list[list] = []
    truncated: bool = False
    statement: str = ""
    has_result_set: bool = True
    error: str | None = None
    detail: str | None = None


class QueryResponse(BaseModel):
    columns: list[str] = []
    rows: list[list] = []
    truncated: bool = False
    sql: str = ""
    code: str = ""
    error: str | None = None
    detail: str | None = None
    results: list[StatementResultDTO] = []


class ExportRequest(BaseModel):
    datasetId: str | None = None
    sql: str | None = None
    format: str


class PageRequest(BaseModel):
    datasetId: str | None = None
    sql: str | None = None
    offset: int
    limit: int
    search: str | None = None
    sortColumn: str | None = None
    sortDirection: str = "asc"


class PageResponse(BaseModel):
    columns: list[str]
    rows: list[list]
    total: int


class CastRequest(BaseModel):
    column: str
    type: str
    lenient: bool = False


class CastResponse(BaseModel):
    ok: bool
    failingCount: int
    example: str | None = None
    nulledCount: int = 0
    columns: list[ColumnDTO] = []


class SheetReadOptions(BaseModel):
    skip_rows: int = Field(default=0, ge=0)
    has_header: bool = True


class StagedPreviewRequest(SheetReadOptions):
    sheet: str | None = None


class StagedSheetPreview(BaseModel):
    columns: list[str]
    columns_normalized: list[str]
    rows: list[list[str]]


class StagedFilePreview(BaseModel):
    staged_id: str
    filename: str
    sheets: list[str] | None = None
    columns: list[str] | None = None
    columns_normalized: list[str] | None = None
    rows: list[list[str]] | None = None
    error: str | None = None


class PreviewResponse(BaseModel):
    is_single: bool
    files: list[StagedFilePreview]


class ConfirmImportItem(BaseModel):
    staged_id: str
    filename: str
    normalize_columns: bool = False
    sheet: str | None = None
    schema_name: str = "imported"
    overwrite: bool = False
    skip_rows: int = Field(default=0, ge=0)
    has_header: bool = True
    sheet_options: dict[str, SheetReadOptions] | None = None


class ConfirmImportRequest(BaseModel):
    files: list[ConfirmImportItem]


class GcsImportRequest(BaseModel):
    bucket: str
    objects: list[str]
    schema_name: str = "imported"


class ImportErrorDTO(BaseModel):
    filename: str
    message: str


class GcsImportResponse(BaseModel):
    previews: list[StagedFilePreview] = []
    datasets: list[DatasetDTO] = []
    errors: list[ImportErrorDTO] = []


class GcsExportRequest(BaseModel):
    datasetId: str | None = None
    sql: str | None = None
    format: str
    bucket: str
    path: str = ""
