import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ReelEditPlan } from "./reel-edit-plan";
import { renderReel } from "./reel-renderer";

const execFileAsync = promisify(execFile);

test("renders selected footage as a portrait MP4 with Persian captions and source audio", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "video-reel-render-"));
  const sourcePath = join(testDirectory, "source.mp4");
  const outputPath = join(testDirectory, "rendered.mp4");
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
    "testsrc=size=320x180:rate=15:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    sourcePath,
  ]);

  const plan: ReelEditPlan = {
    story_arc: "از آسیب تا نتیجهٔ پرداخت‌شده.",
    hook_text: "تغییر را ببینید",
    hook_duration_seconds: 1.5,
    clips: [
      {
        segment_id: "segment-001",
        source_start_seconds: 0.5,
        source_end_seconds: 2.5,
        order: 1,
        selection_reason: "نمای نزدیک برای شروع داستان.",
        caption_text: "پرداخت بدنه",
        caption_start_seconds: 0.2,
        caption_end_seconds: 1.8,
        reframe_x: 0.7,
        reframe_y: 0.5,
      },
    ],
  };

  const result = await renderReel(sourcePath, plan, outputPath, true);

  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.fileSizeBytes > 0, true);
  assert.ok(result.durationSeconds >= 1.9 && result.durationSeconds <= 2.2);
});