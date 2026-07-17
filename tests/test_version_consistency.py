"""Version consistency tests for the Arduino to Codespaces Bridge extension.

The extension uses a single source of truth for its version: the ``version``
field in ``arduino-to-codespaces-bridge/package.json`` (the "build version").
Everything else must either equal that value or derive from it at build/run
time:

* ``CHANGELOG.md`` must have a matching, top-most ``## [x.y.z]`` entry.
* ``.vscode/tasks.json`` installs ``...-<version>.vsix`` and must match.
* The extension server (``src/server/index.ts``), the dev server
  (``web-client/server.js``) and the web client (``main.js`` via Vite) must NOT
  hard-code a version string — they read it from ``package.json`` so they can
  never drift.

Run with::

    python3 -m pytest tests/ -v
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

REPO_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = REPO_ROOT / "arduino-to-codespaces-bridge"
WEB_CLIENT_DIR = EXTENSION_DIR / "web-client"

PACKAGE_JSON = EXTENSION_DIR / "package.json"
CHANGELOG = EXTENSION_DIR / "CHANGELOG.md"
TASKS_JSON = REPO_ROOT / ".vscode" / "tasks.json"
EXTENSION_SERVER = EXTENSION_DIR / "src" / "server" / "index.ts"
DEV_SERVER = WEB_CLIENT_DIR / "server.js"
CLIENT_MAIN = WEB_CLIENT_DIR / "src" / "client" / "main.js"
VITE_CONFIG = WEB_CLIENT_DIR / "vite.config.js"

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
CHANGELOG_HEADING_RE = re.compile(r"^##\s*\[(\d+\.\d+\.\d+)\]", re.MULTILINE)


# --------------------------------------------------------------------------- #
# Helpers / fixtures
# --------------------------------------------------------------------------- #


def _read(path: Path) -> str:
    assert path.is_file(), f"Expected file does not exist: {path}"
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def canonical_version() -> str:
    """The single source of truth: package.json ``version``."""
    data = json.loads(_read(PACKAGE_JSON))
    version = data.get("version")
    assert version, "package.json is missing a 'version' field"
    return version


# --------------------------------------------------------------------------- #
# Canonical value
# --------------------------------------------------------------------------- #


def test_package_version_is_valid_semver(canonical_version: str) -> None:
    assert SEMVER_RE.match(canonical_version), (
        f"package.json version '{canonical_version}' is not valid semver"
    )


# --------------------------------------------------------------------------- #
# Locations that hold a literal copy of the version
# --------------------------------------------------------------------------- #


def test_changelog_has_matching_entry(canonical_version: str) -> None:
    text = _read(CHANGELOG)
    assert f"[{canonical_version}]" in text, (
        f"CHANGELOG.md has no '## [{canonical_version}]' entry for the current "
        f"build version"
    )


def test_changelog_latest_entry_is_canonical(canonical_version: str) -> None:
    text = _read(CHANGELOG)
    headings = CHANGELOG_HEADING_RE.findall(text)
    assert headings, "CHANGELOG.md has no '## [x.y.z]' version headings"
    assert headings[0] == canonical_version, (
        f"CHANGELOG.md's newest entry is '{headings[0]}' but package.json is "
        f"'{canonical_version}' — add/update the top changelog section"
    )


def test_install_task_references_matching_vsix(canonical_version: str) -> None:
    text = _read(TASKS_JSON)
    expected = f"arduino-to-codespaces-bridge-{canonical_version}.vsix"
    assert expected in text, (
        f".vscode/tasks.json does not reference '{expected}' — the Install "
        f"Extension task points at a stale VSIX filename"
    )
    # Guard against a second, stale filename lingering.
    stale = re.findall(r"arduino-to-codespaces-bridge-(\d+\.\d+\.\d+)\.vsix", text)
    mismatched = [v for v in stale if v != canonical_version]
    assert not mismatched, (
        f".vscode/tasks.json references stale VSIX version(s): {mismatched}"
    )


# --------------------------------------------------------------------------- #
# Places that must DERIVE the version (no hard-coded literal allowed)
# --------------------------------------------------------------------------- #


def test_extension_server_derives_version() -> None:
    text = _read(EXTENSION_SERVER)
    assert not re.search(r'SERVER_VERSION\s*=\s*["\']\d', text), (
        "src/server/index.ts hard-codes SERVER_VERSION; it must derive the "
        "version from package.json instead"
    )
    assert "packageJSON" in text or "package.json" in text, (
        "src/server/index.ts should read the version from package.json"
    )


def test_dev_server_derives_version() -> None:
    text = _read(DEV_SERVER)
    assert not re.search(r'SERVER_VERSION\s*=\s*["\']\d', text), (
        "web-client/server.js hard-codes SERVER_VERSION; it must read it from "
        "../package.json instead"
    )
    assert "package.json" in text, (
        "web-client/server.js should read the version from ../package.json"
    )


def test_client_derives_version() -> None:
    text = _read(CLIENT_MAIN)
    assert not re.search(r'CLIENT_VERSION\s*=\s*["\']\d', text), (
        "main.js hard-codes CLIENT_VERSION; it must use the Vite-injected "
        "__APP_VERSION__ instead"
    )
    assert "__APP_VERSION__" in text, (
        "main.js should use the injected __APP_VERSION__ constant"
    )


def test_vite_injects_version_from_package_json() -> None:
    text = _read(VITE_CONFIG)
    assert "__APP_VERSION__" in text, (
        "vite.config.js must define __APP_VERSION__"
    )
    assert "package.json" in text, (
        "vite.config.js must read the version from package.json"
    )
