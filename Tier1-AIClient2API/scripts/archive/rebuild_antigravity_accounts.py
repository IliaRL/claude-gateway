#!/usr/bin/env python3
"""
Rebuild all 13 Antigravity accounts from scratch.
Backs up old configs, creates fresh credential files, and updates provider_pools.json.
"""

import json
import os
import shutil
from pathlib import Path
from datetime import datetime

# All 13 accounts with refresh tokens
ACCOUNTS = [
    {"email": "xxiliarlxx@gmail.com", "refresh_token": "1//0cnUphM0yHx7RCgYIARAAGAwSNwF-L9IryY1WgiYVoZck7kpxKI9-HbtkXM8Ca1bgRHyf132uEYuCn9CPHfwSbJ3Oni-VSgHsxA4"},
    {"email": "iliarl353@gmail.com", "refresh_token": "1//0cKaID8TDO9IkCgYIARAAGAwSNwF-L9IreLNnNfKNNQFBwz7PKqzlKl-d7gEhk5KgOAxfhs594hyRfkGcgcLUaCPXePecxVi9iOU"},
    {"email": "ourneeds.inc@gmail.com", "refresh_token": "1//0c4LcHKZZhfjFCgYIARAAGAwSNwF-L9IrubCtxxVJEKjf5jADWks8Pk2G3pBKE1lXKh4cOZvu9yXqjcXvv2d_WiMN9A_5bsSl8so"},
    {"email": "alvarbtchmnnn@gmail.com", "refresh_token": "1//0czZN7zgPpocICgYIARAAGAwSNwF-L9IrrBDdE_rmHWs4lbDVFcal7uARAdgFeNr1z3HgKAUbzFsh2JkOlOENOVQRjlzsYMDMXL0"},
    {"email": "252iliarl@gmail.com", "refresh_token": "1//0crxRkgYivB2vCgYIARAAGAwSNwF-L9IrYjY2b8WiF3jH2BldKFGZp36nCfambBLgPcRnk1vu91ilGPGij6C5Vdzu8Mvi9mLjXq4"},
    {"email": "slots2472@gmail.com", "refresh_token": "1//0cqOYnsl_YG6QCgYIARAAGAwSNwF-L9IrK6PPv_rGFajQ9pCP6tZPGuaA6RRdCNag2NbenuERZ5_Wk8pha6FL4PorY_2OycHOZmY"},
    {"email": "rightatyourdoor33@gmail.com", "refresh_token": "1//0ce7mC6oPKOmRCgYIARAAGAwSNwF-L9Irohymq6ekkY_WidHOod5C22sUJ_mRxEQlss0VBj5KNiNHl_z9fgDegn9LnNtV_t3AbJc"},
    {"email": "rlmusic05@gmail.com", "refresh_token": "1//0c99VVb1EV0l3CgYIARAAGAwSNwF-L9IrcOTqm7ykzq1EpK3v9ImYOfYbirHZOuhiQtEEwJmuuJPASOGhDjQOhTYCoGq5cM02ILg"},
    {"email": "izzyrlmusic@gmail.com", "refresh_token": "1//0cI8YoltqFOGWCgYIARAAGAwSNwF-L9IrgHRWZT_dz_2iB4X8uqwcHSdcqQYs3MW0d1EtdSQVhgbngy-fKhlkLrVZbu1j9s03zxY"},
    {"email": "u3804759745@gmail.com", "refresh_token": "1//0cFnS-mVhnt3mCgYIARAAGAwSNgF-L9IrC3_cKaGtSEEcunPT0Imlv-IF2epJyAiEQCk4MZaCHgWFrYMH19JCH1W_pA5gWpAo-Q"},
    {"email": "bagginsb577@gmail.com", "refresh_token": "1//0cEf_xTEn1eVzCgYIARAAGAwSNwF-L9IrqExYqKBGK7msi3zvDXRj19n1s_DsAQRM6nwuNe5OxiZ9Bh4GiEWr7gIFm3N_UjS91xE"},
    {"email": "leenakata88@gmail.com", "refresh_token": "1//0cjsmh9tq3zYJCgYIARAAGAwSNwF-L9Ir1ulu-UPh5YYX6yWryIa5pzJhYgMRcgPdBPCG7tRm0LLnQDpyfHMkRo-6VJ0hrpgKF0Q"},
    {"email": "j34114095@gmail.com", "refresh_token": "1//0cwLYAFr2jKsvCgYIARAAGAwSNwF-L9IrVgNoBAHVD8w-2hnQ8-JGsILXaEMnUpgLrJlhR2Xzly3q32gzLHjZRh-nVSCHgXBAUyU"}
]

TIMESTAMP = int(datetime.now().timestamp() * 1000)
BASE_DIR = Path(__file__).parent.parent
ANTIGRAVITY_DIR = BASE_DIR / "configs" / "antigravity"
POOLS_FILE = BASE_DIR / "configs" / "provider_pools.json"

def main():
    # 1. Backup old antigravity directory
    if ANTIGRAVITY_DIR.exists():
        backup_dir = BASE_DIR / "configs" / f"antigravity_backup_{TIMESTAMP}"
        print(f"📦 Backing up {ANTIGRAVITY_DIR} → {backup_dir}")
        shutil.copytree(ANTIGRAVITY_DIR, backup_dir)
        shutil.rmtree(ANTIGRAVITY_DIR)

    # 2. Create fresh antigravity directory
    ANTIGRAVITY_DIR.mkdir(parents=True, exist_ok=True)
    print(f"📁 Created fresh {ANTIGRAVITY_DIR}")

    # 3. Create credential files for all 13 accounts
    cred_template = {
        "refresh_token": "",
        "access_token": "",
        "expiry_date": 0,
        "token_type": "Bearer",
        "scope": "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email"
    }

    for idx, account in enumerate(ACCOUNTS):
        cred_file = ANTIGRAVITY_DIR / f"{TIMESTAMP}_{idx}_oauth_creds.json"
        cred_data = cred_template.copy()
        cred_data["refresh_token"] = account["refresh_token"]

        with open(cred_file, "w") as f:
            json.dump(cred_data, f, indent=2)

        print(f"✅ Created {cred_file.name} for {account['email']}")

    # 4. Update provider_pools.json
    with open(POOLS_FILE, "r") as f:
        pools = json.load(f)

    # Replace gemini-antigravity array with all 13 accounts
    new_antigravity_pools = []
    for idx, account in enumerate(ACCOUNTS):
        pool_entry = {
            "ANTIGRAVITY_OAUTH_CREDS_FILE_PATH": f"./configs/antigravity/{TIMESTAMP}_{idx}_oauth_creds.json",
            "checkModelName": "claude-sonnet-4-5-20250929",
            "checkHealth": False,
            "customName": account["email"]
        }
        new_antigravity_pools.append(pool_entry)

    pools["gemini-antigravity"] = new_antigravity_pools

    with open(POOLS_FILE, "w") as f:
        json.dump(pools, f, indent=2)

    print(f"\n🔄 Updated {POOLS_FILE} with all 13 accounts")
    print(f"\n✨ Done! All 13 Antigravity accounts configured.")
    print(f"\nNext step: Restart the proxy with ./scripts/safe-restart.sh")

if __name__ == "__main__":
    main()
