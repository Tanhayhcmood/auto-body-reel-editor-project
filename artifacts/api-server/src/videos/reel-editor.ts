import { execFile } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createAIProvider, type AIProvider } from "../ai/provider";
import type { SegmentAnalysis } from "./analysis-schema";
import {
  transcribeVideoAudio,
  type TranscriptSegment,
} from "./audio-transcription";
import { createReelStoryboard, type ReelStoryboard } from "./reel-storyboard";

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

export interface AutoReelRenderResult extends AutoReelPlan {
  hook: string;
  cta: string;
  instagramCaption: string;
  coverPath: string;
  transcriptSegmentCount: number;
}

export interface AutoReelRenderOptions {
  runFfmpeg?: (args: string[]) => Promise<void>;
  provider?: AIProvider;
  createStoryboard?: (
    segments: SegmentAnalysis[],
    provider: AIProvider,
  ) => Promise<ReelStoryboard>;
  transcribeAudio?: (
    inputPath: string,
    audioPath: string,
    durationSeconds: number,
    provider: AIProvider,
  ) => Promise<TranscriptSegment[]>;
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

function escapeFilterPath(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function buildAutoReelFilterGraph(
  plan: AutoReelPlan,
  hasAudio: boolean,
  subtitlesPath?: string,
): string {
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
    filters.push("[bgsrc" + index + "]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2[bg" + index + "]");
    filters.push("[fgsrc" + index + "]scale=1080:1920:force_original_aspect_ratio=decrease,eq=contrast=1.04:saturation=1.08[fg" + index + "]");
    filters.push("[bg" + index + "][fg" + index + "]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v" + index + "]");
    concatInputs.push("[v" + index + "]");
    if (hasAudio) {
      filters.push(audioSources[index] + "atrim=start=" + start + ":end=" + end +
        ",asetpts=PTS-STARTPTS,apad=pad_dur=" + duration + ",atrim=duration=" + duration + "[a" + index + "]");
      concatInputs.push("[a" + index + "]");
    }
  }
  filters.push(concatInputs.join("") + "concat=n=" + plan.clips.length + ":v=1:a=" +
    (hasAudio ? "1" : "0") + "[vraw]" + (hasAudio ? "[acat]" : ""));
  if (subtitlesPath) {
    filters.push("[vraw]subtitles=filename='" + escapeFilterPath(subtitlesPath) +
      "',setsar=1,format=yuv420p[vout]");
  } else {
    filters.push("[vraw]null[vout]");
  }
  if (hasAudio) {
    filters.push("[acat]loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
  }
  return filters.join(";");
}

export function buildAutoReelFfmpegArgs(
  inputPath: string,
  outputPath: string,
  plan: AutoReelPlan,
  hasAudio: boolean,
  subtitlesPath?: string,
): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-filter_complex", buildAutoReelFilterGraph(plan, hasAudio, subtitlesPath), "-map", "[vout]",
    "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "23", "-maxrate", "3000k", "-bufsize", "6000k", "-pix_fmt", "yuv420p"];
  if (hasAudio) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  else args.push("-an");
  args.push("-movflags", "+faststart", outputPath);
  return args;
}

function escapeAssText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N");
}

