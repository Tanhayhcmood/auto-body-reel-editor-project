import { access } from "node:fs/promises";
import { Router, type IRouter, type Request, type Response } from "express";
import { GeminiAPIError } from "../ai/provider";
import { InvalidAIResponseError } from "../videos/analysis-schema";
import { InvalidVideoError } from "../videos/metadata";
import { FFmpegProcessingError } from "../videos/segmentation";
import { analyzeUploadedVideo } from "../videos/video-analysis";
import { getUploadedVideoPath, isVideoId } from "../videos/storage";

const router: IRouter = Router();

router.post(
  "/videos/:id/analyze",
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
      const result = await analyzeUploadedVideo(videoId, videoPath);
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
      if (error instanceof InvalidAIResponseError) {
        response.status(502).json({ error: error.message });
        return;
      }
      if (error instanceof GeminiAPIError) {
        response.status(502).json({ error: error.message });
        return;
      }

      response.status(500).json({ error: "Video analysis could not be completed." });
    }
  },
);

export default router;