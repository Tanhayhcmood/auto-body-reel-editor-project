import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildAutoReelFilterGraph, buildAutoReelFfmpegArgs, buildAutoReelPlan, buildReelAss, NoSuitableAutoReelSegmentsError, renderAutoBodyReel } from "./reel-editor";
import type { SegmentAnalysis } from "./analysis-schema";
import type { ReelStoryboard } from "./reel-storyboard";

const execFileAsync = promisify(execFile);

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
  assert.match(graph, /boxblur=30:2/);
  assert.match(graph, /concat=n=1:v=1:a=1/);
  assert.match(graph, /atrim=start=0:end=10/);
  assert.ok(graph.includes("1080:1920:force_original_aspect_ratio=increase"));
  assert.ok(args.includes("[aout]"));
  assert.match(graph, /loudnorm=I=-16:TP=-1.5/);
});

test("omits audio processing for silent sources", () => {
  const plan = buildAutoReelPlan([segment()]);
  const args = buildAutoReelFfmpegArgs("source.mp4", "reel.mp4", plan, false);
  assert.match(buildAutoReelFilterGraph(plan, false), /concat=n=1:v=1:a=0/);
  assert.ok(args.includes("-an"));
  assert.ok(!args.includes("-c:a"));
});

test("builds Persian hook, moment overlays, and source-timed subtitles", () => {
  const editorial: ReelStoryboard = {
    hook: "قبل از ترمیم",
    cta: "برای دیدن نتیجه همراه باشید",
    instagramCaption: "ترمیم بدنه خودرو #خودرو",
    clips: [
      { segment_id: "before", start: 2, end: 5 },
      { segment_id: "finish", start: 20, end: 24 },
    ],
    overlays: [{ segment_id: "finish", text: "نتیجه نهایی" }],
    durationSeconds: 7,
  };
  const ass = buildReelAss(editorial, [
    { start: 3, end: 4, text: "این بخش پیش از تعمیر است" },
    { start: 21, end: 22, text: "پنل صاف و یک‌دست شد" },
  ]);

  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Style: Default,Noto Sans Arabic/);
  assert.match(ass, /قبل از ترمیم/);
  assert.match(ass, /نتیجه نهایی/);
  assert.match(ass, /Dialogue: 3,0:00:01\.00,0:00:02\.00,Default/);
  assert.match(ass, /Dialogue: 3,0:00:04\.00,0:00:05\.00,Default/);
});

test("renders the AI storyboard, subtitle track, and cover through the FFmpeg pipeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reel-render-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "reel.mp4");
  const seenArgs: string[][] = [];
  const editorial: ReelStoryboard = {
    hook: "شروع ترمیم",
    cta: "نتیجه را ببینید",
    instagramCaption: "ترمیم با دقت #بدنه",
    clips: [{ segment_id: "segment-001", start: 2, end: 6 }],
    overlays: [{ segment_id: "segment-001", text: "صاف‌کاری" }],
    durationSeconds: 4,
  };
  const result = await renderAutoBodyReel(
    "source.mp4",
    outputPath,
    [segment({ start: 0, end: 10 })],
    true,
    {
      provider: {
        name: "gemini",
        model: "gemini-test",
        generateText: async () => "",
        generateMultimodal: async () => "",
      },
      createStoryboard: async () => editorial,
      transcribeAudio: async (_input, _audio, sourceDuration) => {
        assert.equal(sourceDuration, 10);
        return [{ start: 3, end: 4, text: "ترمیم بدنه" }];
      },
      runFfmpeg: async (args) => {
        seenArgs.push(args);
        const destination = args[args.length - 1];
        assert.ok(destination);
        await writeFile(destination, Buffer.from("rendered"));
      },
    },
  );

  assert.equal(result.hook, "شروع ترمیم");
  assert.equal(result.transcriptSegmentCount, 1);
  assert.equal(seenArgs.length, 2);
  assert.match(seenArgs[0]?.[seenArgs[0]!.indexOf("-filter_complex") + 1] ?? "", /subtitles=filename/);
  assert.ok(result.coverPath.endsWith("-cover.jpg"));
  assert.ok((await readFile(result.coverPath)).length > 0);
  assert.ok(!(await readdir(directory)).some((entry) => entry.endsWith(".ass") || entry.endsWith(".audio.mp3")));
});

test("FFmpeg creates a portrait H.264 reel and a readable cover frame", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reel-ffmpeg-integration-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.mp4");
  const outputPath = join(directory, "edited.mp4");
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    sourcePath,
  ]);

  const provider = {
    name: "gemini",
    model: "test-model",
    generateText: async () => "",
    generateMultimodal: async () => "",
  };
  const storyboard: ReelStoryboard = {
    hook: "نتیجه ترمیم را ببینید",
    cta: "برای دیدن مراحل همراه باشید",
    instagramCaption: "ترمیم خودرو #بدنه",
    clips: [{ segment_id: "whole", start: 0, end: 2 }],
    overlays: [],
    durationSeconds: 2,
  };
  const result = await renderAutoBodyReel(
    sourcePath,
    outputPath,
    [segment({ segment_id: "whole", start: 0, end: 2 })],
    false,
    { provider, createStoryboard: async () => storyboard },
  );
  const probe = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height",
    "-of",
    "json",
    outputPath,
  ]);
  const stream = (
    JSON.parse(probe.stdout) as { streams: Array<{ codec_name: string; width: number; height: number }> }
  ).streams[0];

  assert.deepEqual(stream, { codec_name: "h264", width: 1080, height: 1920 });
  assert.ok((await readFile(result.coverPath)).length > 0);
  assert.equal(result.transcriptSegmentCount, 0);
});
