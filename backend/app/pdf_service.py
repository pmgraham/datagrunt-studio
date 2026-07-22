"""Service for single-document PDF extraction and AI schema rationalization.

Supports local extraction via datagrunt, and rationalization using either a local
Ollama instance or Vertex AI/Gemini.
"""

import base64
import json
import mimetypes
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

import requests

PREVIEW_DIR = Path(tempfile.gettempdir()) / "aipx_preview"
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_MAX_AGE = 3600  # sweep temp files older than an hour
_MAX_IMAGES = 16  # cap multimodal payload

_SYSTEM = (
    "You are a senior data engineer. You receive the raw JSON that a document "
    "extraction pipeline produced for a single document. Rewrite it into a clean, "
    "usable schema that satisfies the user's requirements. Infer types and units "
    "from the content, use snake_case keys, drop layout/formatting noise (pages, "
    "elements, bounding boxes), and stay faithful to the source — do not invent "
    "values. Respond with ONLY valid JSON, no markdown fences or commentary."
)


def valid_id(doc_id: str) -> bool:
    """Guard against path traversal — ids are uuid4 hex."""
    return bool(doc_id and _ID_RE.match(doc_id))


def pdf_path(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}.pdf"


def json_path(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}.json"


def md_path(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}.md"


def schema_path(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}.schema.json"


def images_dir(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}_images"


def original_name_path(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}.name"


def original_name(doc_id: str) -> str:
    p = original_name_path(doc_id)
    return p.read_text().strip() if p.exists() else f"{doc_id}.pdf"


def stem(doc_id: str) -> str:
    return Path(original_name(doc_id)).stem or "document"


def images(doc_id: str) -> list[str]:
    """Relative paths of extracted image files for this doc, sorted."""
    d = images_dir(doc_id)
    if not d.exists():
        return []
    return sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())


def image_file(doc_id: str, rel: str) -> Path | None:
    """Resolve an extracted image by relative path, guarding against traversal."""
    d = images_dir(doc_id).resolve()
    p = (d / rel).resolve()
    if d == p or d in p.parents:
        return p if p.is_file() else None
    return None


def page_images_dir(doc_id: str) -> Path:
    return PREVIEW_DIR / f"{doc_id}_page_images"


def page_images(doc_id: str) -> list[str]:
    """Relative paths of full page image files for this doc, sorted."""
    d = page_images_dir(doc_id)
    if not d.exists():
        return []
    return sorted(p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())


def page_image_file(doc_id: str, rel: str) -> Path | None:
    """Resolve a full page image by relative path, guarding against traversal."""
    d = page_images_dir(doc_id).resolve()
    p = (d / rel).resolve()
    if d == p or d in p.parents:
        return p if p.is_file() else None
    return None


def _sweep():
    if not PREVIEW_DIR.exists():
        return
    now = time.time()
    for p in PREVIEW_DIR.iterdir():
        try:
            if now - p.stat().st_mtime > _MAX_AGE:
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink()
        except OSError:
            pass


def save_upload(filename: str, contents: bytes) -> str:
    """Persist an uploaded PDF to a temp file; returns its id."""
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    _sweep()
    doc_id = uuid.uuid4().hex
    pdf_path(doc_id).write_bytes(contents)
    original_name_path(doc_id).write_text(filename)
    return doc_id


