#!/usr/bin/env python3
"""Encrypt and write a GitHub Actions Secret without exposing its value."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

from nacl import encoding, public

API_BASE = "https://api.github.com"
API_VERSION = "2022-11-28"
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SECRET_NAME_PATTERN = re.compile(r"^[A-Z_][A-Z0-9_]{0,99}$")


def encrypt_secret(public_key_base64: str, value: str) -> str:
    key = public.PublicKey(public_key_base64.encode("ascii"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(key)
    return base64.b64encode(sealed_box.encrypt(value.encode("utf-8"))).decode("ascii")


class GitHubApi:
    def __init__(self, token: str, base_url: str = API_BASE) -> None:
        if not token:
            raise ValueError("A GitHub token is required")
        self._token = token
        self._base_url = base_url.rstrip("/")

    def request(self, path: str, method: str = "GET", payload: dict | None = None) -> dict:
        if not path.startswith("/"):
            raise ValueError("GitHub API path is invalid")
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=body,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": API_VERSION,
                **({} if body is None else {"Content-Type": "application/json; charset=utf-8"}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
                return {} if not data else json.loads(data.decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"GitHub {method} {path.split('?')[0]} returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError(f"GitHub {method} {path.split('?')[0]} request failed") from None


def set_secret(api: GitHubApi, repository: str, name: str, value: str) -> dict:
    key = api.request(f"/repos/{repository}/actions/secrets/public-key")
    key_id = key.get("key_id")
    public_key = key.get("key")
    if not isinstance(key_id, str) or not isinstance(public_key, str):
        raise RuntimeError("GitHub returned invalid Actions Secret key metadata")
    encrypted = encrypt_secret(public_key, value)
    api.request(
        f"/repos/{repository}/actions/secrets/{name}",
        method="PUT",
        payload={"encrypted_value": encrypted, "key_id": key_id},
    )
    return {
        "schemaVersion": "release-ops-github-secret-write/v1",
        "repository": repository,
        "name": name,
        "updated": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Encrypt and write one GitHub Actions Secret")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--value-env", required=True)
    parser.add_argument("--confirm-repository", required=True)
    args = parser.parse_args()
    if not REPOSITORY_PATTERN.fullmatch(args.repository):
        raise ValueError("Repository must use owner/name format")
    if args.confirm_repository != args.repository:
        raise ValueError("--confirm-repository must exactly match --repository")
    if not SECRET_NAME_PATTERN.fullmatch(args.name):
        raise ValueError("Secret name is invalid")
    if not SECRET_NAME_PATTERN.fullmatch(args.value_env):
        raise ValueError("Secret source environment variable is invalid")
    value = os.environ.get(args.value_env)
    if not value:
        raise ValueError(f"Environment variable {args.value_env} is required")
    token = os.environ.get("github_token") or os.environ.get("GITHUB_TOKEN")
    result = set_secret(GitHubApi(token or ""), args.repository, args.name, value)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The message is deliberately bounded by the API and validators above.
        print(f"GitHub Secret update failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
