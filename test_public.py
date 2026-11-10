"""The public copy stays clean: python3 -m unittest test_public.py (tools/public_tree.py)."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
import public_tree as pt  # noqa: E402


class Scanner(unittest.TestCase):
    def rules(self, text):
        return [h[2] for h in pt.scan_text("x", text)]

    def test_each_rule_catches_its_case(self):
        # Built at run time, so this file never holds a banned string itself.
        cases = [
            ("tailnet address", "https://mac." + "tail" + "1a2b3c.ts" + ".net:8494"),
            ("tailnet address", "/mac\\." + "tail" + "1a2b3c\\.ts\\.net/"),  # as written in a regex
            ("tailnet address", "the " + "tail" + "1a2b3c tailnet"),
            ("tailnet address", "https://mac.yak-" + "bebop.ts" + ".net:8494"),  # a word-style tailnet name (r3 on #63)
            ("home path", "/Us" + "ers/realname/rw-artifacts/a.png"),
            ("home path", "/\\/Us" + "ers\\/realname\\/rw-artifacts/"),  # as written in a regex or JSON
            ("home path", "HOME=/Us" + "ers/realname"),  # the folder itself (r3 on #63)
            ("home path", "/Us" + "ers/meredith/x"),  # a name that starts like a placeholder
            ("pitch name", "Offer b to " + "The" + "o when you pitch"),
            ("1Password reference", "op:" + "//Vault/Item/field"),
            ("1Password reference", '{"key": "op:' + '\\/\\/Vault\\/Item\\/field"}'),  # JSON-escaped (r4 on #63)
            ("private key", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"),
            ("API key", "sk-" + "a" * 24),
            ("API key", "LINEAR_API_KEY=" + "lin_api_" + "a1" * 20),
            ("API key", "bb_" + "live_" + "a1" * 12),
            ("API key", "OP_SERVICE_ACCOUNT_TOKEN=" + "ops_" + "eyJ" + "a" * 60),
        ]
        for rule, text in cases:
            self.assertEqual(set(self.rules(text)), {rule}, text)

    def test_a_secret_is_never_kept_in_a_hit(self):
        # PR-Agent r1 on #63: a found key must not reach the terminal or a failed test's output.
        for text in ("lin_api_" + "a1" * 20, "op:" + "//Vault/Item/field", "-----BEGIN " + "PRIVATE KEY-----"):
            hits = pt.scan_text("x", text)
            self.assertEqual([h[3] for h in hits], ["(hidden)"], hits[0][2])

    def test_placeholders_pass(self):
        for text in ("/Users/chef/rw-artifacts/a.png", "/Users/<name>/x", "/Users/you", "/Users/Shared/x",
                     "https://mac.example.ts.net:8443", "https://<mac>.<tailnet>.ts.net:8494",
                     "LINEAR_API_KEY=<op:// reference>", "Theory and theorems", "Theodore"):
            self.assertEqual(self.rules(text), [], text)

    def test_binary_files_are_skipped(self):
        self.assertEqual(pt.scan_bytes("a.png", b"\x89PNG\0" + b"tail" + b"1a2b3c.ts" + b".net"), [])

    def test_private_files_are_not_scanned(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        private = sorted(pt.PRIVATE)[0]
        os.makedirs(os.path.join(root, os.path.dirname(private)), exist_ok=True)
        with open(os.path.join(root, private), "w") as f:
            f.write("The" + "o\n")
        with open(os.path.join(root, "a.md"), "w") as f:
            f.write("The" + "o\n")
        self.assertEqual([h[0] for h in pt.check(root, [private, "a.md"])], ["a.md"])


class Repo(unittest.TestCase):
    def test_tracked_files_are_clean(self):
        hits = [h[:3] for h in pt.check()]  # file, line and rule only
        self.assertEqual(hits, [], "\n".join("%s:%d: %s" % h for h in hits))

    def test_build_leaves_private_files_out(self):
        out = os.path.join(tempfile.mkdtemp(), "public")
        self.addCleanup(shutil.rmtree, os.path.dirname(out))
        files, hits = pt.build(out)
        self.assertEqual([h[:3] for h in hits], [])
        self.assertIn("LICENSE", files)
        for p in pt.PRIVATE:
            self.assertNotIn(p, files)
            self.assertFalse(os.path.exists(os.path.join(out, p)))


if __name__ == "__main__":
    unittest.main()
