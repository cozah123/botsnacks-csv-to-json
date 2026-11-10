"""Exercise the normal entry point across independent worker processes, entirely offline."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "offline.mjs"


class CatalogPilotTest(unittest.TestCase):
    def test_two_arrivals_redelivery_and_lost_response(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            events = folder / "events"
            events.touch()
            source = folder / "products.json"
            target = folder / "variants.csv"
            source.write_text(json.dumps({"products": [{"variants": [{"id": 1, "sku": "A", "price": "10"}]}]}))

            def run(price, expected_exit, *, policy=True, **options):
                target.write_text(f"id,sku,price\n1,A,{price}\n")
                args = [sys.executable, str(HERE.parent / "on_export.py"), str(source), str(target), str(folder / "state")]
                if policy:
                    args.extend(["--policy", str(FIXTURE)])
                env = {**os.environ, "NODE_OPTIONS": "--import=" + FIXTURE.as_uri(), "PILOT_FIXTURE_DIR": root, **options}
                result = subprocess.run(args, capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, expected_exit, result.stdout + result.stderr)
                return json.loads(result.stdout or result.stderr)

            self.assertEqual(run("10", 0, policy=False)["status"], "prepared")
            self.assertEqual(events.read_text(), "")
            self.assertEqual(run("10", 2, BUYER_DECLINES="1")["status"], "declined")
            self.assertFalse((folder / "state/pilot.json").exists())
            # Both workers receive the same already-written export.
            target.write_text("id,sku,price\n1,A,10\n")
            def simultaneous(_):
                args = [sys.executable, str(HERE.parent / "on_export.py"), str(source), str(target),
                        str(folder / "state"), "--policy", str(FIXTURE)]
                env = {**os.environ, "NODE_OPTIONS": "--import=" + FIXTURE.as_uri(), "PILOT_FIXTURE_DIR": root}
                return json.loads(subprocess.check_output(args, env=env, text=True))
            with ThreadPoolExecutor(max_workers=2) as pool:
                pair = list(pool.map(simultaneous, range(2)))
            self.assertCountEqual([entry["status"] for entry in pair], ["cached", "delivered"])
            first = pair[0]
            self.assertEqual(first["decision"], "pass")
            before = events.read_text()
            repeated = run("10", 0)
            self.assertEqual(repeated["status"], "cached")
            self.assertEqual(first["transaction"], repeated["transaction"])
            self.assertEqual(events.read_text(), before)
            self.assertEqual(run("30", 2, OTHER_PILOT_WALLET="1")["status"], "needs_review")
            self.assertEqual(events.read_text().splitlines().count("mock-sign"), 1)
            self.assertEqual(run("30", 2, LOSE_REPLY="1")["status"], "needs_review")
            second = run("30", 1, BUYER_DECLINES="1")
            self.assertEqual(second["decision"], "hold")
            self.assertNotEqual(first["transaction"], second["transaction"])
            calls = events.read_text().splitlines()
            self.assertEqual(calls.count("mock-sign"), 2)
            self.assertEqual(calls[-1], calls[-2])  # Same authorization replayed after response loss.
            self.assertEqual(run("50", 2)["status"], "pilot_limit")
            self.assertEqual(events.read_text().splitlines(), calls)
            self.assertTrue(Path(first["report_file"]).is_file())
            self.assertTrue(Path(second["report_file"]).is_file())


if __name__ == "__main__":
    unittest.main()
