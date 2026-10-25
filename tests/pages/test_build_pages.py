import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_pages", ROOT / "scripts/build_pages.py")
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)


class PublicFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="movie-log-pages-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "assets").mkdir()
        (self.source / "deploy").mkdir()
        self.html = '<img src="assets/icon.svg"><script>new URL(url, document.baseURI)</script>'
        (self.source / "index.html").write_text(self.html)
        (self.source / "assets/icon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.config = {"files": ["index.html", "assets/icon.svg"], "ignored_references": {}}
        self.output = self.base / "output"

    def manifest(self):
        (self.source / "deploy/pages-files.json").write_text(json.dumps(self.config))

    def build(self):
        self.manifest()
        return pages.build(self.source, self.output)

    def test_exact_copy_and_no_development_files(self):
        for name in [".env", ".DS_Store", "movie-log-backup-20261025.json", "supabase/migrations/backup.sql", "supabase/functions/tmdb/index.ts", "tests/test.cjs", "assets/unused.png"]:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("not for publication")
        expected, _ = self.build()
        pages.verify_output(self.output, expected)
        self.assertEqual(set(expected), {"index.html", "assets/icon.svg"})
        self.assertEqual((self.output / "index.html").read_bytes(), (self.source / "index.html").read_bytes())

    def test_missing_required_file_stops_before_output(self):
        (self.source / "assets/icon.svg").unlink()
        with self.assertRaises(pages.BuildError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_missing_index_is_rejected(self):
        self.config["files"].remove("index.html")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_duplicate_manifest_entry_is_rejected(self):
        self.config["files"].append("assets/icon.svg")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_forbidden_paths_are_rejected_even_if_manifest_lists_them(self):
        for name in ["../index.html", "/index.html", ".env", "assets/.env", "assets/.DS_Store", "supabase/functions/tmdb/index.ts", "supabase/migrations/test.sql", "tests/test.js", "assets/data.json", "assets/data.sql", "assets/db.dump", "assets/site-backup.js", "assets/x.bundle", "assets/x/../icon.svg"]:
            with self.subTest(path=name), self.assertRaises(pages.BuildError):
                pages.checked_path(name)

    def test_new_local_reference_requires_manifest_review(self):
        (self.source / "index.html").write_text(self.html + '<script src="assets/new.js"></script>')
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_unused_asset_is_rejected(self):
        (self.source / "assets/unused.png").write_bytes(b"fake image")
        self.config["files"].append("assets/unused.png")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_symlink_source_is_rejected(self):
        path = self.source / "assets/icon.svg"
        path.unlink()
        path.symlink_to(self.source / "index.html")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_symlink_parent_is_rejected(self):
        (self.source / "assets/alias").symlink_to(self.source / "assets", target_is_directory=True)
        self.config["files"].append("assets/alias/icon.svg")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_hardlink_source_is_rejected(self):
        os.link(self.source / "assets/icon.svg", self.base / "linked.svg")
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_known_secret_shapes_are_rejected_without_echoing_values(self):
        # Deliberately fake strings. No usable credentials or network calls.
        for sample in ["sb_" + "secret_" + "fakeonly123456789", "eyJfakeheader.fakepayload123.fakesignature123", "-----BEGIN PRIVATE KEY-----", "postgresql://fake:fake@localhost/fake", "ghp_" + "fakeonly" * 4, "'" + "abcdef12" * 4 + "'"]:
            with self.subTest(kind=sample.split(":")[0][:3]):
                (self.source / "index.html").write_text(self.html + sample)
                with self.assertRaises(pages.BuildError) as error:
                    self.build()
                self.assertNotIn(sample, str(error.exception))

    def test_publishable_key_is_allowed(self):
        (self.source / "index.html").write_text(self.html + 'sb_publishable_fakeonly12345678')
        self.build()

    def test_reviewed_missing_legacy_reference(self):
        (self.source / "index.html").write_text(self.html + '<style>.old {mask:url("assets/old.png")}</style>')
        self.config["ignored_references"]["assets/old.png"] = "Reviewed inactive legacy rule overridden by current CSS."
        files, ignored = self.build()
        self.assertNotIn("assets/old.png", files)
        self.assertIn("assets/old.png", ignored)

    def test_ignored_entry_cannot_hide_an_existing_asset(self):
        (self.source / "assets/old.png").write_bytes(b"existing")
        self.config["ignored_references"]["assets/old.png"] = "Reviewed inactive legacy rule overridden by current CSS."
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_root_relative_reference_is_rejected(self):
        (self.source / "index.html").write_text('<img src="/assets/icon.svg">')
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_encoded_non_ascii_path_resolves_under_subpath(self):
        refs = pages.local_references('<img src="assets/%E6%98%A0%E7%94%BB.png?v=1#image">', "index.html")
        self.assertEqual(refs, {"assets/映画.png"})

    def test_no_delete_or_overwrite_existing_output(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("keep")
        with self.assertRaises(pages.BuildError):
            self.build()
        self.assertEqual(sentinel.read_text(), "keep")

    def test_output_inside_source_is_rejected(self):
        self.output = self.source / "generated"
        with self.assertRaises(pages.BuildError):
            self.build()

    def test_artifact_tampering_or_extra_files_is_rejected(self):
        files, _ = self.build()
        extra = self.output / "backup.json"
        extra.write_text("[]")
        with self.assertRaises(pages.BuildError):
            pages.verify_output(self.output, files)
        extra.unlink()
        (self.output / "index.html").write_text("changed")
        with self.assertRaises(pages.BuildError):
            pages.verify_output(self.output, files)

    def test_extra_empty_output_directory_is_rejected(self):
        files, _ = self.build()
        (self.output / "supabase").mkdir()
        with self.assertRaises(pages.BuildError):
            pages.verify_output(self.output, files)

    def test_real_project_manifest(self):
        files, ignored = pages.public_files(ROOT)
        manifest = json.loads((ROOT / "deploy/pages-files.json").read_text())
        self.assertEqual(set(files), set(manifest["files"]))
        self.assertEqual(ignored, manifest["ignored_references"])
        self.assertEqual(files["index.html"], (ROOT / "index.html").read_bytes())


if __name__ == "__main__":
    unittest.main()
