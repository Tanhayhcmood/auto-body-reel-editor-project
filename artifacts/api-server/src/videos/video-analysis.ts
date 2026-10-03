import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, sep, join } from "node:path";
import { createAIProvider, type AIProvider, type GeminiImageInput } from "../ai/provider";
import { InvalidAIResponseError, validateGeminiAnalysis } from "./analysis-schema";
import {
  extractVideoMetadata,
  type VideoMetadata,
} from "./metadata";
import {
  createVideoSegments,
  MAX_REPRESENTATIVE_FRAMES,
  MIN_FRAMES_PER_SEGMENT,
  MAX_FRAMES_PER_SEGMENT,
  type VideoSegment,
} from "./segmentation";
import { getVideoAnalysisDirectory, isVideoId } from "./storage";

const ANALYSIS_INSTRUCTIONS = `Analyze the supplied representative frames as the actual visual sequence for each identified segment of an auto-body-repair video.

Evidence rules:
- Describe only details and events that are directly visible in the supplied frames. Never invent damage, tools, repair actions, materials, vehicle details, before/after states, or outcomes.
- Frames are sparse samples, not the full video. Do not claim an action occurred between frames unless the visible sequence supports that claim.
- If the supplied frames do not establish what is happening, state that it is unclear from the provided frames, keep visual_events empty where appropriate, and do not assign unsupported labels.
- Treat each segment independently. Use the frame labels and timestamps to preserve chronological order within a segment.

For each input segment return one object with exactly these fields: segment_id, start, end, summary, visual_events, labels, quality_score, interest_score, repair_relevance, transformation_value.
Use the exact segment_id, start, and end supplied. summary must be a concise factual observation. visual_events must be a list of short, visible events in chronological order. labels may only contain: damaged_area, before_repair, repair_process, tools_action, close_up_detail, satisfying_moment, final_result, vehicle_reveal, painting, sanding, polishing, dent_repair, uninteresting, repetitive, blurry.
All four scores must be numbers from 0 through 1 and reflect only the supplied visual evidence: quality_score is image clarity, interest_score is visual interest, repair_relevance is visible relevance to vehicle body repair, and transformation_value is the amount of visible change established by the frames.
Return only valid JSON in this exact envelope: {"segments":[{"segment_id":"...","start":0,"end":1,"summary":"...","visual_events":[],"labels":[],"quality_score":0,"interest_score":0,"repair_relevance":0,"transformation_value":0}]}. Do not add keys or prose.`;

export interface VideoAnalysisResult {
  video_id: string;
  duration_seconds: number;
  width: number;
  height: number;
  has_audio: boolean;
  scene_change_seconds: number[];
  segments: ReturnType<typeof validateGeminiAnalysis>;
  artifacts: {
    segments_json: string;
    analysis_json: string;
  };
}

interface AnalysisOptions {
  provider?: AIProvider;
  artifactsDirectory?: string;
  metadataExtractor?: (videoPath: string) => Promise<VideoMetadata>;
  segmenter?: (
    videoPath: string,
    duration: number,
    framesDirectory: string,
  ) => Promise<{ sceneChanges: number[]; segments: VideoSegment[] }>;
}

export function buildVideoAnalysisPrompt(segments: VideoSegment[]): string {
  const segmentList = segments.map(({ segment_id, start, end, duration }) => ({
    segment_id,
    start,
    end,
    duration,
  }));

  return `${ANALYSIS_INSTRUCTIONS}\n\nInput segments, in chronological order:\n${JSON.stringify(segmentList, null, 2)}\n\nFor each image, the accompanying text identifies its segment and exact source timestamp. Compare only frames belonging to that segment.`;
}

export async function analyzeVideoSegments(
  segments: VideoSegment[],
  videoDuration: number,
  provider: AIProvider,
): Promise<ReturnType<typeof validateGeminiAnalysis>> {
  const totalFrameCount = segments.reduce(
    (total, segment) => total + segment.representative_frames.length,
    0,
  );
  if (
    segments.length === 0 ||
    segments.length > 16 ||
    totalFrameCount > MAX_REPRESENTATIVE_FRAMES ||
    segments.some(
      (segment) =>
        segment.representative_frames.length < MIN_FRAMES_PER_SEGMENT ||
        segment.representative_frames.length > MAX_FRAMES_PER_SEGMENT,
    )
  ) {
    throw new Error("Video segments exceed the representative-frame limits.");
  }

  const images: GeminiImageInput[] = [];
  for (const segment of segments) {
    for (let index = 0; index < segment.representative_frames.length; index += 1) {
      const frame = segment.representative_frames[index]!;
      images.push({
        mimeType: "image/jpeg",
        label: `Segment ${segment.segment_id}; source timestamp ${frame.timestamp.toFixed(3)} seconds; frame ${index + 1} of ${segment.representative_frames.length}.`,
        data: await readFile(frame.path),
      });
    }
  }

  const responseText = await provider.generateMultimodal(
    buildVideoAnalysisPrompt(segments),
    images,
  );
  return validateGeminiAnalysis(responseText, segments, videoDuration);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function framePathForArtifact(runDirectory: string, framePath: string): string {
  return relative(runDirectory, framePath).split(sep).join("/");
}

export async function analyzeUploadedVideo(
  videoId: string,
  videoPath: string,
  options: AnalysisOptions = {},
): Promise<VideoAnalysisResult> {
  if (!isVideoId(videoId)) {
    throw new Error("Invalid video ID.");
  }
  try {
    await access(videoPath);
  } catch {
    throw new Error("Uploaded video was not found.");
  }

  const metadataExtractor = options.metadataExtractor ?? extractVideoMetadata;
  const segmenter = options.segmenter ?? createVideoSegments;
  const provider = options.provider ?? createAIProvider();
  const metadata = await metadataExtractor(videoPath);
  const runId = randomUUID();
  const artifactsDirectory =
    options.artifactsDirectory ?? getVideoAnalysisDirectory();
  const runDirectory = join(artifactsDirectory, videoId, runId);
  const framesDirectory = join(runDirectory, "frames");
  await mkdir(runDirectory, { recursive: true });

  const { sceneChanges, segments } = await segmenter(
    videoPath,
    metadata.durationSeconds,
    framesDirectory,
  );
  const segmentsArtifactPath = join(runDirectory, "segments.json");
  const analysisArtifactPath = join(runDirectory, "analysis.json");

  await writeJson(segmentsArtifactPath, {
    video_id: videoId,
    duration_seconds: metadata.durationSeconds,
    scene_change_seconds: sceneChanges,
    segments: segments.map((segment) => ({
      ...segment,
      representative_frames: segment.representative_frames.map((frame) => ({
        timestamp: frame.timestamp,
        path: framePathForArtifact(runDirectory, frame.path),
      })),
    })),
  });

  const analyzedSegments = await analyzeVideoSegments(
    segments,
    metadata.durationSeconds,
    provider,
  );
  const result: VideoAnalysisResult = {
    video_id: videoId,
    duration_seconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    has_audio: metadata.hasAudio,
    scene_change_seconds: sceneChanges,
    segments: analyzedSegments,
    artifacts: {
      segments_json: relative(process.cwd(), segmentsArtifactPath).split(sep).join("/"),
      analysis_json: relative(process.cwd(), analysisArtifactPath).split(sep).join("/"),
    },
  };

  await writeJson(analysisArtifactPath, result);
  return result;
}

export { InvalidAIResponseError };