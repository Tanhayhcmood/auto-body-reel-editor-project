import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import multer from "multer";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  extractVideoMetadata,
  InvalidVideoError,
  type VideoMetadata,
} from "../videos/metadata";
import { getVideoUploadDirectory } from "../videos/storage";

const MAX_VIDEO_SIZE_BYTES = 512 * 1024 * 1024;

class UnsupportedVideoTypeError extends Error {}

interface UploadFile {
  filename: string;
  path: string;
}

type MetadataExtractor = (filePath: string) => Promise<VideoMetadata>;

export interface VideoUploadRouterOptions {
  uploadDirectory?: string;
  maxFileSizeBytes?: number;
  metadataExtractor?: MetadataExtractor;
}

function isMulterError(error: unknown): error is multer.MulterError {
  return error instanceof multer.MulterError;
}

export function createVideoUploadRouter(
  options: VideoUploadRouterOptions = {},
): IRouter {
  const uploadDirectory = options.uploadDirectory ?? getVideoUploadDirectory();
  const metadataExtractor = options.metadataExtractor ?? extractVideoMetadata;
  const uploadMiddleware = multer({
    storage: multer.diskStorage({
      destination(_request, _file, callback) {
        void mkdir(uploadDirectory, { recursive: true })
          .then(() => callback(null, uploadDirectory))
          .catch((error: unknown) => callback(error as Error, uploadDirectory));
      },
      filename(_request, _file, callback) {
        callback(null, randomUUID());
      },
    }),
    limits: {
      fileSize: options.maxFileSizeBytes ?? MAX_VIDEO_SIZE_BYTES,
      files: 1,
    },
    fileFilter(_request, file, callback) {
      if (!file.mimetype.toLowerCase().startsWith("video/")) {
        callback(new UnsupportedVideoTypeError("A video file is required."));
        return;
      }
      callback(null, true);
    },
  });

  const router: IRouter = Router();

  router.post(
    "/videos/upload",
    async (request: Request, response: Response): Promise<void> => {
      let file: UploadFile | undefined;
      let keepFile = false;

      try {
        await new Promise<void>((resolve, reject) => {
          uploadMiddleware.single("video")(request, response, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });

        const uploadedFile = request.file;
        if (!uploadedFile) {
          response.status(400).json({ error: "Attach a video in the 'video' field." });
          return;
        }

        file = { filename: uploadedFile.filename, path: uploadedFile.path };
        const metadata = await metadataExtractor(file.path);
        keepFile = true;

        response.status(201).json({
          videoId: file.filename,
          metadata,
        });
      } catch (error) {
        if (isMulterError(error) && error.code === "LIMIT_FILE_SIZE") {
          response.status(413).json({ error: "Video exceeds the 512 MB upload limit." });
          return;
        }
        if (error instanceof UnsupportedVideoTypeError) {
          response.status(415).json({ error: "Upload a video file." });
          return;
        }
        if (error instanceof InvalidVideoError) {
          response.status(422).json({ error: error.message });
          return;
        }

        response.status(500).json({ error: "Video upload could not be processed." });
      } finally {
        if (file && !keepFile) {
          await unlink(file.path).catch(() => undefined);
        }
      }
    },
  );

  return router;
}

export default createVideoUploadRouter();