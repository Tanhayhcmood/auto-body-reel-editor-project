import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoReelFilterGraph, buildAutoReelFfmpegArgs, buildAutoReelPlan, NoSuitableAutoReelSegmentsError } from "./reel-editor";
import type { SegmentAnalysis } from "./analysis-schema";

function segment(overrides: Partial<SegmentAnalysis> = {}): SegmentAnalysis {
  return { segment_id: "segment-001", start: 0, end: 10, summary: "Visible repair work.",
    visual_events: ["A person inspects a panel."], labels: ["repair_process"], quality_score: 0.9,
    interest_score: 0.8, repair_relevance: 0.95, transformation_value: 0.7, ...overrides };
}

test("chooses high-scoring repair moments and returns them chronologically", () => {
  const plan = buildAutoReelPlan([
    segment({ segment_id: "opening", start: 0, end: 10, repair_relevance: 0.55, quality_score: 0.5, interest_score: 0.4, transformation_value: 0.1 }),
    segment({ segment_id: "repair", start: 10, end: 25, repair_relevance: 0.98, quality_score: 0.9, interest_score: 0.9, transformation_value: 0.8 }),
    segment({ segment_id: "finish", start: 25, end: 40, repair_relevance: 0.9, quality_score: 0.8, interest_score: 0.75, transformation_value: 0.7 }),
    segment({ segment_id: "noise", start: 40, end: 50, labels: ["uninteresting"] }),
  ]);
  assert.deepEqual(plan.clips.map((clip) => clip.segment_id), ["repair", "finish"]);
  assert.equal(plan.durationSeconds, 30);
  assert.deepEqual(plan.clips.map((clip) => [clip.start, clip.end]), [[10, 25], [25, 40]]);
});

test("trims the final clip to the duration cap", () => {
  const plan = buildAutoReelPlan([segment({ end: 45 })], 20);
  assert.equal(plan.durationSeconds, 20);
  assert.equal(plan.clips[0]?.end, 20);
});

test("refuses to create a reel without a clear repair-relevant segment", () => {
  assert.throws(() => buildAutoReelPlan([segment({ repair_relevance: 0.2 })]), NoSuitableAutoReelSegmentsError);
});

test("builds vertical blurred-fill and source-audio filters", () => {
  const plan = buildAutoReelPlan([segment()]);
  const graph = buildAutoReelFilterGraph(plan, true);
  const args = buildAutoReelFfmpegArgs("source.mp4", "reel.mp4", plan, true);
  assert.match(graph, /boxblur=20:1/);
  assert.match(graph, /concat=n=1:v=1:a=1/);
  assert.match(graph, /atrim=start=0:end=10/);
  assert.ok(graph.includes("720:1280:force_original_aspect_ratio=increase"));
  assert.ok(args.includes("[aout]"));
});

test("omits audio processing for silent sources", () => {
  const plan = buildAutoReelPlan([segment()]);
  const args = buildAutoReelFfmpegArgs("source.mp4", "reel.mp4", plan, false);
  assert.match(buildAutoReelFilterGraph(plan, false), /concat=n=1:v=1:a=0/);
  assert.ok(args.includes("-an"));
  assert.ok(!args.includes("-c:a"));
});
