"""
Curator — the single serialized writer of Lexicon's canonical knowledge.

Indexers are append-only per-source writers (one manifest + one note page
each). The Curator is the *only* thing that reads all manifests and writes the
shared, canonical layer:

- ``wiki/.lexicon/entities.json`` — the canonical entity registry
- ``wiki/.lexicon/relations.json`` — labeled, typed relations between entities
- ``wiki/entities/<type>/<slug>.md`` — one durable page per canonical entity
- ``wiki/indexes/entities.md`` — a typed index of every entity

Two judgement calls belong to the Indexer, not here: which extracted things are
real, reusable concepts (``scope == "general"``) versus a document's own
internal jargon (``scope == "local"``), and *why* two entities relate (a typed,
evidence-backed relation) rather than merely that they co-occurred. The Curator
only promotes ``general`` entities to canonical pages, and only records
relations the Indexer actually asserted between two such entities — so the graph
reflects understanding, not "these words appeared in the same file."

Merging is otherwise fully deterministic (no LLM): entities merge by normalized
name *within the same type*; the same name under a different type stays separate
and both are flagged ambiguous. Entity pages are derived artifacts, regenerated
from the registry every pass, so they never drift from the evidence. External
enrichment (a later LLM stage) lives in each entity's ``enrichment`` object in
the registry and is merged into the page, so regeneration preserves it.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, UTC
from pathlib import Path

from source_pipeline import slugify

ENTITY_TYPES = ("concept", "tool", "framework", "library", "person", "topic")
RELATION_TYPES = (
    "used_for", "depends_on", "part_of", "implements", "alternative_to",
    "produces", "consumes", "runs_on", "defined_by", "related_to",
)
_EVIDENCE_CAP = 6
_RELATION_CAP = 30


def _iso_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _norm_type(value: str) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in ENTITY_TYPES else "topic"


def _norm_scope(value: str) -> str:
    # Default to "general" when unset so pre-scope manifests still promote.
    return "local" if str(value or "").strip().lower() == "local" else "general"


def _norm_rel_type(value: str) -> str:
    candidate = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return candidate if candidate in RELATION_TYPES else "related_to"


def _humanize_rel(rel_type: str) -> str:
    return rel_type.replace("_", " ")


def _entity_id(entity_type: str, name: str) -> str:
    return f"{entity_type}--{slugify(name, fallback='entity')}"


class Curator:
    def __init__(self, workspace_root: Path):
        self._workspace = Path(workspace_root)
        self._wiki = self._workspace / "wiki"
        self._lexicon = self._wiki / ".lexicon"
        self._sources_dir = self._lexicon / "sources"
        self._entities_dir = self._wiki / "entities"
        self._indexes_dir = self._wiki / "indexes"

    # ── Public API ───────────────────────────────────────────────────────────

    def curate(self) -> dict:
        """Rebuild the canonical registry + entity pages from all manifests."""
        manifests = self._load_manifests()
        previous = self._load_registry()
        registry, relations = self._merge(manifests, previous)

        self._write_registry(registry)
        self._write_relations(relations)
        pages = self._write_entity_pages(registry, relations)
        self._write_entity_index(registry)

        flagged = sum(1 for e in registry.values() if e["flags"])
        enriched = sum(1 for e in registry.values() if (e.get("enrichment") or {}).get("description"))
        by_type: dict[str, int] = defaultdict(int)
        for entity in registry.values():
            by_type[entity["type"]] += 1
        return {
            "ok": True,
            "entities": len(registry),
            "relations": len(relations),
            "pages_written": pages,
            "flagged": flagged,
            "enriched": enriched,
            "by_type": dict(by_type),
        }

    def impact_of_source(self, source_id: str) -> dict:
        """What removing one source's manifest would do to the canonical layer.

        Pure and read-only: reruns the same deterministic ``_merge`` with and
        without that source's manifest and diffs the two results. No disk
        writes happen here — this only powers a delete confirmation prompt.
        """
        manifests = self._load_manifests()
        if not any(m.get("source_id") == source_id for m in manifests):
            return {"ok": True, "entities_removed": [], "entities_affected": [], "relations_removed": 0}

        without = [m for m in manifests if m.get("source_id") != source_id]
        before, before_relations = self._merge(manifests, {})
        after, after_relations = self._merge(without, {})

        removed = [e for eid, e in before.items() if eid not in after]
        affected = [
            e for eid, e in before.items()
            if eid in after and any(s.get("source_id") == source_id for s in e["sources"])
        ]
        before_pairs = {(r["from"], r["to"]) for r in before_relations}
        after_pairs = {(r["from"], r["to"]) for r in after_relations}

        def brief(entities):
            return sorted(
                ({"name": e["name"], "type": e["type"]} for e in entities),
                key=lambda e: e["name"].lower(),
            )

        return {
            "ok": True,
            "entities_removed": brief(removed),
            "entities_affected": brief(affected),
            "relations_removed": len(before_pairs - after_pairs),
        }

    def registry(self) -> dict:
        registry = self._load_registry()
        by_type: dict[str, int] = defaultdict(int)
        enriched = 0
        entities = []
        for entity in sorted(registry.values(), key=lambda e: (e["type"], e["name"].lower())):
            by_type[entity["type"]] += 1
            is_enriched = bool((entity.get("enrichment") or {}).get("description"))
            enriched += 1 if is_enriched else 0
            entities.append({
                "id": entity["id"],
                "name": entity["name"],
                "type": entity["type"],
                "aliases": entity.get("aliases", []),
                "page": entity.get("page", ""),
                "source_count": len(entity.get("sources", [])),
                "enriched": is_enriched,
                "flags": entity.get("flags", []),
            })
        return {
            "ok": True, "entities": entities, "by_type": dict(by_type),
            "total": len(entities), "enriched": enriched,
        }

    # ── Merge ────────────────────────────────────────────────────────────────

    def _merge(self, manifests: list[dict], previous: dict) -> tuple[dict, list[dict]]:
        registry: dict[str, dict] = {}
        slug_types: dict[str, set[str]] = defaultdict(set)

        # ── Pass 1: canonical entities (general scope only) ──────────────────
        for manifest in manifests:
            source_id = manifest.get("source_id", "")
            title = manifest.get("title", source_id)
            note_page = manifest.get("note_page", "")

            for candidate in manifest.get("entities", []):
                name = str(candidate.get("name", "")).strip()
                if not name or _norm_scope(candidate.get("scope")) != "general":
                    continue                       # local jargon never gets a page
                entity_type = _norm_type(candidate.get("type"))
                eid = _entity_id(entity_type, name)
                slug_types[slugify(name, fallback="entity")].add(entity_type)

                entity = registry.get(eid)
                if not entity:
                    entity = {
                        "id": eid,
                        "name": name,
                        "type": entity_type,
                        "aliases": set(),
                        "sources": {},          # source_id -> evidence record
                        "page": f"entities/{entity_type}/{slugify(name, fallback='entity')}.md",
                        "enrichment": (previous.get(eid, {}) or {}).get("enrichment", {}) or {},
                        "flags": [],
                    }
                    registry[eid] = entity

                for alias in candidate.get("aliases", []) or []:
                    alias = str(alias).strip()
                    if alias and slugify(alias) != slugify(name):
                        entity["aliases"].add(alias)

                entity["sources"].setdefault(source_id, {
                    "source_id": source_id,
                    "title": title,
                    "note_page": note_page,
                    "evidence": str(candidate.get("evidence", "")).strip(),
                })

        # Ambiguity: same normalized name across >1 type — keep separate, flag both.
        for entity in registry.values():
            if len(slug_types[slugify(entity["name"], fallback="entity")]) > 1:
                entity["flags"].append("ambiguous-type")

        # Name/alias → id lookup, so relations declared by name resolve to the
        # canonical entity (and relations touching un-promoted local terms drop).
        name_to_id: dict[str, str] = {}
        for entity in registry.values():
            name_to_id.setdefault(slugify(entity["name"], fallback="entity"), entity["id"])
            for alias in entity["aliases"]:
                name_to_id.setdefault(slugify(alias, fallback="entity"), entity["id"])

        # ── Pass 2: labeled relations (both endpoints must be general) ───────
        rel_map: dict[tuple[str, str, str], dict] = {}
        for manifest in manifests:
            source_id = manifest.get("source_id", "")
            for rel in manifest.get("relations", []):
                fid = name_to_id.get(slugify(str(rel.get("from", "")), fallback="entity"))
                tid = name_to_id.get(slugify(str(rel.get("to", "")), fallback="entity"))
                if not fid or not tid or fid == tid:
                    continue
                rtype = _norm_rel_type(rel.get("type"))
                key = (fid, tid, rtype)
                entry = rel_map.setdefault(
                    key, {"evidence": str(rel.get("evidence", "")).strip(), "sources": set()})
                entry["sources"].add(source_id)
                if not entry["evidence"] and rel.get("evidence"):
                    entry["evidence"] = str(rel["evidence"]).strip()

        # Freeze sets → sorted lists for stable, serializable output.
        for entity in registry.values():
            entity["aliases"] = sorted(entity["aliases"])
            entity["sources"] = list(entity["sources"].values())

        relations = [
            {"from": f, "to": t, "type": rtype,
             "evidence": entry["evidence"], "sources": sorted(entry["sources"])}
            for (f, t, rtype), entry in sorted(rel_map.items())
        ]
        return registry, relations

    # ── Entity pages ─────────────────────────────────────────────────────────

    def _write_entity_pages(self, registry: dict, relations: list[dict]) -> int:
        # Rebuild the entities/ tree from scratch so deleted entities don't linger.
        if self._entities_dir.exists():
            for path in self._entities_dir.rglob("*.md"):
                try:
                    path.unlink()
                except OSError:
                    pass

        by_id = {e["id"]: e for e in registry.values()}
        # Group relations by the entity on each end, keeping direction so the
        # page can phrase them naturally ("used for → X" vs "X → depends on").
        rels_out: dict[str, list[dict]] = defaultdict(list)
        rels_in: dict[str, list[dict]] = defaultdict(list)
        for rel in relations:
            if rel["from"] in by_id and rel["to"] in by_id:
                rels_out[rel["from"]].append(rel)
                rels_in[rel["to"]].append(rel)

        written = 0
        for entity in registry.values():
            page_path = self._wiki / entity["page"]
            page_path.parent.mkdir(parents=True, exist_ok=True)
            page_path.write_text(
                self._render_entity_page(entity, by_id, rels_out, rels_in), encoding="utf-8")
            written += 1
        return written

    def _render_entity_page(self, entity: dict, by_id: dict,
                            rels_out: dict, rels_in: dict) -> str:
        name = entity["name"]
        enrichment = entity.get("enrichment") or {}
        depth = entity["page"].count("/")          # entities/<type>/<slug>.md → 2
        up = "../" * depth
        lines = [f"# {name}", "", f"**Type:** {entity['type']}"]
        if entity["aliases"]:
            lines.append(f"**Also known as:** {', '.join(entity['aliases'])}")
        if "ambiguous-type" in entity["flags"]:
            lines.append("")
            lines.append("> ⚠ This name appears under more than one entity type across your "
                         "sources. Review whether these should stay separate.")

        # What it is — prefer the LLM's general-knowledge definition; fall back
        # to the strongest source snippet if this entity hasn't been enriched.
        lines += ["", "## What it is"]
        if enrichment.get("description"):
            lines.append(enrichment["description"].strip())
        else:
            evidence = [s["evidence"] for s in entity["sources"] if s.get("evidence")]
            lines.append(evidence[0] if evidence
                         else "_Not enriched yet — no general description available._")

        # Relationships — typed and directional, so "Pydantic used for data
        # validation" reads as a claim, not "these two share a document."
        rel_lines: list[str] = []
        for rel in rels_out.get(entity["id"], [])[:_RELATION_CAP]:
            target = by_id.get(rel["to"])
            if target:
                rel_lines.append(f"- **{_humanize_rel(rel['type'])}** → [[{target['name']}]]")
        for rel in rels_in.get(entity["id"], [])[:_RELATION_CAP]:
            source = by_id.get(rel["from"])
            if source:
                rel_lines.append(f"- [[{source['name']}]] **{_humanize_rel(rel['type'])}** this")
        if rel_lines:
            lines += ["", "## Relationships", *rel_lines]

        lines += ["", "## How it appears in imported sources"]
        for src in entity["sources"][:_EVIDENCE_CAP]:
            note = src.get("note_page", "")
            label = src.get("title") or src.get("source_id")
            link = f"[{label}]({up}{note})" if note else label
            snippet = f" — {src['evidence']}" if src.get("evidence") else ""
            lines.append(f"- {link}{snippet}")

        lines += ["", "## External context"]
        if enrichment.get("external_context"):
            lines.append("_General knowledge, not drawn from your sources:_")
            lines.append("")
            lines.append(enrichment["external_context"].strip())
        else:
            lines.append("_External context not yet added._")
        lines.append("")
        return "\n".join(lines)

    def _write_entity_index(self, registry: dict) -> None:
        self._indexes_dir.mkdir(parents=True, exist_ok=True)
        index_path = self._indexes_dir / "entities.md"
        if not registry:
            index_path.write_text(
                "# Entity Index\n\n_No entities yet. Import and index sources to populate this._\n",
                encoding="utf-8")
            return
        by_type: dict[str, list[dict]] = defaultdict(list)
        for entity in registry.values():
            by_type[entity["type"]].append(entity)
        lines = ["# Entity Index", "",
                 f"{len(registry)} entities across {len(by_type)} types.", ""]
        for entity_type in sorted(by_type):
            entities = sorted(by_type[entity_type], key=lambda e: e["name"].lower())
            lines.append(f"## {entity_type.capitalize()} ({len(entities)})")
            for entity in entities:
                count = len(entity["sources"])
                lines.append(f"- [[{entity['name']}]] — {count} source{'' if count == 1 else 's'}")
            lines.append("")
        index_path.write_text("\n".join(lines), encoding="utf-8")

    # ── Persistence ──────────────────────────────────────────────────────────

    def _load_manifests(self) -> list[dict]:
        if not self._sources_dir.is_dir():
            return []
        manifests = []
        for path in sorted(self._sources_dir.glob("*.json")):
            try:
                manifests.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return manifests

    def _load_registry(self) -> dict:
        path = self._lexicon / "entities.json"
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {e["id"]: e for e in data.get("entities", [])}
        except (OSError, json.JSONDecodeError, KeyError):
            return {}

    def _write_registry(self, registry: dict) -> None:
        self._lexicon.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "updated_at": _iso_now(),
            "entities": [registry[k] for k in sorted(registry)],
        }
        (self._lexicon / "entities.json").write_text(
            json.dumps(payload, indent=2), encoding="utf-8")

    def _write_relations(self, relations: list[dict]) -> None:
        self._lexicon.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "updated_at": _iso_now(), "relations": relations}
        (self._lexicon / "relations.json").write_text(
            json.dumps(payload, indent=2), encoding="utf-8")
