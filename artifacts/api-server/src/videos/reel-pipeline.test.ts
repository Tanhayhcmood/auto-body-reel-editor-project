import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { AIProvider } from "../ai/provider";
import type { ReelEditPlan } from "./reel-edit-plan";
import { processUploadedVideoToReel } from "./reel-pipeline";

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";
const REEL_ID = "22222222-2222-4222-8222-222222222222";

test("orchestrates existing Gemini segment analysis, edit planning, rendering, and artifact links", async (context) => {
  const testDirectory = await mkdtemp(join(tmpdir(), "video-reel-pipeline-"));
  const videoPath = join(testDirectory, "source.mp4");
  const artifactsDirectory = join(testDirectory, "artifacts");
  await writeFile(videoPath, "test video placeholder");
  context.after(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  const plan: ReelEditPlan = {
    story_arc: "از آسیب قابل‌مشاهده تا سطح ترمیم‌شده.",
    hook_text: "تغییر را ببینید",
    hook_duration_seconds: 1,
    clips: [
      {
        segment_id: "segment-001",
        source_start_seconds: 0.5,
        source_end_seconds: 2.5,
        order: 1,
        selection_reason: "آسیب قابل‌مشاهده در نما روشن است.",
        caption_text: "ترمیم سطح بدنه",
        caption_start_seconds: 0.2,
        caption_end_seconds: 1.8,
        reframe_x: 0.5,
        reframe_y: 0.5,
      },
    ],
  };

  let multimodalCalls = 0;
  let jsonCalls = 0;
  const provider: AIProvider = {
    name: "gemini",
    model: "gemini-2.5-flash",
    async generateText() {
      throw new Error("This pipeline must use structured Gemini output.");
    },
    async generateMultimodal(_prompt, images) {
      multimodalCalls += 1;
      assert.equal(images.length, 2);
      return JSON.stringify({
        segments: [
          {
            segment_id: "segment-001",
            start: 0,
            end: 4,
            summary: "A close view of a visible vehicle panel.",
            visual_events: ["The panel remains in close view."],
            labels: ["damaged_area"],
            quality_score: 0.9,
            interest_score: 0.8,
            repair_relevance: 1,
            transformation_value: 0.3,
          },
        ],
      });
    },
    async generateJson(prompt) {
      jsonCalls += 1;
      assert.match(prompt, /visible vehicle panel/);
      return JSON.stringify(plan);
    },
  };

  const segmenter = async (
    _path: string,
    _duration: number,
    framesDirectory: string,
  ) => {
    await mkdir(framesDirectory, { recursive: true });
    const firstFrame = join(framesDirectory, "frame-01.jpg");
    const secondFrame = join(framesDirectory, "frame-02.jpg");
    await Promise.all([
      writeFile(firstFrame, Buffer.from([0xff, 0xd8, 0xff])),
      writeFile(secondFrame, Buffer.from([0xff, 0xd8, 0xff])),
    ]);
    return {
      sceneChanges: [2],
      segments: [
        {
          segment_id: "segment-001",
          start: 0,
          end: 4,
          duration: 4,
          representative_frames: [
            { timestamp: 1, path: firstFrame },
            { timestamp: 3, path: secondFrame },
          ],
        },
      ],
    };
  };

  const renderer = async (
    _path: string,
    receivedPlan: ReelEditPlan,
    outputPath: string,
    hasAudio: boolean,
  ) => {
    assert.deepEqual(receivedPlan, plan);
    assert.equal(hasAudio, true);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from("rendered mp4"));
    return {
      width: 1080,
      height: 1920,
      durationSeconds: 2,
      fileSizeBytes: 12,
    };
  };

  const result = await processUploadedVideoToReel(VIDEO_ID, videoPath, {
    provider,
    artifactsDirectory,
    metadataExtractor: async () => ({
      durationSeconds: 4,
      width: 320,
      height: 180,
      fps: 30,
      hasAudio: true,
    }),
    segmenter,
    renderer,
    reelIdFactory: () => REEL_ID,
  });

  assert.equal(multimodalCalls, 1);
  assert.equal(jsonCalls, 1);
  assert.equal(result.output.download_url, `/api/videos/${VIDEO_ID}/reels/${REEL_ID}/download`);
  assert.equal(result.output.width, 1080);
  assert.equal(result.output.height, 1920);
  assert.equal(
    JSON.parse(
      await readFile(resolve(process.cwd(), result.output.artifacts.edit_plan_json), "utf8"),
    ).hook_text,
    plan.hook_text,
  );
});