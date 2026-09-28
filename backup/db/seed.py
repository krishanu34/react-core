"""Seed an initial admin user into the DevSphere AI database.

    python db/seed.py                       # uses SEED_ADMIN_* / defaults
    SEED_ADMIN_PASSWORD=... python db/seed.py

Reads DB connection + SECRET from backend/.env (same settings the backend uses).
Idempotent: updates the password if the admin already exists.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import bcrypt  # noqa: E402
from sqlalchemy import text  # noqa: E402

from workspace_studio.repositories.database import get_session  # noqa: E402


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def main() -> None:
    username = os.getenv("SEED_ADMIN_USERNAME", "admin")
    email = os.getenv("SEED_ADMIN_EMAIL", "admin@devsphere.local")
    password = os.getenv("SEED_ADMIN_PASSWORD", "admin")
    full_name = os.getenv("SEED_ADMIN_NAME", "DevSphere Admin")

    pw_hash = _hash(password)
    with get_session() as session:
        session.execute(
            text(
                """
                INSERT INTO users (username, email, full_name, password_hash, role, is_active)
                VALUES (:username, :email, :full_name, :password_hash, 'admin', TRUE)
                ON CONFLICT (username) DO UPDATE
                    SET password_hash = EXCLUDED.password_hash,
                        email = EXCLUDED.email,
                        full_name = EXCLUDED.full_name,
                        role = 'admin',
                        is_active = TRUE,
                        updated_at = NOW()
                """
            ),
            {"username": username, "email": email, "full_name": full_name, "password_hash": pw_hash},
        )

    print(f"Seeded admin user '{username}'.")
    if password == "changeme":
        print("WARNING: default password 'changeme' — set SEED_ADMIN_PASSWORD and re-run.")


if __name__ == "__main__":
    main()
