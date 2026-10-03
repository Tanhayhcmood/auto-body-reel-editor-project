import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidAIResponseError,
  validateGeminiAnalysis,
} from "./analysis-schema";
import type { VideoSegment } from "./segmentation";

const expectedSegment: VideoSegment = {
  segment_id: "segment-001",
  start: 0,
  end: 4,
  duration: 4,
  representative_frames: [
    { timestamp: 1.3333, path: "/tmp/frame-1.jpg" },
    { timestamp: 2.6667, path: "/tmp/frame-2.jpg" },
  ],
};

function validResponse() {
  return {
    segments: [
      {
        segment_id: "segment-001",
        start: 0,
        end: 4,
        summary: "A close view of a car door with a visible shallow dent.",
        visual_events: ["The camera remains close to the damaged door panel."],
        labels: ["damaged_area", "close_up_detail"],
        quality_score: 0.9,
        interest_score: 0.7,
        repair_relevance: 0.8,
        transformation_value: 0.1,
      },
    ],
  };
}

test("validates a correctly shaped Gemini analysis and exact segment mapping", () => {
  const parsed = validateGeminiAnalysis(
    JSON.stringify(validResponse()),
    [expectedSegment],
    4,
  );

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.segment_id, expectedSegment.segment_id);
  assert.equal(parsed[0]?.start, expectedSegment.start);
  assert.equal(parsed[0]?.end, expectedSegment.end);
  assert.deepEqual(parsed[0]?.labels, ["damaged_area", "close_up_detail"]);
});

test("rejects invalid JSON, missing segments, and scores outside 0-1", () => {
  assert.throws(
    () => validateGeminiAnalysis("not JSON", [expectedSegment], 4),
    InvalidAIResponseError,
  );
  assert.throws(
    () => validateGeminiAnalysis('{"segments":[]}', [expectedSegment], 4),
    InvalidAIResponseError,
  );

  const outOfRange = validResponse();
  outOfRange.segments[0]!.quality_score = 1.01;
  assert.throws(
    () => validateGeminiAnalysis(JSON.stringify(outOfRange), [expectedSegment], 4),
    InvalidAIResponseError,
  );
});

test("rejects unknown labels, extra fields, and timestamps outside the source segment", () => {
  const unknownLabel = validResponse();
  unknownLabel.segments[0]!.labels = ["imagined_repair"];
  assert.throws(
    () => validateGeminiAnalysis(JSON.stringify(unknownLabel), [expectedSegment], 4),
    InvalidAIResponseError,
  );

  const extraField = validResponse() as ReturnType<typeof validResponse> & {
    debug: string;
  };
  extraField.debug = "unexpected";
  assert.throws(
    () => validateGeminiAnalysis(JSON.stringify(extraField), [expectedSegment], 4),
    InvalidAIResponseError,
  );

  const badTimestamp = validResponse();
  badTimestamp.segments[0]!.end = 5;
  assert.throws(
    () => validateGeminiAnalysis(JSON.stringify(badTimestamp), [expectedSegment], 4),
    InvalidAIResponseError,
  );
});