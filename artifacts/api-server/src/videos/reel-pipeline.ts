import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { relative, sep, dirname } from "node:path";
import {
  createAIProvider,
  type AIProvider,
} from "../ai/provider";
import {
  analyzeUploadedVideo,
  type VideoAnalysisOptions,
  type VideoAnalysisResult,
} from "./video-analysis";
import {
  createReelEditPlan,
  type ReelEditPlan,
} from "./reel-edit-plan";
import {
  renderReel,
  type ReelRenderResult,
} from "./reel-renderer";
import {
  getVideoAnalysisDirectory,
  getVideoReelPath,
  getVideoReelPlanPath,
  isVideoId,
} from "./storage";

export interface ReelPipelineOptions
  extends Pick<
    VideoAnalysisOptions,
    "artifactsDirectory" | "metadataExtractor" | "segmenter"
  > {
  provider?: AIProvider;
  renderer?: typeof renderReel;
  reelIdFactory?: () => string;
}

export interface ProcessedReelResult {
  video_id: string;
  analysis: VideoAnalysisResult;
  edit_plan: ReelEditPlan;
  output: {
    reel_id: string;
    mime_type: "video/mp4";
    width: number;
    height: number;
    duration_seconds: number;
    file_size_bytes: number;
    download_url: string;
    artifacts: {
      edit_plan_json: string;
    };
  };
}

function artifactPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function processUploadedVideoToReel(
  videoId: string,
  videoPath: string,
  options: ReelPipelineOptions = {},
): Promise<ProcessedReelResult> {
  if (!isVideoId(videoId)) {
    throw new Error("Invalid video ID.");
  }
  try {
    await access(videoPath);
  } catch {
    throw new Error("Uploaded video was not found.");
  }

  const provider = options.provider ?? createAIProvider();
  const analysis = await analyzeUploadedVideo(videoId, videoPath, {
    provider,
    artifactsDirectory: options.artifactsDirectory,
    metadataExtractor: options.metadataExtractor,
    segmenter: options.segmenter,
  });
  const editPlan = await createReelEditPlan(analysis, provider);
  const reelId = options.reelIdFactory?.() ?? randomUUID();
  if (!isVideoId(reelId)) {
    throw new Error("Invalid Reel ID.");
  }

  const artifactsDirectory =
    options.artifactsDirectory ?? getVideoAnalysisDirectory();
  const outputPath = getVideoReelPath(videoId, reelId, artifactsDirectory);
  const planPath = getVideoReelPlanPath(videoId, reelId, artifactsDirectory);
  await writeJson(planPath, editPlan);

  const renderer = options.renderer ?? renderReel;
  const rendered: ReelRenderResult = await renderer(
    videoPath,
    editPlan,
    outputPath,
    analysis.has_audio,
  );

  return {
    video_id: videoId,
    analysis,
    edit_plan: editPlan,
    output: {
      reel_id: reelId,
      mime_type: "video/mp4",
      width: rendered.width,
      height: rendered.height,
      duration_seconds: rendered.durationSeconds,
      file_size_bytes: rendered.fileSizeBytes,
      download_url: `/api/videos/${videoId}/reels/${reelId}/download`,
      artifacts: {
        edit_plan_json: artifactPath(planPath),
      },
    },
  };
}