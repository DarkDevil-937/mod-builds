"""publish.py with a GitHub CLI of its own: python -m unittest discover -s scripts"""
import hashlib
import json
import pathlib
import tempfile
import unittest

import publish

JOB = "0123456789abcdef01234567"
ASK = "0123456789abcdef0123456789abcdef"


class Publish(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.result = self.dir / "result"
        self.result.mkdir()
        self.calls = []

    def gh(self, *args, check=True):
        uploaded = None
        if args[:2] == ("release", "upload"):
            uploaded = pathlib.Path(args[3]).read_bytes()
        self.calls.append((args, uploaded))

    def run_publish(self, built=True):
        publish.publish(self.result, JOB, ASK, built, self.gh, self.dir / "answer")
        return [(c[0][:3] + (pathlib.Path(c[0][3]).name,) if c[0][1] == "upload" else c[0][:4]) for c in self.calls]

    def uploaded(self, name):
        return next(data for args, data in self.calls if args[1] == "upload" and args[3].endswith(name))

    def built(self, library=b"\x7fELF the game", **status):
        (self.result / "libhorizon_android.so").write_bytes(library)
        about = {"state": "done", "sha256": hashlib.sha256(library).hexdigest(), "size": len(library),
                 "build": {"abi": "arm64-v8a", "sha256": "x"}}
        about.update(status)
        (self.result / "status.json").write_text(json.dumps(about))

    def test_a_build_puts_the_library_up_before_its_status(self):
        self.built(extra="what a mod could add")
        calls = self.run_publish()
        self.assertEqual(calls[0], ("release", "upload", "results", f"{JOB}.so"))
        self.assertEqual(calls[1], ("release", "upload", "results", f"{JOB}.json"))
        self.assertIn(("release", "delete-asset", "results", f"{JOB}.failed.json"), calls)
        self.assertEqual(calls[-1], ("release", "delete-asset", "requests", f"{ASK}.bin"))
        status = json.loads(self.uploaded(f"{JOB}.json"))
        self.assertEqual(set(status), {"state", "sha256", "size", "build"})
        self.assertEqual(self.uploaded(f"{JOB}.so"), b"\x7fELF the game")

    def test_a_library_unlike_its_status_is_not_served(self):
        self.built(size=999)
        calls = self.run_publish()
        self.assertEqual(calls[0], ("release", "upload", "results", f"{JOB}.failed.json"))
        self.assertFalse(json.loads(self.uploaded(f"{JOB}.failed.json"))["settled"])

    def test_the_mods_own_failure_is_told_as_it_is(self):
        (self.result / "status.json").write_text(
            json.dumps({"state": "failed", "error": "error[E0425]: cannot find value", "settled": True}))
        self.run_publish()
        failure = json.loads(self.uploaded(f"{JOB}.failed.json"))
        self.assertEqual(failure["error"], "error[E0425]: cannot find value")
        self.assertTrue(failure["settled"])
        self.assertIn("at", failure)

    def test_a_build_that_never_ended_may_be_tried_again(self):
        calls = self.run_publish(built=False)
        failure = json.loads(self.uploaded(f"{JOB}.failed.json"))
        self.assertEqual(failure["error"], publish.DID_NOT_FINISH)
        self.assertFalse(failure["settled"])
        self.assertEqual(calls[-1], ("release", "delete-asset", "requests", f"{ASK}.bin"))

    def test_names_that_are_not_a_request_stop_it(self):
        with self.assertRaises(SystemExit):
            publish.publish(self.result, "../etc", ASK, True, self.gh, self.dir / "answer")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
