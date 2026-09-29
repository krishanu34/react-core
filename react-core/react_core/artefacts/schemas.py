"""Artefact schemas — plain dataclasses with `to_dict` / `from_dict`.

Kept schema-lite on purpose: nested lists of loosely-typed dicts (ambiguities,
risk_areas, entities, …) are LLM-produced JSON. Only fields the code operates
on (acceptance criteria, gherkin steps) get proper dataclasses.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from typing import Any, Optional


@dataclass(slots=True)
class AcceptanceCriterion:
    id: str
    statement: str
    testable: bool
    source_ref: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AcceptanceCriterion":
        return cls(
            id=str(d.get("id") or ""),
            statement=str(d.get("statement") or ""),
            testable=bool(d.get("testable", True)),
            source_ref=d.get("source_ref"),
        )


@dataclass(slots=True)
class Analysis:
    source_type: str = "mixed"
    summary_one_paragraph: str = ""
    acceptance_criteria: list[AcceptanceCriterion] = field(default_factory=list)
    ambiguities: list[dict] = field(default_factory=list)
    missing_NFRs: list[str] = field(default_factory=list)
    unstated_assumptions: list[str] = field(default_factory=list)
    testability_issues: list[str] = field(default_factory=list)
    risk_areas: list[dict] = field(default_factory=list)
    suggested_questions: list[str] = field(default_factory=list)
    state_hints: list[str] = field(default_factory=list)
    entity_hints: list[str] = field(default_factory=list)
    cause_effect_hints: list[str] = field(default_factory=list)
    edge_case_hints: list[str] = field(default_factory=list)
    gaps_significant: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["acceptance_criteria"] = [ac.to_dict() for ac in self.acceptance_criteria]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Analysis":
        acs = [
            AcceptanceCriterion.from_dict(ac) if not isinstance(ac, AcceptanceCriterion) else ac
            for ac in (d.get("acceptance_criteria") or [])
        ]
        return cls(
            source_type=str(d.get("source_type") or "mixed"),
            summary_one_paragraph=str(d.get("summary_one_paragraph") or ""),
            acceptance_criteria=acs,
            ambiguities=list(d.get("ambiguities") or []),
            missing_NFRs=list(d.get("missing_NFRs") or []),
            unstated_assumptions=list(d.get("unstated_assumptions") or []),
            testability_issues=list(d.get("testability_issues") or []),
            risk_areas=list(d.get("risk_areas") or []),
            suggested_questions=list(d.get("suggested_questions") or []),
            state_hints=list(d.get("state_hints") or []),
            entity_hints=list(d.get("entity_hints") or []),
            cause_effect_hints=list(d.get("cause_effect_hints") or []),
            edge_case_hints=list(d.get("edge_case_hints") or []),
            gaps_significant=bool(d.get("gaps_significant", False)),
        )


def derive_gaps_significant(analysis: dict[str, Any]) -> bool:
    """Belt-and-braces: re-derive `gaps_significant` from the fields.

    A run is gap-significant if ANY of:
    - no acceptance criteria at all
    - any missing NFR flagged
    - any ambiguity with impact == "high"
    """
    acs = analysis.get("acceptance_criteria") or []
    if not acs:
        return True
    if analysis.get("missing_NFRs"):
        return True
    for a in analysis.get("ambiguities") or []:
        if isinstance(a, dict) and str(a.get("impact") or "").lower() == "high":
            return True
    return False


@dataclass(slots=True)
class StateModel:
    states: list[dict] = field(default_factory=list)         # {id, name, entry_conditions?, exit_transitions?}
    transitions: list[dict] = field(default_factory=list)    # {from, to, event, guard?}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StateModel":
        return cls(
            states=list(d.get("states") or []),
            transitions=list(d.get("transitions") or []),
        )


@dataclass(slots=True)
class CauseEffectModel:
    causes: list[dict] = field(default_factory=list)         # {id, description}
    effects: list[dict] = field(default_factory=list)        # {id, description}
    relations: list[dict] = field(default_factory=list)      # {cause_ids: [...], effect_id, condition?}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CauseEffectModel":
        return cls(
            causes=list(d.get("causes") or []),
            effects=list(d.get("effects") or []),
            relations=list(d.get("relations") or []),
        )


@dataclass(slots=True)
class DataModel:
    entities: list[dict] = field(default_factory=list)       # {name, fields: [{name, type, constraints}]}
    relationships: list[dict] = field(default_factory=list)  # {from, to, kind: one_to_many | ...}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DataModel":
        return cls(
            entities=list(d.get("entities") or []),
            relationships=list(d.get("relationships") or []),
        )


@dataclass(slots=True)
class TestStrategy:
    approach: str = ""
    scope_in: list[str] = field(default_factory=list)
    scope_out: list[str] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)      # BVA | EP | decision-table | state-transition | cause-effect | risk-based | pairwise
    tooling: list[str] = field(default_factory=list)
    environments: list[str] = field(default_factory=list)
    coverage_targets: dict = field(default_factory=dict)
    risks: list[dict] = field(default_factory=list)          # {area, likelihood, impact, mitigation}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TestStrategy":
        return cls(
            approach=str(d.get("approach") or ""),
            scope_in=list(d.get("scope_in") or []),
            scope_out=list(d.get("scope_out") or []),
            techniques=list(d.get("techniques") or []),
            tooling=list(d.get("tooling") or []),
            environments=list(d.get("environments") or []),
            coverage_targets=dict(d.get("coverage_targets") or {}),
            risks=list(d.get("risks") or []),
        )


@dataclass(slots=True)
class Scenario:
    """Design-phase scenario (feeds `generate_gherkin`)."""
    id: str
    title: str
    feature: str = ""
    priority: str = "medium"                                  # critical | high | medium | low
    risk: Optional[str] = None
    technique_used: str = "risk-based"                        # BVA | EP | decision-table | state-transition | cause-effect | risk-based | pairwise
    acceptance_criteria_refs: list[str] = field(default_factory=list)
    model_refs: list[str] = field(default_factory=list)       # e.g. "state_model.json#PAID->REFUNDED"
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Scenario":
        return cls(
            id=str(d.get("id") or ""),
            title=str(d.get("title") or ""),
            feature=str(d.get("feature") or ""),
            priority=str(d.get("priority") or "medium"),
            risk=d.get("risk"),
            technique_used=str(d.get("technique_used") or "risk-based"),
            acceptance_criteria_refs=list(d.get("acceptance_criteria_refs") or []),
            model_refs=list(d.get("model_refs") or []),
            tags=list(d.get("tags") or []),
        )


@dataclass(slots=True)
class TestCaseStep:
    """One numbered step of a manual/functional test case."""
    action: str
    expected_result: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"action": self.action, "expected_result": self.expected_result}

    @classmethod
    def from_dict(cls, d: Any) -> "TestCaseStep":
        if isinstance(d, str):
            return cls(action=d.strip(), expected_result="")
        if not isinstance(d, dict):
            return cls(action=str(d or ""), expected_result="")
        action = str(d.get("action") or d.get("step") or d.get("text") or "").strip()
        expected = str(
            d.get("expected_result") or d.get("expected") or d.get("result") or ""
        ).strip()
        return cls(action=action, expected_result=expected)


@dataclass(slots=True)
class TestCase:
    """A functional / manual test case with numbered steps."""
    id: str
    title: str
    priority: str = "medium"                                  # critical | high | medium | low
    test_type: str = "functional"                             # functional | manual | negative | ...
    technique_used: str = "risk-based"
    preconditions: list[str] = field(default_factory=list)
    test_data: dict = field(default_factory=dict)
    steps: list[TestCaseStep] = field(default_factory=list)
    acceptance_criteria_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["steps"] = [s.to_dict() for s in self.steps]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TestCase":
        td = d.get("test_data")
        return cls(
            id=str(d.get("id") or ""),
            title=str(d.get("title") or d.get("name") or ""),
            priority=str(d.get("priority") or "medium").lower(),
            test_type=str(d.get("test_type") or d.get("type") or "functional").lower(),
            technique_used=str(d.get("technique_used") or d.get("technique") or "risk-based"),
            preconditions=[str(p) for p in (d.get("preconditions") or [])],
            test_data=td if isinstance(td, dict) else ({"values": td} if td else {}),
            steps=[TestCaseStep.from_dict(s) for s in (d.get("steps") or [])],
            acceptance_criteria_refs=list(
                d.get("acceptance_criteria_refs") or d.get("requirement_ids") or []
            ),
        )


@dataclass(slots=True)
class TestSuite:
    title: str
    description: Optional[str] = None
    test_cases: list[TestCase] = field(default_factory=list)
    coverage_summary: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "description": self.description,
            "test_cases": [tc.to_dict() for tc in self.test_cases],
            "coverage_summary": dict(self.coverage_summary),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TestSuite":
        return cls(
            title=str(d.get("title") or ""),
            description=d.get("description"),
            test_cases=[TestCase.from_dict(tc) for tc in (d.get("test_cases") or [])],
            coverage_summary=dict(d.get("coverage_summary") or {}),
        )


@dataclass(slots=True)
class TestResult:
    """One executed test's outcome (parsed from a runner's output)."""
    name: str
    status: str = "passed"                                    # passed | failed | skipped | error
    classname: str = ""
    duration: float = 0.0
    message: str = ""
    requirement_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TestResult":
        return cls(
            name=str(d.get("name") or ""),
            status=str(d.get("status") or "passed").lower(),
            classname=str(d.get("classname") or ""),
            duration=float(d.get("duration") or 0.0),
            message=str(d.get("message") or ""),
            requirement_refs=list(d.get("requirement_refs") or []),
        )


@dataclass(slots=True)
class TestReport:
    """Result of executing a test suite."""
    command: str
    framework: str = ""
    exit_code: int = 0
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    duration: float = 0.0
    results: list[TestResult] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["results"] = [r.to_dict() for r in self.results]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TestReport":
        return cls(
            command=str(d.get("command") or ""),
            framework=str(d.get("framework") or ""),
            exit_code=int(d.get("exit_code") or 0),
            total=int(d.get("total") or 0),
            passed=int(d.get("passed") or 0),
            failed=int(d.get("failed") or 0),
            skipped=int(d.get("skipped") or 0),
            errors=int(d.get("errors") or 0),
            duration=float(d.get("duration") or 0.0),
            results=[TestResult.from_dict(r) for r in (d.get("results") or [])],
            summary=str(d.get("summary") or ""),
        )


@dataclass(slots=True)
class GherkinStep:
    kind: str            # given | when | then | and | but
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "text": self.text}

    @classmethod
    def from_dict(cls, d: Any) -> "GherkinStep":
        """Accept either a `{kind, text}` dict OR a raw string like
        `"Given a precondition"`. LLMs frequently produce the string form.
        """
        if isinstance(d, str):
            return _parse_step_string(d)
        if not isinstance(d, dict):
            return cls(kind="given", text=str(d or ""))
        # Dict form: kind may still be omitted if it's baked into `text`.
        kind_raw = d.get("kind")
        text_raw = str(d.get("text") or "").strip()
        if not kind_raw and text_raw:
            return _parse_step_string(text_raw)
        return cls(kind=str(kind_raw or "given").lower(), text=text_raw)


_GHERKIN_KEYWORDS = ("given", "when", "then", "and", "but", "*")


def _parse_step_string(line: str) -> GherkinStep:
    stripped = str(line or "").strip()
    if not stripped:
        return GherkinStep(kind="given", text="")
    lower_first = stripped.split(None, 1)
    first = lower_first[0].lower().rstrip(":")
    if first in _GHERKIN_KEYWORDS:
        rest = lower_first[1] if len(lower_first) > 1 else ""
        return GherkinStep(kind=("and" if first == "*" else first), text=rest.strip())
    return GherkinStep(kind="given", text=stripped)


@dataclass(slots=True)
class GherkinScenario:
    id: str
    name: str
    tags: list[str] = field(default_factory=list)
    background: Optional[list[GherkinStep]] = None
    steps: list[GherkinStep] = field(default_factory=list)
    acceptance_criteria_refs: list[str] = field(default_factory=list)
    examples: Optional[list[dict]] = None   # for Scenario Outlines

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "tags": list(self.tags),
            "steps": [s.to_dict() for s in self.steps],
            "acceptance_criteria_refs": list(self.acceptance_criteria_refs),
        }
        if self.background is not None:
            d["background"] = [s.to_dict() for s in self.background]
        if self.examples is not None:
            d["examples"] = list(self.examples)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GherkinScenario":
        bg_raw = d.get("background")
        bg = [GherkinStep.from_dict(s) for s in bg_raw] if bg_raw else None
        return cls(
            id=str(d.get("id") or ""),
            name=str(d.get("name") or ""),
            tags=list(d.get("tags") or []),
            background=bg,
            steps=[GherkinStep.from_dict(s) for s in d.get("steps") or []],
            acceptance_criteria_refs=list(d.get("acceptance_criteria_refs") or []),
            examples=list(d.get("examples")) if d.get("examples") else None,
        )


@dataclass(slots=True)
class GherkinFeature:
    feature: str
    description: Optional[str] = None
    scenarios: list[GherkinScenario] = field(default_factory=list)
    coverage_summary: dict = field(default_factory=dict)    # {ac_total, ac_covered, uncovered: [...], scenarios: N, techniques_used: [...]}

    def to_dict(self) -> dict[str, Any]:
        return {
            "feature": self.feature,
            "description": self.description,
            "scenarios": [s.to_dict() for s in self.scenarios],
            "coverage_summary": dict(self.coverage_summary),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GherkinFeature":
        return cls(
            feature=str(d.get("feature") or ""),
            description=d.get("description"),
            scenarios=[GherkinScenario.from_dict(s) for s in d.get("scenarios") or []],
            coverage_summary=dict(d.get("coverage_summary") or {}),
        )
