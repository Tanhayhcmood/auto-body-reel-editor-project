import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_SEGMENTS = 16;
export const MAX_REPRESENTATIVE_FRAMES = 48;
export const MAX_FRAMES_PER_SEGMENT = 4;
export const MIN_FRAMES_PER_SEGMENT = 2;
const MAX_BASE_SEGMENT_SECONDS = 8;
const MIN_BOUNDARY_GAP_SECONDS = 1.25;
const SCENE_THRESHOLD = 0.28;

export interface SegmentRange {
  start: number;
  end: number;
  duration: number;
}

export interface RepresentativeFrame {
  timestamp: number;
  path: string;
}

export interface VideoSegment extends SegmentRange {
  segment_id: string;
  representative_frames: RepresentativeFrame[];
}

export interface SegmentingOptions {
  maxSegments?: number;
  maxBaseSegmentSeconds?: number;
  minimumBoundaryGapSeconds?: number;
}

export class FFmpegProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegProcessingError";
  }
}

function evenlySpaced(values: number[], limit: number): number[] {
  if (limit <= 0) {
    return [];
  }
  if (values.length <= limit) {
    return values;
  }
  if (limit === 1) {
    return [values[Math.floor(values.length / 2)]!];
  }

  const indices = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    indices.add(Math.round((index * (values.length - 1)) / (limit - 1)));
  }
  return [...indices].sort((left, right) => left - right).map((index) => values[index]!);
}

export function buildSegmentRanges(
  duration: number,
  sceneChanges: number[],
  options: SegmentingOptions = {},
): SegmentRange[] {
  const maxSegments = options.maxSegments ?? MAX_SEGMENTS;
  const maxBaseSegmentSeconds =
    options.maxBaseSegmentSeconds ?? MAX_BASE_SEGMENT_SECONDS;
  const minimumBoundaryGap =
    options.minimumBoundaryGapSeconds ?? MIN_BOUNDARY_GAP_SECONDS;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration must be a positive finite number.");
  }
  if (!Number.isInteger(maxSegments) || maxSegments < 1) {
    throw new Error("At least one video segment must be allowed.");
  }
  if (!Number.isFinite(maxBaseSegmentSeconds) || maxBaseSegmentSeconds <= 0) {
    throw new Error("Base segment interval must be a positive finite number.");
  }

  const baseBoundaryCount = Math.min(
    Math.floor(maxSegments / 2),
    Math.max(0, Math.ceil(duration / maxBaseSegmentSeconds) - 1),
  );
  const timeBoundaries = Array.from({ length: baseBoundaryCount }, (_, index) =>
    (duration * (index + 1)) / (baseBoundaryCount + 1),
  );
  const sceneBoundaryCapacity = Math.max(
    0,
    maxSegments - 1 - timeBoundaries.length,
  );
  const minimumGap = Math.min(minimumBoundaryGap, duration / 2);
  const chosenSceneBoundaries: number[] = [];

  for (const timestamp of [...sceneChanges].sort((left, right) => left - right)) {
    if (
      !Number.isFinite(timestamp) ||
      timestamp <= minimumGap ||
      duration - timestamp <= minimumGap
    ) {
      continue;
    }
    if (
      [...timeBoundaries, ...chosenSceneBoundaries].some(
        (boundary) => Math.abs(timestamp - boundary) < minimumGap,
      )
    ) {
      continue;
    }
    chosenSceneBoundaries.push(timestamp);
  }

  const selectedSceneBoundaries = evenlySpaced(
    chosenSceneBoundaries,
    sceneBoundaryCapacity,
  );
  const boundaries = [
    ...new Set([0, duration, ...timeBoundaries, ...selectedSceneBoundaries]),
  ].sort((left, right) => left - right);

  return boundaries.slice(1).map((end, index) => {
    const start = boundaries[index]!;
    const roundedStart = Number(start.toFixed(4));
    const roundedEnd = Number(end.toFixed(4));
    return {
      start: roundedStart,
      end: roundedEnd,
      duration: Number((roundedEnd - roundedStart).toFixed(4)),
    };
  });
}

