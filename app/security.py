"""Password hashing — stdlib only (PBKDF2-HMAC-SHA256), no bcrypt/passlib
dependency. 600,000 iterations matches OWASP's 2023 recommendation for
PBKDF2-SHA256, which is plenty for a self-hosted LAN dashboard.

Hashes are stored as a self-describing string so the algorithm/iteration
count can change later without breaking existing accounts:
  pbkdf2_sha256$<iterations>$<salt-hex>$<hash-hex>
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 600_000
SALT_BYTES = 16


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"{ALGORITHM}${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations_s, salt_hex, digest_hex = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        iterations = int(iterations_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, AttributeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return hmac.compare_digest(actual, expected)


def dummy_verify() -> None:
    """Spend the same time as a real verify_password() call, for a login
    against a username that doesn't exist — so the response timing doesn't
    give away whether a username is valid before the password is checked."""
    hashlib.pbkdf2_hmac("sha256", b"", b"\x00" * SALT_BYTES, ITERATIONS)
