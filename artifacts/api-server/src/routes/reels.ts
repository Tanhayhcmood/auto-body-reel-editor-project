import { access } from "node:fs/promises";
import { Router, type IRouter, type Request, type Response } from "express";
import { GeminiAPIError } from "../ai/provider";
import { InvalidAIResponseError } from "../videos/analysis-schema";
import { InvalidVideoError } from "../videos/metadata";
import {
  InvalidReelPlanError,
} from "../videos/reel-edit-plan";
import { processUploadedVideoToReel } from "../videos/reel-pipeline";
import { getVideoReelPath, getUploadedVideoPath, isVideoId } from "../videos/storage";
import { FFmpegProcessingError } from "../videos/segmentation";

const router: IRouter = Router();

router.post(
  "/videos/:id/process",
  async (request: Request, response: Response): Promise<void> => {
    const routeId = request.params["id"];
    const videoId = Array.isArray(routeId) ? routeId[0] : routeId;
    if (!videoId || !isVideoId(videoId)) {
      response.status(400).json({ error: "A valid uploaded video ID is required." });
      return;
    }

    const videoPath = getUploadedVideoPath(videoId);
    try {
      await access(videoPath);
    } catch {
      response.status(404).json({ error: "Uploaded video was not found." });
      return;
    }

    try {
      const result = await processUploadedVideoToReel(videoId, videoPath);
      response.status(200).json(result);
    } catch (error) {
      if (error instanceof InvalidVideoError) {
        response.status(422).json({ error: "Uploaded video metadata is invalid." });
        return;
      }
      if (error instanceof FFmpegProcessingError) {
        response.status(422).json({ error: error.message });
        return;
      }
      if (
        error instanceof InvalidAIResponseError ||
        error instanceof InvalidReelPlanError ||
        error instanceof GeminiAPIError
      ) {
        response.status(502).json({ error: error.message });
        return;
      }

      response.status(500).json({ error: "Video-to-Reel processing failed." });
    }
  },
);

router.get(
  "/videos/:id/reels/:reelId/download",
  async (request: Request, response: Response): Promise<void> => {
    const routeVideoId = request.params["id"];
    const videoId = Array.isArray(routeVideoId) ? routeVideoId[0] : routeVideoId;
    const routeReelId = request.params["reelId"];
    const reelId = Array.isArray(routeReelId) ? routeReelId[0] : routeReelId;
    if (!videoId || !isVideoId(videoId) || !reelId || !isVideoId(reelId)) {
      response.status(400).json({ error: "A valid video ID and Reel ID are required." });
      return;
    }

    const outputPath = getVideoReelPath(videoId, reelId);
    try {
      await access(outputPath);
    } catch {
      response.status(404).json({ error: "Rendered Reel MP4 was not found." });
      return;
    }

    response.download(
      outputPath,
      `auto-body-reel-${videoId}-${reelId}.mp4`,
      (error) => {
        if (error && !response.headersSent) {
          response.status(500).json({ error: "Rendered Reel MP4 could not be downloaded." });
        }
      },
    );
  },
);

export default router;