function wrapAssText(value: string, maxCharacters: number): string {
  const lines: string[] = [];
  let current = "";
  for (const word of value.trim().split(/\s+/)) {
    const next = current ? current + " " + word : word;
    if (Array.from(next).length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return escapeAssText(lines.join("\n"));
}

function assTimestamp(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return [
    String(hours),
    String(minutes).padStart(2, "0"),
    `${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`,
  ].join(":");
}

export function buildReelAss(
  editorial: ReelStoryboard,
  transcript: TranscriptSegment[],
): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Noto Sans Arabic,52,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,0,0,1,4,2,2,72,72,300,1",
    "Style: Hook,Noto Sans Arabic,78,&H0000C9F5,&H0000C9F5,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,5,2,8,70,70,245,1",
    "Style: Overlay,Noto Sans Arabic,54,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,4,2,5,80,80,0,1",
    "Style: CTA,Noto Sans Arabic,64,&H0000C9F5,&H0000C9F5,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,5,2,8,70,70,245,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const addDialogue = (
    style: string,
    start: number,
    end: number,
    text: string,
    layer = 0,
  ) => {
    if (end <= start || !text.trim()) return;
    lines.push(
      `Dialogue: ${layer},${assTimestamp(start)},${assTimestamp(end)},${style},,0,0,0,,${text}`,
    );
  };

  const hookEnd = Math.min(editorial.durationSeconds, 2.7);
  addDialogue("Hook", 0, hookEnd, wrapAssText(editorial.hook, 24), 2);
  const ctaStart = Math.max(hookEnd, editorial.durationSeconds - 2.7);
  addDialogue(
    "CTA",
    ctaStart,
    editorial.durationSeconds,
    wrapAssText(editorial.cta, 26),
    2,
  );

  let timelineStart = 0;
  for (const clip of editorial.clips) {
    const clipDuration = clip.end - clip.start;
    const overlay = editorial.overlays.find(
      (candidate) => candidate.segment_id === clip.segment_id,
    );
    if (overlay) {
      const start = timelineStart + Math.min(0.4, clipDuration / 4);
      addDialogue(
        "Overlay",
        start,
        Math.min(timelineStart + clipDuration, start + Math.min(2.2, clipDuration)),
        wrapAssText(overlay.text, 30),
        1,
      );
    }
    for (const subtitle of transcript) {
      const sourceStart = Math.max(clip.start, subtitle.start);
      const sourceEnd = Math.min(clip.end, subtitle.end);
      if (sourceEnd <= sourceStart) continue;
      addDialogue(
        "Default",
        timelineStart + sourceStart - clip.start,
        timelineStart + sourceEnd - clip.start,
        wrapAssText(subtitle.text, 34),
        3,
      );
    }
    timelineStart += clipDuration;
  }

  return lines.join("\n") + "\n";
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
): Promise<AutoReelRenderResult> {
  const provider = options.provider ?? createAIProvider();
  const editorial = await (options.createStoryboard ?? createReelStoryboard)(segments, provider);
  const plan: AutoReelPlan = {
    clips: editorial.clips,
    durationSeconds: editorial.durationSeconds,
  };
  const run = options.runFfmpeg ?? runFfmpeg;
  const subtitlesPath = outputPath + ".ass";
  const audioPath = outputPath + ".audio.mp3";
  const coverPath = outputPath.replace(/\.mp4$/i, "-cover.jpg");
  let transcript: TranscriptSegment[] = [];

  try {
    if (hasAudio) {
      transcript = await (options.transcribeAudio ?? transcribeVideoAudio)(
        inputPath,
        audioPath,
        segments.reduce((max, segment) => Math.max(max, segment.end), 0),
        provider,
      );
    }
    await writeFile(
      subtitlesPath,
      buildReelAss(editorial, transcript),
      { encoding: "utf8", flag: "wx" },
    );
    await run(
      buildAutoReelFfmpegArgs(
        inputPath,
        outputPath,
        plan,
        hasAudio,
        subtitlesPath,
      ),
    );
    const outputStats = await stat(outputPath);
    if (outputStats.size === 0) {
      throw new AutoReelRenderError("FFmpeg produced an empty edited reel.");
    }
    await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "0.1",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:color=black",
      "-q:v",
      "3",
      coverPath,
    ]);
    const coverStats = await stat(coverPath);
    if (coverStats.size === 0) {
      throw new AutoReelRenderError("FFmpeg produced an empty Reel cover.");
    }
    return {
      ...plan,
      hook: editorial.hook,
      cta: editorial.cta,
      instagramCaption: editorial.instagramCaption,
      coverPath,
      transcriptSegmentCount: transcript.length,
    };
  } finally {
    await Promise.all([
      rm(subtitlesPath, { force: true }),
      rm(audioPath, { force: true }),
    ]);
  }
}
