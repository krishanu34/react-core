"use client";

import { useState, useCallback } from "react";
import { MessageSquare, Loader2, ChevronDown, ChevronRight, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  refineArtifact,
  type RefineRequest,
  type RefineResponse,
} from "@/lib/api";

interface RefinementPanelProps {
  /** Database ID of the artifact to refine */
  artifactId: number;
  /** Display label (e.g. "S-001 · My story title") */
  artifactLabel: string;
  /** Artifact type for display */
  artifactType: "story" | "feature" | "epic";
  /** Whether the artifact is currently approved (locked) */
  isApproved?: boolean;
  /** Called after a successful refinement */
  onRefined?: (result: RefineResponse) => void;
  /** Called when the panel is closed */
  onClose?: () => void;
}

const QUALITY_OPTIONS = [
  { value: "BASIC", label: "Basic", desc: "Quick, minimal context" },
  { value: "STANDARD", label: "Standard", desc: "Balanced quality" },
  { value: "DETAILED", label: "Detailed", desc: "Deep analysis, slower" },
] as const;

const STORY_FIELDS = [
  "title", "description", "business_rules", "acceptance_criteria",
  "technical_changes", "implementation_notes", "story_points",
];
const FEATURE_FIELDS = ["feature_name", "feature_description", "stories"];
const EPIC_FIELDS = ["epic_name", "epic_goal", "features"];

export function RefinementPanel({
  artifactId,
  artifactLabel,
  artifactType,
  isApproved,
  onRefined,
  onClose,
}: RefinementPanelProps) {
  const [feedback, setFeedback] = useState("");
  const [quality, setQuality] = useState<"BASIC" | "STANDARD" | "DETAILED">("STANDARD");
  const [preserveFields, setPreserveFields] = useState<string[]>([]);
  const [regenerateFields, setRegenerateFields] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RefineResponse | null>(null);

  const fields = artifactType === "story" ? STORY_FIELDS
    : artifactType === "feature" ? FEATURE_FIELDS
    : EPIC_FIELDS;

  const toggleField = useCallback((field: string, list: "preserve" | "regenerate") => {
    if (list === "preserve") {
      setPreserveFields((prev) =>
        prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
      );
      // Remove from regenerate if present
      setRegenerateFields((prev) => prev.filter((f) => f !== field));
    } else {
      setRegenerateFields((prev) =>
        prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
      );
      setPreserveFields((prev) => prev.filter((f) => f !== field));
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!feedback.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const body: RefineRequest = {
        user_feedback: feedback.trim(),
        preserve_fields: preserveFields,
        regenerate_fields: regenerateFields,
        quality_level: quality,
      };
      const res = await refineArtifact(artifactId, body);
      setResult(res);
      onRefined?.(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refinement failed");
    } finally {
      setLoading(false);
    }
  }, [feedback, preserveFields, regenerateFields, quality, artifactId, onRefined]);

  if (isApproved) {
    return (
      <Card className="border-amber-800/50 bg-amber-950/10">
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-amber-400 text-sm">
            <Badge variant="warning">Approved</Badge>
            <span>This {artifactType} is approved and locked. Unapprove to enable refinement.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-sky-800/40 bg-sky-950/10">
      <CardContent className="py-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-sky-400" />
            <span className="font-medium text-slate-200">Refine {artifactType}</span>
            <span className="text-slate-500">{artifactLabel}</span>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Feedback textarea */}
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={`Describe what you want to change about this ${artifactType}…`}
          className="w-full rounded-lg border border-slate-700 bg-slate-900/60 text-slate-200 text-sm px-3 py-2.5 min-h-[80px] resize-y placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-600"
          disabled={loading}
        />

        {/* Quality level */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Quality:</span>
          {QUALITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setQuality(opt.value)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                quality === opt.value
                  ? "bg-sky-900/60 text-sky-300 font-medium"
                  : "bg-slate-800 text-slate-400 hover:text-slate-300"
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Advanced: field-level preserve/regenerate */}
        <div>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
          >
            {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced: field-level control
          </button>

          {showAdvanced && (
            <div className="mt-2 space-y-2 pl-4">
              <p className="text-xs text-slate-600">Click a field name to toggle preserve (green) or regenerate (orange):</p>
              <div className="flex flex-wrap gap-1.5">
                {fields.map((f) => {
                  const isPres = preserveFields.includes(f);
                  const isRegen = regenerateFields.includes(f);
                  return (
                    <button
                      key={f}
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        isPres
                          ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                          : isRegen
                            ? "border-orange-700 bg-orange-900/40 text-orange-300"
                            : "border-slate-700 bg-slate-800/40 text-slate-400 hover:border-slate-600"
                      }`}
                      onClick={() => {
                        if (isPres) {
                          // preserve → regenerate
                          toggleField(f, "regenerate");
                        } else if (isRegen) {
                          // regenerate → neutral
                          setRegenerateFields((prev) => prev.filter((x) => x !== f));
                        } else {
                          // neutral → preserve
                          toggleField(f, "preserve");
                        }
                      }}
                      title={isPres ? "Preserved (keep unchanged)" : isRegen ? "Regenerate (replace)" : "Click to preserve"}
                    >
                      {isPres && "🟢 "}{isRegen && "🟠 "}{f.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-600">🟢 = preserve, 🟠 = regenerate, no color = auto</p>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="text-sm text-red-400 bg-red-950/30 border border-red-800 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Success result */}
        {result && result.success && (
          <div className="text-sm bg-emerald-950/30 border border-emerald-800 rounded px-3 py-2 space-y-1">
            <p className="text-emerald-400 font-medium">{result.message}</p>
            {result.quality_score_before != null && result.quality_score_after != null && (
              <p className="text-xs text-slate-400">
                Quality: {result.quality_score_before.toFixed(2)} → {result.quality_score_after.toFixed(2)}
              </p>
            )}
          </div>
        )}

        {/* Submit button */}
        <div className="flex justify-end">
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={loading || !feedback.trim()}
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Refining…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5 mr-1" />
                Refine
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
