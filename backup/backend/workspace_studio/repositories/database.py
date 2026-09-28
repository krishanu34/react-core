"""Lazy SQLAlchemy session management for Workspace Studio."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Generator, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import QueuePool

from common_utils.logging_config import get_logger
from workspace_studio.config.settings import get_settings


logger = get_logger(__name__)
_engine = None
_session_factory: Optional[sessionmaker] = None


def get_engine():
    """Create the SQLAlchemy engine lazily to keep imports DB-safe."""
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        logger.info("workspace_studio_db_engine_initialising", host=settings.db_host, database=settings.db_name)
        _engine = create_engine(
            settings.database_url,
            poolclass=QueuePool,
            pool_size=5,
            max_overflow=10,
            # Test the connection with a cheap round trip at CHECKOUT. A managed
            # Postgres behind a gateway (Azure/RDS) silently drops connections it
            # considers idle; without this the first statement after such a drop
            # fails with "server closed the connection unexpectedly".
            pool_pre_ping=True,
            # Retire a connection after 30 min regardless of health, so no
            # connection outlives the gateway's own idle/lifetime limit. Belt to
            # pre_ping's braces: pre_ping detects a dead socket, this avoids
            # holding one long enough to die in the first place.
            pool_recycle=1800,
            echo=False,
            connect_args=settings.connect_args,
        )
        _session_factory = sessionmaker(bind=_engine, autocommit=False, autoflush=False)
    return _engine


@contextmanager
def get_session() -> Generator[Session, None, None]:
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    session = _session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def check_database_connection() -> bool:
    try:
        with get_session() as session:
            session.execute(text("SELECT 1"))
        return True
    except Exception as exc:  # pragma: no cover - exercised only with a live DB
        logger.warning("workspace_studio_db_health_failed", error=str(exc))
        return False
