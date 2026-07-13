from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys


APP_ROOT = Path(__file__).resolve().parents[1] / "apps" / "learning-os"
sys.path.insert(0, str(APP_ROOT))

from wiki_library import WikiLibrary  # noqa: E402


class WikiLibraryTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmpdir.name) / "workspace"
        self.wiki = self.workspace / "wiki"
        self.wiki.mkdir(parents=True, exist_ok=True)
        self.library = WikiLibrary(self.workspace)

    def tearDown(self):
        self._tmpdir.cleanup()

    def write(self, rel: str, content: str):
        path = self.wiki / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_index_extracts_titles_and_wikilinks(self):
        self.write("transformers.md", "# Transformers\n\nAttention is central. See [[Attention Notes]].\n")
        self.write("attention-notes.md", "# Attention Notes\n\nDetails here.\n")

        index = self.library.index()
        self.assertTrue(index["ok"])
        paths = {p["path"]: p for p in index["pages"]}
        self.assertIn("transformers.md", paths)
        self.assertEqual(paths["transformers.md"]["title"], "Transformers")
        self.assertEqual(paths["transformers.md"]["links"], ["attention-notes.md"])
        self.assertEqual(paths["attention-notes.md"]["backlinks"], ["transformers.md"])
        self.assertEqual(index["edges"], [{"source": "transformers.md", "target": "attention-notes.md"}])

    def test_relative_markdown_links_resolve_within_folders(self):
        self.write("2026-W27/summary.md", "# Weekly Summary\n\nSee [detail](detail.md) and [root](../index.md).\n")
        self.write("2026-W27/detail.md", "# Detail\n\nBody.\n")
        self.write("index.md", "# Index\n\nHome.\n")

        index = self.library.index()
        summary = next(p for p in index["pages"] if p["path"] == "2026-W27/summary.md")
        self.assertIn("2026-W27/detail.md", summary["links"])
        self.assertIn("index.md", summary["links"])
        self.assertEqual(summary["folder"], "2026-W27")

    def test_wikilink_with_label_and_section_resolves(self):
        self.write("a.md", "# A\n\n[[B#Some Section|the b page]]\n")
        self.write("b.md", "# B\n\nBody.\n")

        index = self.library.index()
        a = next(p for p in index["pages"] if p["path"] == "a.md")
        self.assertEqual(a["links"], ["b.md"])

    def test_unresolved_links_are_dropped(self):
        self.write("a.md", "# A\n\n[[Nowhere Page]] and [gone](missing.md)\n")

        index = self.library.index()
        a = next(p for p in index["pages"] if p["path"] == "a.md")
        self.assertEqual(a["links"], [])
        self.assertEqual(index["edges"], [])

    def test_external_urls_are_ignored(self):
        self.write("a.md", "# A\n\n[site](https://example.com/page.md)\n")

        index = self.library.index()
        a = next(p for p in index["pages"] if p["path"] == "a.md")
        self.assertEqual(a["links"], [])

    def test_page_returns_content_and_described_backlinks(self):
        self.write("a.md", "# Alpha Page\n\nLinks to [[Beta Page]].\n")
        self.write("b.md", "# Beta Page\n\nBody text.\n")

        page = self.library.page("b.md")
        self.assertTrue(page["ok"])
        self.assertIn("Body text.", page["page"]["content"])
        self.assertEqual(page["page"]["backlinks"], [{"path": "a.md", "title": "Alpha Page"}])

    def test_page_traversal_is_blocked(self):
        outside = self.workspace / "raw"
        outside.mkdir(parents=True, exist_ok=True)
        (outside / "secret.md").write_text("secret", encoding="utf-8")

        result = self.library.page("../raw/secret.md")
        self.assertFalse(result["ok"])

    def test_missing_wiki_dir_yields_empty_index(self):
        library = WikiLibrary(Path(self._tmpdir.name) / "elsewhere")
        index = library.index()
        self.assertTrue(index["ok"])
        self.assertEqual(index["pages"], [])
        self.assertEqual(index["edges"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
