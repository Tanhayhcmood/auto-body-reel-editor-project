import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SegmentAnalysis } from "./analysis-schema";

const execFileAsync = promisify(execFile);
export const MAX_AUTO_REEL_DURATION_SECONDS = 30;
const MIN_REPAIR_RELEVANCE = 0.35;
const MIN_QUALITY_SCORE = 0.25;
const EXCLUDED_LABELS = new Set(["blurry", "repetitive", "uninteresting"]);

export interface ReelClip {
  segment_id: string;
  start: number;
  end: number;
}

export interface AutoReelPlan {
  clips: ReelClip[];
  durationSeconds: number;
}

export interface AutoReelRenderOptions {
  runFfmpeg?: (args: string[]) => Promise<void>;
}

export class NoSuitableAutoReelSegmentsError extends Error {
  constructor() {
    super("No clear, repair-relevant video segments were found for an auto reel.");
    this.name = "NoSuitableAutoReelSegmentsError";
  }
}

export class AutoReelRenderError extends Error {
  constructor(message = "FFmpeg could not create the edited reel.") {
    super(message);
    this.name = "AutoReelRenderError";
  }
}

function segmentScore(segment: SegmentAnalysis): number {
  return segment.repair_relevance * 0.55 + segment.quality_score * 0.2 +
    segment.interest_score * 0.15 + segment.transformation_value * 0.1;
}

export function buildAutoReelPlan(
  segments: SegmentAnalysis[],
  maxDurationSeconds = MAX_AUTO_REEL_DURATION_SECONDS,
): AutoReelPlan {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new Error("Auto reel duration must be a positive finite number.");
  }
  const candidates = segments
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) &&
      segment.start >= 0 && segment.end - segment.start >= 1 &&
      segment.repair_relevance >= MIN_REPAIR_RELEVANCE &&
      segment.quality_score >= MIN_QUALITY_SCORE &&
      !segment.labels.some((label) => EXCLUDED_LABELS.has(label)))
    .map((segment) => ({ segment, score: segmentScore(segment) }))
    .sort((left, right) => right.score - left.score || left.segment.start - right.segment.start);

  const clips: ReelClip[] = [];
  let remainingSeconds = maxDurationSeconds;
  for (const { segment } of candidates) {
    if (remainingSeconds < 1) break;
    const end = Number((segment.start + Math.min(segment.end - segment.start, remainingSeconds)).toFixed(4));
    if (end - segment.start < 1) continue;
    clips.push({ segment_id: segment.segment_id, start: segment.start, end });
    remainingSeconds -= end - segment.start;
  }
  if (clips.length === 0) throw new NoSuitableAutoReelSegmentsError();
  clips.sort((left, right) => left.start - right.start);
  return {
    clips,
    durationSeconds: Number(clips.reduce((sum, clip) => sum + clip.end - clip.start, 0).toFixed(4)),
  };
}

function timestamp(seconds: number): string {
  return Number(seconds.toFixed(4)).toString();
}

export function buildAutoReelFilterGraph(plan: AutoReelPlan, hasAudio: boolean): string {
  if (plan.clips.length === 0) throw new NoSuitableAutoReelSegmentsError();
  const filters: string[] = [];
  const concatInputs: string[] = [];
  const videoSources = plan.clips.map((_, index) => "[vsource" + index + "]");
  if (plan.clips.length > 1) {
    filters.push("[0:v]split=" + plan.clips.length + videoSources.join(""));
  } else {
    videoSources[0] = "[0:v]";
  }
  const audioSources = hasAudio ? plan.clips.map((_, index) => "[asource" + index + "]") : [];
  if (hasAudio && plan.clips.length > 1) {
    filters.push("[0:a]asplit=" + plan.clips.length + audioSources.join(""));
  } else if (hasAudio) {
    audioSources[0] = "[0:a]";
  }

  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index]!;
    const start = timestamp(clip.start);
    const end = timestamp(clip.end);
    const duration = timestamp(clip.end - clip.start);
    filters.push(videoSources[index] + "trim=start=" + start + ":end=" + end +
      ",setpts=PTS-STARTPTS,split=2[bgsrc" + index + "][fgsrc" + index + "]");
    filters.push("[bgsrc" + index + "]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:1[bg" + index + "]");
    filters.push("[fgsrc" + index + "]scale=720:1280:force_original_aspect_ratio=decrease[fg" + index + "]");
    filters.push("[bg" + index + "][fg" + index + "]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v" + index + "]");
    concatInputs.push("[v" + index + "]");
    if (hasAudio) {
      filters.push(audioSources[index] + "atrim=start=" + start + ":end=" + end +
        ",asetpts=PTS-STARTPTS,apad=pad_dur=" + duration + ",atrim=duration=" + duration + "[a" + index + "]");
      concatInputs.push("[a" + index + "]");
    }
  }
  filters.push(concatInputs.join("") + "concat=n=" + plan.clips.length + ":v=1:a=" +
    (hasAudio ? "1" : "0") + "[vout]" + (hasAudio ? "[aout]" : ""));
  return filters.join(";");
}

export function buildAutoReelFfmpegArgs(inputPath: string, outputPath: string, plan: AutoReelPlan, hasAudio: boolean): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-filter_complex", buildAutoReelFilterGraph(plan, hasAudio), "-map", "[vout]",
    "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", "2500k", "-maxrate", "3000k", "-bufsize", "6000k", "-pix_fmt", "yuv420p"];
  if (hasAudio) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  else args.push("-an");
  args.push("-movflags", "+faststart", outputPath);
  return args;
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync("ffmpeg", args, { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new AutoReelRenderError("FFmpeg is unavailable on the server.");
    throw new AutoReelRenderError();
  }
}

export async function renderAutoBodyReel(
  inputPath: string,
  outputPath: string,
  segments: SegmentAnalysis[],
  hasAudio: boolean,
  options: AutoReelRenderOptions = {},
): Promise<AutoReelPlan> {
  const plan = buildAutoReelPlan(segments);
  await (options.runFfmpeg ?? runFfmpeg)(buildAutoReelFfmpegArgs(inputPath, outputPath, plan, hasAudio));
  return plan;
}
