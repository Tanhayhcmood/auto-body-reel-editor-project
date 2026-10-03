import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { extractVideoMetadata } from "./metadata";
import { FFmpegProcessingError } from "./segmentation";
import type { ReelEditClip, ReelEditPlan } from "./reel-edit-plan";

const execFileAsync = promisify(execFile);
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const FONT_DIRECTORY =
  process.env["REEL_FONTS_DIR"] ?? "/usr/share/fonts/truetype/noto";

export interface ReelRenderResult {
  width: number;
  height: number;
  durationSeconds: number;
  fileSizeBytes: number;
}

function formatAssTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export function buildAssSubtitleDocument(
  clip: ReelEditClip,
  hook?: { text: string; durationSeconds: number },
): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUTPUT_WIDTH}`,
    `PlayResY: ${OUTPUT_HEIGHT}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Caption,Noto Naskh Arabic,58,&H00FFFFFF,&H000000FF,&H80000000,&H64000000,0,0,0,0,100,100,0,0,1,5,1,2,60,60,130,1",
    "Style: Hook,Noto Naskh Arabic,72,&H00FFFFFF,&H000000FF,&H80000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,8,70,70,190,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];

  if (hook) {
    lines.push(
      `Dialogue: 0,${formatAssTime(0)},${formatAssTime(hook.durationSeconds)},Hook,,0,0,0,,${escapeAssText(hook.text)}`,
    );
  }
  lines.push(
    `Dialogue: 0,${formatAssTime(clip.caption_start_seconds)},${formatAssTime(clip.caption_end_seconds)},Caption,,0,0,0,,${escapeAssText(clip.caption_text)}`,
  );
  return `${lines.join("\n")}\n`;
}

function escapeFilterPath(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function fixedFraction(value: number): string {
  return value.toFixed(4);
}

export function buildReelFilterGraph(
  clips: ReelEditClip[],
  subtitlePaths: string[],
  hasAudio: boolean,
): string {
  if (clips.length === 0 || clips.length !== subtitlePaths.length) {
    throw new Error("Each Reel clip must have a subtitle file.");
  }

  const chains: string[] = [];
  for (const [index, clip] of clips.entries()) {
    const subtitlePath = escapeFilterPath(subtitlePaths[index]!);
    const subtitleFilter = `subtitles=filename='${subtitlePath}':fontsdir='${escapeFilterPath(FONT_DIRECTORY)}'`;
    const start = clip.source_start_seconds.toFixed(4);
    const end = clip.source_end_seconds.toFixed(4);
    const duration = (clip.source_end_seconds - clip.source_start_seconds).toFixed(4);
    const videoFilters = [
      `trim=start=${start}:end=${end}`,
      "setpts=PTS-STARTPTS",
      `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase`,
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(iw-ow)*${fixedFraction(clip.reframe_x)}:(ih-oh)*${fixedFraction(clip.reframe_y)}`,
      "setsar=1",
      `fps=${OUTPUT_FPS}`,
      subtitleFilter,
      "format=yuv420p",
    ];
    chains.push(`[0:v]${videoFilters.join(",")}[v${index}]`);

    if (hasAudio) {
      const audioFilters = [
        `atrim=start=${start}:end=${end}`,
        "asetpts=PTS-STARTPTS",
        "aresample=48000",
        "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
        `apad=pad_dur=${duration}`,
        `atrim=duration=${duration}`,
      ];
      chains.push(`[0:a]${audioFilters.join(",")}[a${index}]`);
    }
  }

  const concatInputs = clips.flatMap((_, index) =>
    hasAudio ? [`[v${index}]`, `[a${index}]`] : [`[v${index}]`],
  );
  chains.push(
    `${concatInputs.join("")}concat=n=${clips.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? "[outa]" : ""}`,
  );
  return chains.join(";");
}

export async function renderReel(
  videoPath: string,
  plan: ReelEditPlan,
  outputPath: string,
  hasAudio: boolean,
): Promise<ReelRenderResult> {
  if (resolve(videoPath) === resolve(outputPath)) {
    throw new Error("The Reel output path must not overwrite the source video.");
  }
  if (plan.clips.length === 0) {
    throw new Error("At least one selected clip is required to render a Reel.");
  }

  const outputDirectory = dirname(outputPath);
  const subtitlePaths = plan.clips.map(() =>
    join(outputDirectory, `.reel-subtitles-${randomUUID()}.ass`),
  );
  await mkdir(outputDirectory, { recursive: true });

  try {
    await Promise.all(
      plan.clips.map((clip, index) =>
        writeFile(
          subtitlePaths[index]!,
          buildAssSubtitleDocument(
            clip,
            index === 0
              ? {
                  text: plan.hook_text,
                  durationSeconds: plan.hook_duration_seconds,
                }
              : undefined,
          ),
          "utf8",
        ),
      ),
    );

    const filterGraph = buildReelFilterGraph(
      plan.clips,
      subtitlePaths,
      hasAudio,
    );
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      videoPath,
      "-filter_complex",
      filterGraph,
      "-map",
      "[outv]",
      ...(hasAudio ? ["-map", "[outa]"] : ["-an"]),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : []),
      "-movflags",
      "+faststart",
      outputPath,
    ];

    try {
      await execFileAsync("ffmpeg", args, {
        encoding: "utf8",
        timeout: 900_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      throw new FFmpegProcessingError("FFmpeg Reel rendering failed.");
    }

    let metadata;
    try {
      metadata = await extractVideoMetadata(outputPath);
    } catch {
      throw new FFmpegProcessingError("FFmpeg did not create a readable MP4.");
    }
    if (metadata.width !== OUTPUT_WIDTH || metadata.height !== OUTPUT_HEIGHT) {
      throw new FFmpegProcessingError("The rendered MP4 is not 1080x1920.");
    }

    const outputFile = await stat(outputPath);
    if (outputFile.size <= 0) {
      throw new FFmpegProcessingError("FFmpeg created an empty MP4.");
    }

    return {
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
      fileSizeBytes: outputFile.size,
    };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    if (error instanceof FFmpegProcessingError) {
      throw error;
    }
    throw new FFmpegProcessingError("The Reel MP4 could not be rendered.");
  } finally {
    await Promise.all(
      subtitlePaths.map((subtitlePath) =>
        rm(subtitlePath, { force: true }).catch(() => undefined),
      ),
    );
  }
}