import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildSegmentRanges,
  createVideoSegments,
  getFrameCounts,
  getRepresentativeFrameTimestamps,
  MAX_REPRESENTATIVE_FRAMES,
  MAX_SEGMENTS,
  parseSceneChangeTimestamps,
} from "./segmentation";

const execFileAsync = promisify(execFile);

test("combines scene-change and evenly spaced time boundaries", () => {
  const ranges = buildSegmentRanges(32, [4, 8, 12, 16, 20, 24, 28]);
  const boundaries = new Set(ranges.flatMap((range) => [range.start, range.end]));

  assert.ok(ranges.length <= MAX_SEGMENTS);
  for (const boundary of [4, 8, 12, 16, 20, 24, 28]) {
    assert.ok(boundaries.has(boundary), `expected boundary at ${boundary}s`);
  }
  assert.equal(ranges[0]?.start, 0);
  assert.equal(ranges.at(-1)?.end, 32);
});

test("ignores out-of-video scene timestamps and preserves segment timestamps", () => {
  const ranges = buildSegmentRanges(10, [-1, 0, 0.2, 2, 9.7, 10, 11, Number.NaN]);

  assert.deepEqual(
    ranges.map(({ start, end }) => [start, end]),
    [
      [0, 2],
      [2, 5],
      [5, 10],
    ],
  );
  for (const range of ranges) {
    assert.equal(Number((range.end - range.start).toFixed(4)), range.duration);
    assert.ok(range.start >= 0);
    assert.ok(range.end <= 10);
  }
});

test("keeps each segment at 2-4 frames and caps the total at 48", () => {
  const sceneChanges = Array.from({ length: 100 }, (_, index) => index * 1.5 + 1);
  const ranges = buildSegmentRanges(180, sceneChanges);
  const frameCounts = getFrameCounts(ranges);

  assert.ok(ranges.length <= MAX_SEGMENTS);
  assert.ok(frameCounts.every((count) => count >= 2 && count <= 4));
  assert.ok(frameCounts.reduce((total, count) => total + count, 0) <= MAX_REPRESENTATIVE_FRAMES);

  for (const [index, range] of ranges.entries()) {
    const timestamps = getRepresentativeFrameTimestamps(
      range.start,
      range.end,
      frameCounts[index]!,
    );
    assert.equal(timestamps.length, frameCounts[index]);
    assert.ok(timestamps.every((timestamp) => timestamp >= range.start && timestamp < range.end));
  }
});

test("extracts scene timestamps from FFmpeg showinfo output", () => {
  assert.deepEqual(
    parseSceneChangeTimestamps(
      "[Parsed_showinfo_1] n: 0 pts_time:0.520\n[Parsed_showinfo_1] n: 1 pts_time:4.125\n",
    ),
    [0.52, 4.125],
  );
});

test("detects real scene cuts and extracts representative frames with FFmpeg", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "video-segmentation-"));
  const videoPath = join(testDirectory, "scene-cuts.mp4");
  const framesDirectory = join(testDirectory, "frames");
  context.after(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:r=10:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=160x90:r=10:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=10:d=2",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "mpeg4",
    "-q:v",
    "5",
    videoPath,
  ]);

  const { sceneChanges, segments } = await createVideoSegments(
    videoPath,
    6,
    framesDirectory,
  );
  const frameCount = segments.reduce(
    (total, segment) => total + segment.representative_frames.length,
    0,
  );

  assert.ok(sceneChanges.some((timestamp) => Math.abs(timestamp - 2) < 0.2));
  assert.ok(sceneChanges.some((timestamp) => Math.abs(timestamp - 4) < 0.2));
  assert.ok(segments.length >= 3);
  assert.ok(frameCount <= MAX_REPRESENTATIVE_FRAMES);

  for (const segment of segments) {
    assert.ok(segment.representative_frames.length >= 2);
    assert.ok(segment.representative_frames.length <= 4);
    for (const frame of segment.representative_frames) {
      const bytes = await readFile(frame.path);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.ok(frame.timestamp >= segment.start && frame.timestamp < segment.end);
    }
  }
});