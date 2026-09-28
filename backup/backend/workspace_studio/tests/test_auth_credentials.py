"""Credential policy for register / recover-username / change-password.

These are pure-validation tests — no database — so they run anywhere. The
DB-backed paths (duplicate detection, password round-trip) are exercised against
a real PostgreSQL in the manual check documented in db/README.md.
"""

from __future__ import annotations

import pytest

from auth.service import (
    PASSWORD_MAX_BYTES,
    PASSWORD_MIN_LENGTH,
    CredentialError,
    DuplicateUserError,
    hash_password,
    validate_email,
    validate_password,
    validate_username,
    verify_password,
)


# ── Password policy ─────────────────────────────────────────────────────────

def test_password_shorter_than_the_minimum_is_rejected():
    with pytest.raises(CredentialError):
        validate_password("a" * (PASSWORD_MIN_LENGTH - 1))


def test_password_at_the_minimum_is_accepted():
    validate_password("a" * PASSWORD_MIN_LENGTH)


def test_password_over_72_bytes_is_rejected_rather_than_crashing():
    """bcrypt RAISES above 72 bytes — it does not truncate. Without this check a
    long passphrase is a 500 on signup instead of a validation error."""
    with pytest.raises(CredentialError):
        validate_password("a" * (PASSWORD_MAX_BYTES + 1))


def test_password_length_is_counted_in_bytes_not_characters():
    """A 30-character emoji password is >72 BYTES. Counting characters would let
    it through to bcrypt and raise there."""
    multibyte = "🔒" * 30            # 4 bytes each = 120 bytes
    assert len(multibyte) < PASSWORD_MAX_BYTES
    assert len(multibyte.encode("utf-8")) > PASSWORD_MAX_BYTES
    with pytest.raises(CredentialError):
        validate_password(multibyte)


def test_hash_round_trips_and_rejects_the_wrong_password():
    h = hash_password("correct horse")
    assert verify_password("correct horse", h)
    assert not verify_password("wrong horse", h)


def test_hash_is_salted_so_equal_passwords_differ():
    assert hash_password("same input") != hash_password("same input")


# ── Username policy ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["ada", "ada.lovelace", "ada_love-1", "A1"* 2])
def test_valid_usernames(name):
    validate_username(name)


@pytest.mark.parametrize(
    "name",
    [
        "ab",                 # too short
        "has space",
        "has@at.sign",        # would be ambiguous with an email at the prompt
        "has/slash",
        "",
        "x" * 101,            # over the column's VARCHAR(100)
    ],
)
def test_invalid_usernames(name):
    with pytest.raises(CredentialError):
        validate_username(name)


# ── Email policy ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("email", ["a@b.co", "ada.lovelace+tag@example.com"])
def test_valid_emails(email):
    validate_email(email)


@pytest.mark.parametrize("email", ["nope", "a@b", "a b@c.com", "@example.com", "a@" + "x" * 260])
def test_invalid_emails(email):
    with pytest.raises(CredentialError):
        validate_email(email)


# ── Duplicate signalling ────────────────────────────────────────────────────

def test_duplicate_error_carries_the_clashing_field():
    """The UI marks the offending input from this, rather than guessing."""
    err = DuplicateUserError("email", "An account with that email already exists.")
    assert err.field == "email"
    assert "email" in str(err)
