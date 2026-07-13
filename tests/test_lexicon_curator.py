from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import sys


APP_ROOT = Path(__file__).resolve().parents[1] / "apps" / "learning-os"
sys.path.insert(0, str(APP_ROOT))

from curator import Curator  # noqa: E402
from wiki_library import WikiLibrary  # noqa: E402


class CuratorTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmpdir.name) / "workspace"
        self.lexicon_sources = self.workspace / "wiki" / ".lexicon" / "sources"
        self.lexicon_sources.mkdir(parents=True, exist_ok=True)
        (self.workspace / "wiki" / "sources").mkdir(parents=True, exist_ok=True)
        self.curator = Curator(self.workspace)

    def tearDown(self):
        self._tmpdir.cleanup()

    def _manifest(self, source_id, title, entities, relations=(), note_body="body"):
        # Entity dicts default to scope="general" unless a test sets it, matching
        # the Curator's _norm_scope default (so most tests stay concise).
        note_page = f"sources/{source_id}.md"
        note = self.workspace / "wiki" / note_page
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text(f"# {title}\n\n{note_body}\n\nSource: {source_id}\n", encoding="utf-8")
        manifest = {
            "source_id": source_id, "title": title, "note_page": note_page,
            "entities": entities,
            "relations": [{"from": f, "to": t, "type": ty, "evidence": "e"}
                          for (f, t, ty) in relations],
        }
        (self.lexicon_sources / f"{source_id}.json").write_text(
            json.dumps(manifest), encoding="utf-8")

    def _registry(self):
        path = self.workspace / "wiki" / ".lexicon" / "entities.json"
        return {e["id"]: e for e in json.loads(path.read_text(encoding="utf-8"))["entities"]}

    def test_same_name_and_type_merges_across_sources(self):
        self._manifest("src-a", "Paper A", [
            {"name": "Transformer", "type": "framework", "aliases": ["transformers"], "evidence": "attention model"}])
        self._manifest("src-b", "Paper B", [
            {"name": "transformer", "type": "framework", "aliases": ["xformer"], "evidence": "seq model"}])

        result = self.curator.curate()
        self.assertTrue(result["ok"])
        registry = self._registry()
        self.assertEqual(len(registry), 1)
        entity = next(iter(registry.values()))
        self.assertEqual(entity["type"], "framework")
        self.assertEqual(len(entity["sources"]), 2)
        self.assertIn("transformers", entity["aliases"])
        self.assertIn("xformer", entity["aliases"])

    def test_same_name_different_type_stays_separate_and_flagged(self):
        self._manifest("src-a", "A", [{"name": "React", "type": "framework", "evidence": "ui lib"}])
        self._manifest("src-b", "B", [{"name": "react", "type": "concept", "evidence": "to respond"}])

        self.curator.curate()
        registry = self._registry()
        self.assertEqual(len(registry), 2)
        for entity in registry.values():
            self.assertIn("ambiguous-type", entity["flags"])

    def test_labeled_relations_between_general_entities_are_recorded(self):
        self._manifest("src-a", "A", [
            {"name": "Pydantic", "type": "library", "evidence": "x"},
            {"name": "data validation", "type": "concept", "evidence": "y"},
        ], relations=[("Pydantic", "data validation", "used_for")])
        self.curator.curate()
        relations = json.loads(
            (self.workspace / "wiki" / ".lexicon" / "relations.json").read_text(encoding="utf-8"))
        self.assertEqual(len(relations["relations"]), 1)
        rel = relations["relations"][0]
        self.assertEqual(rel["type"], "used_for")
        self.assertEqual(rel["from"], "library--pydantic")
        self.assertEqual(rel["to"], "concept--data-validation")
        self.assertIn("src-a", rel["sources"])

    def test_local_scope_entities_are_not_promoted(self):
        self._manifest("src-a", "A", [
            {"name": "Pydantic", "type": "library", "scope": "general", "evidence": "x"},
            {"name": "validator node", "type": "concept", "scope": "local", "evidence": "y"},
        ])
        self.curator.curate()
        registry = self._registry()
        names = {e["name"] for e in registry.values()}
        self.assertEqual(names, {"Pydantic"})           # local jargon stays out

    def test_relations_touching_local_entities_are_dropped(self):
        self._manifest("src-a", "A", [
            {"name": "Pydantic", "type": "library", "scope": "general", "evidence": "x"},
            {"name": "validator node", "type": "concept", "scope": "local", "evidence": "y"},
        ], relations=[("Pydantic", "validator node", "used_for")])
        self.curator.curate()
        relations = json.loads(
            (self.workspace / "wiki" / ".lexicon" / "relations.json").read_text(encoding="utf-8"))
        self.assertEqual(relations["relations"], [])    # can't relate to un-promoted local term

    def test_typed_entity_pages_and_index_are_written(self):
        self._manifest("src-a", "A", [
            {"name": "PyTorch", "type": "library", "evidence": "tensor library"},
            {"name": "Gradient Descent", "type": "concept", "evidence": "optimization"},
        ], relations=[("PyTorch", "Gradient Descent", "used_for")])
        self.curator.curate()
        lib_page = self.workspace / "wiki" / "entities" / "library" / "pytorch.md"
        concept_page = self.workspace / "wiki" / "entities" / "concept" / "gradient-descent.md"
        index_page = self.workspace / "wiki" / "indexes" / "entities.md"
        self.assertTrue(lib_page.exists())
        self.assertTrue(concept_page.exists())
        self.assertTrue(index_page.exists())
        body = lib_page.read_text(encoding="utf-8")
        self.assertIn("**Type:** library", body)
        self.assertIn("tensor library", body)          # grounded evidence fallback
        self.assertIn("## How it appears in imported sources", body)
        self.assertIn("## Relationships", body)
        self.assertIn("**used for** → [[Gradient Descent]]", body)   # labeled, directional

    def test_entity_pages_link_to_source_notes_as_graph_edges(self):
        self._manifest("src-a", "Attention Paper", [
            {"name": "Transformer", "type": "framework", "evidence": "arch"},
            {"name": "Self Attention", "type": "concept", "evidence": "mechanism"},
        ], relations=[("Transformer", "Self Attention", "depends_on")])
        self.curator.curate()
        index = WikiLibrary(self.workspace).index()
        edges = {(e["source"], e["target"]) for e in index["edges"]}
        # entity page -> source note edge (relative ../../sources link must resolve)
        self.assertIn(("entities/framework/transformer.md", "sources/src-a.md"), edges)
        # entity -> related entity edge (from the labeled relation)
        self.assertIn(("entities/framework/transformer.md", "entities/concept/self-attention.md"), edges)
        # manifest folder never surfaces as a page
        self.assertFalse(any(".lexicon" in p["path"] for p in index["pages"]))

    def test_registry_reports_counts_by_type(self):
        self._manifest("src-a", "A", [
            {"name": "PyTorch", "type": "library", "evidence": "x"},
            {"name": "Adam", "type": "tool", "evidence": "y"},
            {"name": "Backprop", "type": "concept", "evidence": "z"},
        ])
        self.curator.curate()
        registry = self.curator.registry()
        self.assertTrue(registry["ok"])
        self.assertEqual(registry["total"], 3)
        self.assertEqual(registry["by_type"], {"library": 1, "tool": 1, "concept": 1})

    def test_enrichment_survives_recuration(self):
        self._manifest("src-a", "A", [{"name": "Transformer", "type": "framework", "evidence": "x"}])
        self.curator.curate()
        # Simulate the enrichment stage writing into the registry (an object now).
        path = self.workspace / "wiki" / ".lexicon" / "entities.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["entities"][0]["enrichment"] = {
            "description": "A landmark 2017 neural network architecture.",
            "external_context": "It underpins modern large language models.",
            "confidence": "high",
        }
        path.write_text(json.dumps(data), encoding="utf-8")

        self.curator.curate()   # re-run: page + registry regenerate
        body = (self.workspace / "wiki" / "entities" / "framework" / "transformer.md").read_text(encoding="utf-8")
        self.assertIn("A landmark 2017 neural network architecture.", body)   # What it is
        self.assertIn("It underpins modern large language models.", body)     # External context
        self.assertIn("General knowledge, not drawn from your sources", body) # labeled as external

    def test_unknown_type_falls_back_to_topic(self):
        self._manifest("src-a", "A", [{"name": "Mystery", "type": "banana", "evidence": "x"}])
        self.curator.curate()
        registry = self._registry()
        self.assertEqual(next(iter(registry.values()))["type"], "topic")

    def test_empty_workspace_curates_cleanly(self):
        result = self.curator.curate()
        self.assertTrue(result["ok"])
        self.assertEqual(result["entities"], 0)
        index_page = self.workspace / "wiki" / "indexes" / "entities.md"
        self.assertTrue(index_page.exists())

    # ── impact_of_source (delete preview) ────────────────────────────────────

    def test_impact_of_unindexed_source_is_empty(self):
        impact = self.curator.impact_of_source("src-never-seen")
        self.assertTrue(impact["ok"])
        self.assertEqual(impact["entities_removed"], [])
        self.assertEqual(impact["entities_affected"], [])
        self.assertEqual(impact["relations_removed"], 0)

    def test_impact_identifies_entity_removed_when_source_is_sole_owner(self):
        self._manifest("src-a", "A", [{"name": "Unique Thing", "type": "concept", "evidence": "x"}])
        impact = self.curator.impact_of_source("src-a")
        self.assertEqual([e["name"] for e in impact["entities_removed"]], ["Unique Thing"])
        self.assertEqual(impact["entities_affected"], [])

    def test_impact_identifies_entity_affected_when_shared_across_sources(self):
        self._manifest("src-a", "A", [{"name": "Shared Thing", "type": "concept", "evidence": "x"}])
        self._manifest("src-b", "B", [{"name": "Shared Thing", "type": "concept", "evidence": "y"}])
        impact = self.curator.impact_of_source("src-a")
        self.assertEqual(impact["entities_removed"], [])
        self.assertEqual([e["name"] for e in impact["entities_affected"]], ["Shared Thing"])

    def test_impact_counts_relations_removed(self):
        self._manifest("src-a", "A", [
            {"name": "Alpha", "type": "concept", "evidence": "x"},
            {"name": "Beta", "type": "concept", "evidence": "y"},
        ], relations=[("Alpha", "Beta", "related_to")])
        impact = self.curator.impact_of_source("src-a")
        self.assertEqual(impact["relations_removed"], 1)

    def test_impact_is_pure_and_does_not_write_anything(self):
        self._manifest("src-a", "A", [{"name": "Alpha", "type": "concept", "evidence": "x"}])
        registry_path = self.workspace / "wiki" / ".lexicon" / "entities.json"
        self.assertFalse(registry_path.exists())
        self.curator.impact_of_source("src-a")
        self.assertFalse(registry_path.exists())   # curate() was never called

    def test_impact_predicts_forget_source_effect_exactly(self):
        self._manifest("src-a", "A", [
            {"name": "OnlyInA", "type": "concept", "evidence": "x"},
            {"name": "Shared", "type": "concept", "evidence": "x"},
        ])
        self._manifest("src-b", "B", [{"name": "Shared", "type": "concept", "evidence": "y"}])
        self.curator.curate()   # establish the "before" canonical state

        impact = self.curator.impact_of_source("src-a")
        removed_names = {e["name"] for e in impact["entities_removed"]}
        self.assertEqual(removed_names, {"OnlyInA"})

        # Simulate what forget_source does: drop the manifest, re-curate.
        (self.workspace / "wiki" / ".lexicon" / "sources" / "src-a.json").unlink()
        self.curator.curate()
        registry = self._registry()
        self.assertNotIn("concept--onlyina", registry)
        self.assertIn("concept--shared", registry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
