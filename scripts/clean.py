#!/usr/bin/env python3
"""Keeps the releases the Compile service uses small: sealed mods older than six hours (a run that never
came, or one whose answer could not be put up: a build waits and runs well under that), and builds
older than RESULT_DAYS or beyond the newest RESULTS_KEPT (a release holds 1000 assets at most). Asking
for the same mods again builds them again."""
import calendar
import json
import os
import subprocess
import time

RESULT_DAYS = 14
RESULTS_KEPT = 900
LEGACY_KEPT = 600
REQUEST_DAYS = 0.25


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
    shards = [(f"results-{c}", RESULT_DAYS, RESULTS_KEPT) for c in "0123456789abcdef"]
    # "results" is the release before the shards: a release holds 1000 assets at most, and one
    # filled in the first evening, so builds go to results-<first hex digit of the job> now.
    for tag, days, kept in [("requests", REQUEST_DAYS, 10**9), ("results", RESULT_DAYS, LEGACY_KEPT), *shards]:
        gone = stale(assets(tag), days, kept, now)
        for asset in gone:
            subprocess.run(
                ["gh", "api", "-X", "DELETE", f"repos/{os.environ['GH_REPO']}/releases/assets/{asset['id']}"],
                check=True,
            )
        print(f"{tag}: {len(gone)} deleted")


if __name__ == "__main__":
    main()
