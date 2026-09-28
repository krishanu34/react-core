"""Attachment ingestion: save uploads, extract text, hand off to indexing."""
from .extractors import ExtractedDoc, PageText, extract
from .storage import AttachmentIn, save_upload

__all__ = ["ExtractedDoc", "PageText", "extract", "AttachmentIn", "save_upload"]