export function getFrameCounts(ranges: SegmentRange[]): number[] {
  if (ranges.length > MAX_SEGMENTS) {
    throw new Error(`Segmentation exceeds the ${MAX_SEGMENTS}-segment limit.`);
  }

  const desiredCounts = ranges.map(({ duration }) =>
    duration <= 5 ? 2 : duration <= 12 ? 3 : 4,
  );
  const counts = ranges.map(() => MIN_FRAMES_PER_SEGMENT);
  let remaining =
    MAX_REPRESENTATIVE_FRAMES -
    counts.reduce((total, count) => total + count, 0);
  const longestFirst = ranges
    .map((range, index) => ({ index, duration: range.duration }))
    .sort((left, right) => right.duration - left.duration);

  for (const targetCount of [3, 4]) {
    for (const { index } of longestFirst) {
      if (remaining <= 0) {
        break;
      }
      if (desiredCounts[index]! >= targetCount && counts[index]! < targetCount) {
        counts[index] = targetCount;
        remaining -= 1;
      }
    }
  }

  return counts;
}

export function getRepresentativeFrameTimestamps(
  start: number,
  end: number,
  frameCount: number,
): number[] {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isInteger(frameCount) ||
    frameCount < MIN_FRAMES_PER_SEGMENT ||
    frameCount > MAX_FRAMES_PER_SEGMENT
  ) {
    throw new Error("Invalid segment range or representative frame count.");
  }

  const duration = end - start;
  return Array.from({ length: frameCount }, (_, index) =>
    Number((start + (duration * (index + 1)) / (frameCount + 1)).toFixed(4)),
  );
}

export function parseSceneChangeTimestamps(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((timestamp) => Number.isFinite(timestamp));
}

export async function detectSceneChanges(videoPath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        videoPath,
        "-vf",
        `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
        "-an",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseSceneChangeTimestamps(stderr);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") {
      throw new FFmpegProcessingError("FFmpeg is unavailable on the server.");
    }
    throw new FFmpegProcessingError("FFmpeg scene detection failed.");
  }
}

async function extractFrame(
  videoPath: string,
  timestamp: number,
  outputPath: string,
): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        timestamp.toFixed(4),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "5",
        outputPath,
      ],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new FFmpegProcessingError("FFmpeg could not extract a representative frame.");
  }
}

export async function createVideoSegments(
  videoPath: string,
  duration: number,
  framesDirectory: string,
): Promise<{ sceneChanges: number[]; segments: VideoSegment[] }> {
  const sceneChanges = await detectSceneChanges(videoPath);
  const ranges = buildSegmentRanges(duration, sceneChanges);
  const frameCounts = getFrameCounts(ranges);

  await rm(framesDirectory, { recursive: true, force: true });
  await mkdir(framesDirectory, { recursive: true });

  const segments: VideoSegment[] = ranges.map((range, segmentIndex) => {
    const segment_id = `segment-${String(segmentIndex + 1).padStart(3, "0")}`;
    const timestamps = getRepresentativeFrameTimestamps(
      range.start,
      range.end,
      frameCounts[segmentIndex]!,
    );

    return {
      ...range,
      segment_id,
      representative_frames: timestamps.map((timestamp, frameIndex) => ({
        timestamp,
        path: join(
          framesDirectory,
          `${segment_id}-frame-${String(frameIndex + 1).padStart(2, "0")}-${randomUUID()}.jpg`,
        ),
      })),
    };
  });

  const work = segments.flatMap((segment) =>
    segment.representative_frames.map((frame) => ({
      segment,
      frame,
    })),
  );

  try {
    let nextIndex = 0;
    const workerCount = Math.min(4, work.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < work.length) {
          const item = work[nextIndex]!;
          nextIndex += 1;
          await extractFrame(videoPath, item.frame.timestamp, item.frame.path);
        }
      }),
    );
  } catch (error) {
    await rm(framesDirectory, { recursive: true, force: true });
    throw error;
  }

  return { sceneChanges, segments };
}