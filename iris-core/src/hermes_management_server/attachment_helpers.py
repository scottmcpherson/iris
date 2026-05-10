from pathlib import Path


def safe_attachment_name(value: str) -> str:
    name = Path(value or "attachment").name.strip()
    return name or "attachment"
