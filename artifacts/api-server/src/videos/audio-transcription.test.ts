import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  transcribeVideoAudio,
  validateTranscript,
  InvalidTranscriptError,
} from "./audio-transcription";

const execFileAsync = promisify(execFile);

test("validates empty speech and Persian transcript segments", () => {
  assert.deepEqual(validateTranscript('{"segments":[]}', 5), []);
  assert.deepEqual(
    validateTranscript(
      '{"segments":[{"start":0.4,"end":1.7,"text":"ترمیم بدنه خودرو"}]}',
      5,
    ),
    [{ start: 0.4, end: 1.7, text: "ترمیم بدنه خودرو" }],
  );
});

test("rejects transcript timestamps outside the source video", () => {
  assert.throws(
    () =>
      validateTranscript(
        '{"segments":[{"start":4.5,"end":6,"text":"ترمیم بدنه"}]}',
        5,
      ),
    InvalidTranscriptError,
  );
});

test("transcribes compressed audio using the Gemini multimodal provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audio-transcription-test-"));
  const audioPath = join(directory, "audio.mp3");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let prompt = "";
  let suppliedAudioBytes = 0;
  const provider = {
    name: "gemini",
    model: "test-model",
    generateText: async () => "",
    generateMultimodal: async (value: string, inputs: Array<{
      label: string;
      mimeType: "image/jpeg" | "audio/mp3";
      data: Uint8Array;
    }>) => {
      prompt = value;
      assert.equal(inputs[0]?.mimeType, "audio/mp3");
      suppliedAudioBytes = inputs[0]?.data.byteLength ?? 0;
      return '{"segments":[{"start":1,"end":2,"text":"ترمیم دقیق پنل"}]}';
    },
  };

  const transcript = await transcribeVideoAudio(
    "source.mp4",
    audioPath,
    8,
    provider,
    {
      runFfmpeg: async (_inputPath, outputPath) => {
        await writeFile(outputPath, Buffer.from([1, 2, 3]));
      },
    },
  );

  assert.equal((await readFile(audioPath)).length, 3);
  assert.equal(suppliedAudioBytes, 3);
  assert.match(prompt, /Persian subtitles/);
  assert.deepEqual(transcript, [{ start: 1, end: 2, text: "ترمیم دقیق پنل" }]);
});

test("extracts an MP3 speech track from a real video with FFmpeg", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audio-track-test-"));
  const inputPath = join(directory, "source.mp4");
  const audioPath = join(directory, "source-audio.mp3");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000:duration=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    inputPath,
  ]);

  let audioBytes = 0;
  const transcript = await transcribeVideoAudio(inputPath, audioPath, 2, {
    name: "gemini",
    model: "test-model",
    generateText: async () => "",
    generateMultimodal: async (_prompt, inputs) => {
      audioBytes = inputs[0]?.data.byteLength ?? 0;
      assert.equal(inputs[0]?.mimeType, "audio/mp3");
      return '{"segments":[]}';
    },
  });

  assert.deepEqual(transcript, []);
  assert.ok(audioBytes > 0);
  assert.ok((await readFile(audioPath)).length > 0);
});