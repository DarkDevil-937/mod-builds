#!/usr/bin/env python3
"""Keeps the releases the Compile service uses small: sealed mods older than a day (a run that never
came), and builds older than RESULT_DAYS or beyond the newest RESULTS_KEPT (a release holds 1000 assets
at most). Asking for the same mods again builds them again."""
import calendar
import json
import os
import subprocess
import time

RESULT_DAYS = 14
RESULTS_KEPT = 900
REQUEST_DAYS = 1


def gh_json(*args):
    return json.loads(subprocess.run(["gh", "api", *args], check=True, capture_output=True).stdout)


def assets(tag):
    release = gh_json(f"repos/{os.environ['GH_REPO']}/releases/tags/{tag}")
    pages = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", f"repos/{os.environ['GH_REPO']}/releases/{release['id']}/assets?per_page=100"],
        check=True,
        capture_output=True,
    ).stdout
    return [a for page in json.loads(pages) for a in page]


def stale(listed, days, kept, now):
    """The assets to delete: older than `days`, or beyond the `kept` newest."""
    newest = sorted(listed, key=lambda a: a["created_at"], reverse=True)
    old = now - days * 86400
    return [
        a
        for i, a in enumerate(newest)
        if i >= kept or calendar.timegm(time.strptime(a["created_at"], "%Y-%m-%dT%H:%M:%SZ")) < old
    ]


def main():
    now = time.time()
    for tag, days, kept in (("requests", REQUEST_DAYS, 10**9), ("results", RESULT_DAYS, RESULTS_KEPT)):
        gone = stale(assets(tag), days, kept, now)
        for asset in gone:
            subprocess.run(
                ["gh", "api", "-X", "DELETE", f"repos/{os.environ['GH_REPO']}/releases/assets/{asset['id']}"],
                check=True,
            )
        print(f"{tag}: {len(gone)} deleted")


if __name__ == "__main__":
    main()
