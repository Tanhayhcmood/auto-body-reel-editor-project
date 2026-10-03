import assert from "node:assert/strict";
import test from "node:test";
import { InvalidVideoError, parseFfprobeMetadata } from "./metadata";

test("parses dimensions, duration, fractional FPS, and audio availability", () => {
  const metadata = parseFfprobeMetadata({
    format: { duration: "12.5" },
    streams: [
      {
        codec_type: "video",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30000/1001",
        r_frame_rate: "30/1",
      },
      { codec_type: "audio" },
    ],
  });

  assert.deepEqual(metadata, {
    durationSeconds: 12.5,
    width: 1920,
    height: 1080,
    fps: 30000 / 1001,
    hasAudio: true,
  });
});

test("uses the video stream frame rate when average FPS is unavailable", () => {
  const metadata = parseFfprobeMetadata({
    format: { duration: 3 },
    streams: [
      {
        codec_type: "video",
        width: 1280,
        height: 720,
        avg_frame_rate: "0/0",
        r_frame_rate: "24/1",
      },
    ],
  });

  assert.equal(metadata.fps, 24);
  assert.equal(metadata.hasAudio, false);
});

test("rejects files with no video stream", () => {
  assert.throws(
    () => parseFfprobeMetadata({ streams: [{ codec_type: "audio" }] }),
    InvalidVideoError,
  );
});