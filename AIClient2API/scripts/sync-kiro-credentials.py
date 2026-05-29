#!/usr/bin/env python3
"""
Kiro OAuth Credential Sync
--------------------------
Watches the Kiro CLI SQLite database for token changes and syncs credentials
to both target paths:
  - /Users/ilialiston/MASTER-C/Credentials/claude-kiro-oauth/account_N.json
  - /Users/ilialiston/MASTER-C/Tier1-AIClient2API/configs/kiro/account-N/kiro-auth-token.json

Each unique profileArn gets its own account_N slot. New accounts are auto-discovered
and assigned the next available slot number.

Usage:
  python3 sync-kiro-credentials.py          # run as watcher (foreground)
  python3 sync-kiro-credentials.py --once   # sync once and exit
"""

import json
import os
import sqlite3
import sys
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────
KIRO_DB       = Path.home() / "Library/Application Support/kiro-cli/data.sqlite3"
KIRO_BAK      = Path.home() / ".kiro/oauth_creds.json.bak"

CREDS_DIR     = Path("/Users/ilialiston/MASTER-C/Credentials/claude-kiro-oauth")
CONFIGS_DIR   = Path("/Users/ilialiston/MASTER-C/Tier1-AIClient2API/configs/kiro")

# Registry file — maps profileArn → account number so slots stay stable
REGISTRY_FILE = CREDS_DIR / ".account_registry.json"

POLL_INTERVAL = 10  # seconds between DB checks

# ── Registry helpers ───────────────────────────────────────────────────────────

def load_registry() -> dict:
    """Load the profileArn → account_number mapping."""
    if REGISTRY_FILE.exists():
        try:
            return json.loads(REGISTRY_FILE.read_text())
        except Exception:
            pass
    return {}


def save_registry(registry: dict):
    REGISTRY_FILE.write_text(json.dumps(registry, indent=2))


def get_or_assign_slot(registry: dict, profile_arn: str) -> int:
    """Return existing slot for this ARN, or assign the next available one."""
    if profile_arn in registry:
        return registry[profile_arn]
    # Find next free slot (1-based, no gaps)
    used = set(registry.values())
    slot = 1
    while slot in used:
        slot += 1
    registry[profile_arn] = slot
    save_registry(registry)
    print(f"[sync] New account detected → assigned slot {slot} for {profile_arn}")
    return slot

# ── Token reading ──────────────────────────────────────────────────────────────

def read_all_tokens() -> list:
    """
    Read all auth tokens from the Kiro CLI SQLite database.
    Returns a list of token dicts (one per account row).
    """
    if not KIRO_DB.exists():
        return []
    try:
        con = sqlite3.connect(f"file:{KIRO_DB}?mode=ro", uri=True)
        cur = con.execute("SELECT key, value FROM auth_kv WHERE key LIKE '%token%'")
        rows = cur.fetchall()
        con.close()
    except Exception as e:
        print(f"[sync] DB read error: {e}")
        return []

    tokens = []
    for key, value in rows:
        try:
            tokens.append(json.loads(value))
        except Exception:
            pass
    return tokens


def token_fingerprint(token: dict) -> str:
    """Stable hash of a token for change detection."""
    return hashlib.md5(
        json.dumps(token, sort_keys=True).encode()
    ).hexdigest()

# ── Writing ────────────────────────────────────────────────────────────────────

def build_creds_payload(src: dict) -> dict:
    """Map SQLite token format → claude-kiro-oauth account_N.json format."""
    provider = src.get("provider") or src.get("socialProvider") or "Google"
    return {
        "accessToken":    src.get("access_token", src.get("accessToken", "")),
        "refreshToken":   src.get("refresh_token", src.get("refreshToken", "")),
        "profileArn":     src.get("profile_arn",  src.get("profileArn", "")),
        "socialProvider": provider.capitalize(),
        "expiresAt":      src.get("expires_at",    src.get("expiresAt", "")),
        "authMethod":     "social",
        "region":         "us-east-1",
    }


def build_config_payload(src: dict) -> dict:
    """Map SQLite token format → configs/kiro account-N/kiro-auth-token.json format."""
    provider = src.get("provider") or src.get("socialProvider") or "Google"
    return {
        "accessToken":  src.get("access_token", src.get("accessToken", "")),
        "refreshToken": src.get("refresh_token", src.get("refreshToken", "")),
        "profileArn":   src.get("profile_arn",  src.get("profileArn", "")),
        "expiresAt":    src.get("expires_at",    src.get("expiresAt", "")),
        "authMethod":   "social",
        "provider":     provider.capitalize(),
    }


def write_account(slot: int, token: dict):
    """Write token to both target locations for the given slot number."""
    # 1. Credentials folder  →  account_N.json
    creds_file = CREDS_DIR / f"account_{slot}.json"
    creds_file.write_text(json.dumps(build_creds_payload(token), indent=2))

    # 2. Configs folder  →  account-N/kiro-auth-token.json
    config_dir = CONFIGS_DIR / f"account-{slot}"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "kiro-auth-token.json"
    config_file.write_text(json.dumps(build_config_payload(token), indent=2))

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[sync] {ts}  slot {slot}  →  {creds_file}  +  {config_file}")


def update_bak_file(token: dict):
    """Keep ~/.kiro/oauth_creds.json.bak in sync (SQLite native format)."""
    try:
        KIRO_BAK.write_text(json.dumps(token, indent=2))
    except Exception as e:
        print(f"[sync] Could not update .bak: {e}")

# ── Main sync loop ─────────────────────────────────────────────────────────────

def sync_once(registry: dict, last_fingerprints: dict) -> dict:
    """
    Read all tokens, assign slots, write files for any that changed.
    Returns updated fingerprints dict.
    """
    tokens = read_all_tokens()
    if not tokens:
        return last_fingerprints

    for token in tokens:
        arn = token.get("profile_arn") or token.get("profileArn")
        if not arn:
            continue

        fp = token_fingerprint(token)
        if last_fingerprints.get(arn) == fp:
            continue  # unchanged

        slot = get_or_assign_slot(registry, arn)
        write_account(slot, token)
        update_bak_file(token)
        last_fingerprints[arn] = fp

    return last_fingerprints


def main():
    once_mode = "--once" in sys.argv

    # Ensure target dirs exist
    CREDS_DIR.mkdir(parents=True, exist_ok=True)
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)

    registry = load_registry()
    fingerprints = {}

    print(f"[sync] Kiro credential sync started  (poll every {POLL_INTERVAL}s)")
    print(f"[sync] DB:       {KIRO_DB}")
    print(f"[sync] Creds:    {CREDS_DIR}")
    print(f"[sync] Configs:  {CONFIGS_DIR}")
    print(f"[sync] Registry: {REGISTRY_FILE}")
    print()

    # Initial sync
    fingerprints = sync_once(registry, fingerprints)

    if once_mode:
        print("[sync] --once mode: done.")
        return

    # Watch loop
    try:
        while True:
            time.sleep(POLL_INTERVAL)
            fingerprints = sync_once(registry, fingerprints)
    except KeyboardInterrupt:
        print("\n[sync] Stopped.")


if __name__ == "__main__":
    main()
