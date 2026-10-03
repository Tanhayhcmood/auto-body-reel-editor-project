import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_UPLOAD_DIRECTORY = join(
  tmpdir(),
  "auto-body-reel-editor",
  "uploads",
);

const DEFAULT_ANALYSIS_DIRECTORY = join(process.cwd(), "dev-artifacts");
const VIDEO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getVideoUploadDirectory(): string {
  const configuredPath = process.env["VIDEO_UPLOAD_DIR"]?.trim();
  if (!configuredPath) {
    return DEFAULT_UPLOAD_DIRECTORY;
  }
  return isAbsolute(configuredPath)
    ? configuredPath
    : join(process.cwd(), configuredPath);
}

export function getVideoAnalysisDirectory(): string {
  const configuredPath = process.env["VIDEO_ANALYSIS_ARTIFACTS_DIR"]?.trim();
  if (!configuredPath) {
    return DEFAULT_ANALYSIS_DIRECTORY;
  }
  return isAbsolute(configuredPath)
    ? configuredPath
    : join(process.cwd(), configuredPath);
}

export function isVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value);
}

export function getUploadedVideoPath(videoId: string): string {
  if (!isVideoId(videoId)) {
    throw new Error("Invalid video ID.");
  }
  return join(getVideoUploadDirectory(), videoId);
}