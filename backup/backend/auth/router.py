"""/auth routes — register, login, logout, current user, username recovery,
password change."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from auth.service import (
    PASSWORD_MIN_LENGTH,
    CredentialError,
    DuplicateUserError,
    authenticate,
    change_password,
    create_access_token,
    get_profile,
    get_user_by_email,
    public_user,
    register_user,
)
from workspace_studio.security.auth import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    email: str = Field(..., min_length=3, max_length=255)
    password: str = Field(..., min_length=1)
    full_name: str | None = Field(default=None, max_length=255)


class RecoverUsernameRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict[str, Any]


@router.post("/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest) -> LoginResponse:
    """Create an account and sign in immediately.

    On a clash returns 409 with ``{"detail": ..., "field": "username" | "email"}``
    so the UI can mark the offending input instead of showing a generic banner.
    """
    try:
        user = register_user(
            username=body.username,
            email=body.email,
            password=body.password,
            full_name=body.full_name,
        )
    except DuplicateUserError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"detail": str(exc), "field": exc.field},
        ) from exc
    except CredentialError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    # Sign the new account straight in — no second round-trip through /login.
    token = create_access_token(user)
    return LoginResponse(access_token=token, user=public_user(user))


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest) -> LoginResponse:
    user = authenticate(body.username.strip(), body.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = create_access_token(user)
    return LoginResponse(access_token=token, user=public_user(user))


@router.post("/recover-username")
async def recover_username(body: RecoverUsernameRequest) -> dict[str, Any]:
    """Look up the username registered to an email address.

    TRADE-OFF, stated plainly: returning the username confirms whether an address
    is registered — this endpoint permits account enumeration. It is the only
    self-service option while there is no outbound mail; the safe pattern ("if
    that address is registered we've emailed it", same response either way) needs
    a mail provider to be of any use.

    Mitigations: inactive accounts are reported as not found, and no other
    profile field is exposed. Once SMTP exists, switch this to mail the username
    and return a constant response regardless of whether the account was found.
    """
    user = get_user_by_email(body.email.strip())
    if not user or not user.get("is_active"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active account is registered with that email address.",
        )
    return {"username": user["username"]}


@router.post("/change-password")
async def change_own_password(
    body: ChangePasswordRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Change the signed-in user's password (requires the current one)."""
    if body.new_password == body.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The new password must be different from the current one.",
        )
    try:
        ok = change_password(
            int(current_user["user_id"]), body.current_password, body.new_password
        )
    except CredentialError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect.",
        )
    # The JWT carries no password material, so tokens already issued stay valid
    # until they expire. Revoking them would need a blocklist or a per-user
    # token-version claim — out of scope here.
    return {"detail": "Password updated."}


@router.get("/password-policy")
async def password_policy() -> dict[str, int]:
    """Lets the UI state exactly the rule the server enforces."""
    return {"min_length": PASSWORD_MIN_LENGTH}


@router.post("/logout")
async def logout() -> dict[str, str]:
    # Stateless JWT: the client discards the token. Endpoint exists so clients
    # have a single logout call and for future token-revocation support.
    return {"detail": "logged out"}


@router.get("/me")
async def me(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return current_user


@router.get("/profile")
async def profile(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """The signed-in user's account page: identity, teams and activity totals.

    Always scoped to the caller's own id from the JWT — there is deliberately no
    `user_id` parameter, so this route cannot be turned into a way to read
    someone else's account. Admins wanting another user's figures use the
    admin endpoints, which check the role.
    """
    data = get_profile(int(current_user["user_id"]))
    if data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Your account no longer exists.",
        )
    # Capability roles live in the token, not the users table — report what this
    # session actually carries rather than re-deriving it.
    data["roles"] = list(current_user.get("roles") or [])
    return data
