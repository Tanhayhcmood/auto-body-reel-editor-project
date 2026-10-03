import assert from "node:assert/strict";
import test from "node:test";
import type { SegmentAnalysis } from "./analysis-schema";
import { validateReelEditPlan } from "./reel-edit-plan";

const segments: SegmentAnalysis[] = [
  {
    segment_id: "segment-001",
    start: 0,
    end: 5,
    summary: "A close view of a damaged panel.",
    visual_events: ["The damaged panel is visible."],
    labels: ["damaged_area"],
    quality_score: 0.9,
    interest_score: 0.8,
    repair_relevance: 1,
    transformation_value: 0.2,
  },
  {
    segment_id: "segment-002",
    start: 5,
    end: 10,
    summary: "The repaired panel is polished.",
    visual_events: ["A hand polishes the panel."],
    labels: ["polishing", "repair_process"],
    quality_score: 0.9,
    interest_score: 0.85,
    repair_relevance: 1,
    transformation_value: 0.7,
  },
];

function validPlan() {
  return {
    story_arc: "از آسیب پنل تا پرداخت نهایی.",
    hook_text: "نتیجه را ببینید",
    hook_duration_seconds: 2,
    clips: [
      {
        segment_id: "segment-002",
        source_start_seconds: 5.5,
        source_end_seconds: 8,
        order: 2,
        selection_reason: "نمایش پرداخت قابل‌مشاهده.",
        caption_text: "پرداخت نهایی پنل",
        caption_start_seconds: 0.2,
        caption_end_seconds: 2,
        reframe_x: 0.65,
        reframe_y: 0.5,
      },
      {
        segment_id: "segment-001",
        source_start_seconds: 0.5,
        source_end_seconds: 2.5,
        order: 1,
        selection_reason: "نمای نزدیک و روشن از آسیب.",
        caption_text: "آسیب اولیه",
        caption_start_seconds: 0.1,
        caption_end_seconds: 1.8,
        reframe_x: 0.5,
        reframe_y: 0.45,
      },
    ],
  };
}

test("validates and orders a Gemini-selected Persian Reel plan", () => {
  const plan = validateReelEditPlan(JSON.stringify(validPlan()), segments, 10);

  assert.equal(plan.clips[0]?.segment_id, "segment-001");
  assert.equal(plan.clips[1]?.segment_id, "segment-002");
  assert.equal(plan.hook_text, "نتیجه را ببینید");
});

test("rejects clip timestamps outside the analyzed source segment", () => {
  const plan = validPlan();
  plan.clips[1]!.source_end_seconds = 5.5;

  assert.throws(
    () => validateReelEditPlan(JSON.stringify(plan), segments, 10),
    /invalid source timestamps/,
  );
});

test("rejects caption timing beyond its selected clip", () => {
  const plan = validPlan();
  plan.clips[1]!.caption_end_seconds = 3;

  assert.throws(
    () => validateReelEditPlan(JSON.stringify(plan), segments, 10),
    /invalid caption timestamps/,
  );
});

test("rejects non-Persian hook text instead of falling back to a template", () => {
  const plan = validPlan();
  plan.hook_text = "See the final result";

  assert.throws(
    () => validateReelEditPlan(JSON.stringify(plan), segments, 10),
    /must be written in Persian/,
  );
});