def _image_elements(data):
    """Yield every image element dict in a datagrunt document."""
    for page in (data.get("document", {}) or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            if str(el.get("type", "")).lower() == "image" and isinstance(el.get("metadata"), dict):
                yield el


def _rewrite_image_locations(data, locate):
    """Apply locate(basename) -> new file_path to each image element's metadata."""
    for el in _image_elements(data):
        fp = el["metadata"].get("file_path")
        if fp:
            el["metadata"]["file_path"] = locate(Path(fp).name)


def extract_pdf(doc_id: str) -> str:
    """Run datagrunt on the stored PDF — structured JSON + extracted images.

    Writes json with image_output_dir, then stamps the original filename as
    `document.source` and normalizes each image's file_path to the bare filename."""
    from datagrunt import PDFWriter

    d = images_dir(doc_id)
    d.mkdir(parents=True, exist_ok=True)

    # Extract JSON
    PDFWriter(str(pdf_path(doc_id)), engine="pdfium", workers=1).write_json(
        export_filename=str(json_path(doc_id)), image_output_dir=str(d)
    )

    # Extract Markdown
    try:
        PDFWriter(str(pdf_path(doc_id)), engine="pdfium", workers=1).write_markdown(
            export_filename=str(md_path(doc_id)), image_output_dir=str(d)
        )
    except Exception as e:
        md_path(doc_id).write_text(f"# Markdown Export\nFailed to extract markdown: {str(e)}")

    # Render pages as images
    page_dir = page_images_dir(doc_id)
    page_dir.mkdir(parents=True, exist_ok=True)
    try:
        PDFWriter(str(pdf_path(doc_id)), engine="pdfium", workers=1).render_pages_as_images(
            output_dir=str(page_dir), dpi=150, image_format="png"
        )
    except Exception as e:
        print(f"Error rendering pages as images for {doc_id}: {e}")

    data = json.loads(json_path(doc_id).read_text())
    if isinstance(data.get("document"), dict):
        data["document"]["source"] = original_name(doc_id)

    _rewrite_image_locations(data, lambda name: name)
    text = json.dumps(data, indent=2, ensure_ascii=False)
    json_path(doc_id).write_text(text)
    return text


def rationalize(doc_id: str, user_prompt: str, use_local: bool, model: str, use_page_images: bool = False) -> str:
    """Rewrite the raw JSON layout into a schema using Gemini or local Ollama."""
    system_instruction = _SYSTEM
    if use_page_images:
        img_paths = [page_image_file(doc_id, r) for r in page_images(doc_id)]
        img_paths = [str(p) for p in img_paths if p][:_MAX_IMAGES]

        note = f"\n\n{len(img_paths)} document page image(s) are attached." if img_paths else ""
        text_prompt = (
            f"USER REQUIREMENTS:\n{user_prompt}\n\n"
            f"The document pages are attached as images. Analyze them to fulfill the user requirements.{note}"
        )
        system_instruction = (
            "You are a senior data engineer. You receive a document as a set of page images. "
            "Analyze the images and extract the content into a clean, usable schema that satisfies "
            "the user's requirements. "
            "Infer types and units from the content, use snake_case keys, drop layout/formatting noise (pages, "
            "elements, bounding boxes), and stay faithful to the source — do not invent values. "
            "Respond with ONLY valid JSON, no markdown fences or commentary."
        )
    else:
        if not json_path(doc_id).exists():
            raise FileNotFoundError("Extraction JSON not found. Please extract first.")

        extracted_json = json_path(doc_id).read_text()
        img_paths = [image_file(doc_id, r) for r in images(doc_id)]
        img_paths = [str(p) for p in img_paths if p][:_MAX_IMAGES]

        note = f"\n\n{len(img_paths)} extracted image(s) are attached." if img_paths else ""
        text_prompt = f"USER REQUIREMENTS:\n{user_prompt}\n\nEXTRACTED JSON:\n{extracted_json}{note}"

    schema_output = ""

    if use_local:
        schema_output = _call_ollama(model or "llama3", system_instruction, text_prompt, img_paths)
    else:
        schema_output = _call_gemini(model or "gemini-2.5-flash", system_instruction, text_prompt, img_paths)

    # Clean up markdown code block wrapping if the LLM outputted them despite instructions
    clean_schema = schema_output.strip()
    if clean_schema.startswith("```"):
        # Remove starting fence
        clean_schema = re.sub(r"^```(?:json)?\n", "", clean_schema)
        # Remove ending fence
        clean_schema = re.sub(r"\n```$", "", clean_schema)
        clean_schema = clean_schema.strip()

    # Verify it is valid JSON and pretty-print it
    try:
        parsed = json.loads(clean_schema)
        clean_schema = json.dumps(parsed, indent=2)
    except json.JSONDecodeError:
        # If it's invalid, we still write it but the UI might report a formatting error
        pass

    schema_path(doc_id).write_text(clean_schema)
    return clean_schema


def _call_ollama(model: str, system_instruction: str, prompt: str, image_paths: list[str]) -> str:
    images_base64 = []
    if image_paths:
        for p in image_paths:
            if p and os.path.exists(p):
                with open(p, "rb") as f:
                    images_base64.append(base64.b64encode(f.read()).decode("utf-8"))

    ollama_host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    url = f"{ollama_host.rstrip('/')}/api/generate"

    payload = {
        "model": model,
        "prompt": prompt,
        "system": system_instruction,
        "format": "json",
        "stream": False,
    }
    if images_base64:
        payload["images"] = images_base64

    try:
        response = requests.post(url, json=payload, timeout=90.0)
        response.raise_for_status()
        data = response.json()
        return data.get("response", "")
    except Exception as e:
        raise RuntimeError(
            f"Ollama call failed (make sure Ollama is running at {ollama_host} "
            f"and the model '{model}' is pulled): {str(e)}"
        )


def _detect_gcp_project() -> str:
    """Detect active gcloud project from environment or gcloud config."""
    project = os.environ.get("GCP_PROJECT") or os.environ.get("STUDIO_GCP_PROJECT")
    if project:
        return project
    try:
        import subprocess

        res = subprocess.run(["gcloud", "config", "get-value", "project"], capture_output=True, text=True, check=True)
        detected = res.stdout.strip()
        if detected:
            return detected
    except Exception:
        pass
    return "my-project"


def _call_gemini(model: str, system_instruction: str, prompt: str, image_paths: list[str]) -> str:
    from google import genai
    from google.genai import types

    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key and api_key != "MY_GEMINI_API_KEY" and api_key.strip():
        client = genai.Client(api_key=api_key)
    else:
        project = _detect_gcp_project()
        if "3.5" in model.lower():
            location = "global"
        else:
            location = os.environ.get("GCP_LOCATION", "us-central1")
        client = genai.Client(vertexai=True, project=project, location=location)

    contents = [prompt]
    if image_paths:
        for p in image_paths:
            if p and os.path.exists(p):
                mime = mimetypes.guess_type(str(p))[0] or "image/png"
                contents.append(types.Part.from_bytes(data=Path(p).read_bytes(), mime_type=mime))

    try:
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
        return resp.text
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {str(e)}")


def get_ollama_models() -> dict:
    """Fetch installed local models from the Ollama service."""
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    url = f"{host.rstrip('/')}/api/tags"
    try:
        res = requests.get(url, timeout=2.0)
        if res.status_code == 200:
            data = res.json()
            models = [m["name"] for m in data.get("models", [])]
            return {"models": models, "active": True}
    except Exception:
        pass

    return {"models": [], "active": False}


def get_gemini_models() -> dict:
    """Fetch available Gemini models if an API key or gcloud config is set, otherwise return the fallback list."""
    api_key = os.environ.get("GEMINI_API_KEY")

    # Try using Vertex AI or API Key to fetch list of models dynamically
    try:
        from google import genai

        if api_key and api_key != "MY_GEMINI_API_KEY" and api_key.strip():
            client = genai.Client(api_key=api_key)
        else:
            project = _detect_gcp_project()
            if project == "my-project":
                raise ValueError("No active GCP project detected")
            location = os.environ.get("GCP_LOCATION", "us-central1")
            client = genai.Client(vertexai=True, project=project, location=location)

        models = [m.name for m in client.models.list() if "gemini" in m.name.lower()]
        cleaned = []
        for m in models:
            name = m.split("/")[-1]
            cleaned.append(name)
        if cleaned:
            # We are active if we successfully fetched list of models dynamically
            return {"models": sorted(list(set(cleaned))), "active": True}
    except Exception:
        pass

    # Fallback to the latest production stable models as of mid-2026
    return {"models": ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-3.1-flash-lite"], "active": bool(api_key)}
