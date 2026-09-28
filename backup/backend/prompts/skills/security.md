---
name: security
description: Authentication, authorisation, input validation and the OWASP failure modes. Use when the task touches auth, tokens, permissions, secrets, or a reported vulnerability.
---

## Security Expert Context

You are implementing authentication, authorization, or reviewing code for security vulnerabilities.

### Authentication

**JWT (stateless, good for APIs)**:
```python
import jwt
from datetime import datetime, timezone, timedelta

SECRET = os.getenv("JWT_SECRET")  # min 32 random bytes, never hardcoded

def create_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
```
- Short expiry (15–60 min) + refresh tokens (7–30 days) stored HttpOnly cookie
- Never put sensitive data in the JWT payload — it's base64-encoded, not encrypted
- Use RS256 (asymmetric) when multiple services need to verify tokens

**Password Hashing**:
```python
import bcrypt

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())
```
- Never store plain-text passwords — always hash with bcrypt, Argon2, or scrypt
- Never use MD5 or SHA-1 for passwords — use proper password hashing algorithms
- `rounds=12` is the minimum; increase as hardware gets faster

### Authorization (RBAC pattern)
```python
from enum import Enum
from functools import wraps

class Role(str, Enum):
    USER  = "user"
    ADMIN = "admin"

def require_role(*roles: Role):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, current_user=Depends(get_current_user), **kwargs):
            if current_user.role not in roles:
                raise HTTPException(403, "Insufficient permissions")
            return await func(*args, current_user=current_user, **kwargs)
        return wrapper
    return decorator

@app.delete("/users/{user_id}")
@require_role(Role.ADMIN)
async def delete_user(user_id: str): ...
```
- Check authorization on every endpoint — don't rely on the frontend to hide things
- "Deny by default": start with no permissions, grant explicitly
- Object-level auth: verify the user owns the resource, not just that they're logged in

### Input Validation & Injection Prevention

**SQL Injection** — always use parameterized queries:
```python
# WRONG — never do this
cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")

# RIGHT — parameterized
cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
# ORM handles this automatically
user = db.query(User).filter(User.email == email).first()
```

**XSS** — escape all user-generated content in HTML:
```ts
// React escapes JSX by default — safe
<div>{userContent}</div>

// DANGEROUS — never use without sanitizing first
<div dangerouslySetInnerHTML={{ __html: userContent }} />

// If you must render HTML, sanitize first
import DOMPurify from 'dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />
```

**Command Injection** — avoid shell execution with user input:
```python
import subprocess

# WRONG
subprocess.run(f"ffmpeg -i {user_filename}", shell=True)

# RIGHT — list form, no shell
subprocess.run(["ffmpeg", "-i", user_filename], shell=False)
```

### Secrets Management
```python
import os
from dotenv import load_dotenv

load_dotenv()

# Always read from environment — never hardcode
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")
```
- `.env` is gitignored — commit `.env.example` with placeholder values
- Production: use a secrets manager (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault)
- Rotate secrets after any potential exposure or team member departure
- Never log secrets — mask them: `DATABASE_URL=postgres://user:***@host/db`

### CORS
```python
# Explicit allowlist — never use allow_origins=["*"] in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com", "https://admin.example.com"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
```

### Rate Limiting
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@app.post("/auth/login")
@limiter.limit("5/minute")  # prevent brute force
async def login(request: Request, credentials: LoginRequest): ...
```

### Security Headers
```python
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware

app.add_middleware(HTTPSRedirectMiddleware)  # redirect HTTP → HTTPS

# Add security headers
@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response
```

### OWASP Top 10 Quick Reference
| Risk | Prevention |
|---|---|
| Injection (SQL, command) | Parameterized queries, no shell=True |
| Broken Authentication | bcrypt passwords, short JWT expiry, rate limit |
| Sensitive Data Exposure | HTTPS only, don't log secrets, encrypt at rest |
| Broken Access Control | Check auth on every endpoint, deny by default |
| Security Misconfiguration | Explicit CORS, security headers, disable debug in prod |
| XSS | React escaping, DOMPurify for raw HTML |
| Using Known Vulnerable Deps | `npm audit`, `pip-audit`, Dependabot |
| Logging & Monitoring | Log auth failures, never log passwords/tokens |
