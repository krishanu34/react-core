"""Structured artefact layer.

Every deliverable produced by the QA agent has two representations:
- **logical**: a JSON file matching a schema in `schemas.py`
- **presentation**: a Markdown file for human review

Downstream Tier-2 exporters (CSV / XLSX / TestRail / Xray) will consume the
JSON side. The writer helper guarantees both files ship together and get
recorded in the App DB.
"""
from .schemas import (
    AcceptanceCriterion,
    Analysis,
    CauseEffectModel,
    DataModel,
    GherkinFeature,
    GherkinScenario,
    GherkinStep,
    Scenario,
    StateModel,
    TestStrategy,
    derive_gaps_significant,
)
from .writer import write_artefact

__all__ = [
    "AcceptanceCriterion",
    "Analysis",
    "CauseEffectModel",
    "DataModel",
    "GherkinFeature",
    "GherkinScenario",
    "GherkinStep",
    "Scenario",
    "StateModel",
    "TestStrategy",
    "derive_gaps_significant",
    "write_artefact",
]
