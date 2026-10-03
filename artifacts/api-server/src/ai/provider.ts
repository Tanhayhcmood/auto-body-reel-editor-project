const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const MAX_GEMINI_REQUEST_ATTEMPTS = 3;
const INITIAL_GEMINI_RETRY_DELAY_MS = 1_000;
const MAX_GEMINI_RETRY_DELAY_MS = 5_000;
const RETRYABLE_GEMINI_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_INLINE_MEDIA_BYTES = 14 * 1024 * 1024;
const MAX_MULTIMODAL_INPUTS = 48;

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateText(prompt: string): Promise<string>;
  generateMultimodal(
    prompt: string,
    inputs: GeminiMultimodalInput[],
  ): Promise<string>;
}

interface GeminiMediaInput {
  label: string;
  data: Uint8Array;
}

export interface GeminiImageInput {
  label: GeminiMediaInput["label"];
  mimeType: "image/jpeg";
  data: Uint8Array;
}

export interface GeminiAudioInput {
  label: GeminiMediaInput["label"];
  mimeType: "audio/mp3";
  data: Uint8Array;
}

export type GeminiMultimodalInput = GeminiImageInput | GeminiAudioInput;

export interface GeminiProviderOptions {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GeminiAPIError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly upstreamMessage?: string,
    readonly statusCode?: number,
    retryable = statusCode !== undefined && RETRYABLE_GEMINI_STATUS_CODES.has(statusCode),
  ) {
    super(message);
    this.name = "GeminiAPIError";
    this.retryable = retryable;
  }
}

type Environment = Record<string, string | undefined>;

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface GeminiErrorResponse {
  error?: {
    message?: unknown;
  };
}

function sanitizeGeminiErrorMessage(message: string): string {
  return message
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function readGeminiErrorMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as GeminiErrorResponse;
    return typeof payload.error?.message === "string"
      ? sanitizeGeminiErrorMessage(payload.error.message)
      : undefined;
  } catch {
    return undefined;
  }
}

function getGeminiRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null = null,
): number {
  const retryAfter = retryAfterHeader?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_GEMINI_RETRY_DELAY_MS, seconds * 1_000);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        MAX_GEMINI_RETRY_DELAY_MS,
        Math.max(0, retryAt - Date.now()),
      );
    }
  }

  return Math.min(
    MAX_GEMINI_RETRY_DELAY_MS,
    INITIAL_GEMINI_RETRY_DELAY_MS * 2 ** (attempt - 1),
  );
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  constructor(
    readonly model: string,
    private readonly getApiKey: () => string | undefined = () =>
      process.env["GEMINI_API_KEY"],
    private readonly options: GeminiProviderOptions = {},
  ) {}

  async generateText(prompt: string): Promise<string> {
    return this.request([{ text: prompt }]);
  }

  async generateMultimodal(
    prompt: string,
    inputs: GeminiMultimodalInput[],
  ): Promise<string> {
    if (inputs.length === 0 || inputs.length > MAX_MULTIMODAL_INPUTS) {
      throw new Error(
        `Gemini requires between 1 and ${MAX_MULTIMODAL_INPUTS} media inputs per request.`,
      );
    }

    const totalMediaBytes = inputs.reduce(
      (total, input) => total + input.data.byteLength,
      0,
    );
    if (totalMediaBytes > MAX_INLINE_MEDIA_BYTES) {
      throw new Error("Gemini multimodal payload exceeds the safe request limit.");
    }

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const input of inputs) {
      parts.push({ text: input.label });
      parts.push({
        inline_data: {
          mime_type: input.mimeType,
          data: Buffer.from(input.data).toString("base64"),
        },
      });
    }

    return this.request(parts, {
      responseMimeType: "application/json",
      temperature: 0.15,
      maxOutputTokens: 8192,
    });
  }

  private waitForRetry(
    attempt: number,
    retryAfterHeader: string | null = null,
  ): Promise<void> {
    const milliseconds = getGeminiRetryDelayMs(attempt, retryAfterHeader);
    if (this.options.sleep) {
      return this.options.sleep(milliseconds);
    }
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async request(
    parts: Array<Record<string, unknown>>,
    generationConfig?: Record<string, unknown>,
  ): Promise<string> {
    const apiKey = this.getApiKey()?.trim();
    if (!apiKey) {
      throw new GeminiAPIError("GEMINI_API_KEY is not configured.");
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
    };
    if (generationConfig) {
      body["generationConfig"] = generationConfig;
    }

    let response: Response | undefined;
    const requestUrl =
      `${GEMINI_API_BASE_URL}/${encodeURIComponent(this.model)}:generateContent`;
    const requestOptions: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    };

    for (let attempt = 1; attempt <= MAX_GEMINI_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        response = await (this.options.fetcher ?? fetch)(requestUrl, requestOptions);
      } catch {
        if (attempt === MAX_GEMINI_REQUEST_ATTEMPTS) {
          throw new GeminiAPIError(
            "Gemini API could not be reached.",
            undefined,
            undefined,
            true,
          );
        }
        await this.waitForRetry(attempt);
        continue;
      }

      if (response.ok) {
        break;
      }

      const upstreamMessage = await readGeminiErrorMessage(response);
      if (
        attempt === MAX_GEMINI_REQUEST_ATTEMPTS ||
        !RETRYABLE_GEMINI_STATUS_CODES.has(response.status)
      ) {
        throw new GeminiAPIError(
          `Gemini API request failed with status ${response.status}.`,
          upstreamMessage,
          response.status,
        );
      }

      await this.waitForRetry(attempt, response.headers.get("retry-after"));
    }

    if (!response || !response.ok) {
      throw new GeminiAPIError("Gemini API did not return a successful response.");
    }

    let result: GeminiGenerateContentResponse;
    try {
      result = (await response.json()) as GeminiGenerateContentResponse;
    } catch {
      throw new GeminiAPIError("Gemini API returned invalid JSON.");
    }
    const text = result.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new GeminiAPIError("Gemini API returned no text.");
    }

    return text;
  }
}

export function createAIProvider(
  env: Environment = process.env,
): AIProvider {
  const provider = env["AI_PROVIDER"]?.trim().toLowerCase();
  if (provider !== "gemini") {
    throw new Error(
      `Unsupported AI_PROVIDER "${provider ?? ""}". Expected "gemini".`,
    );
  }

  const model = env["GEMINI_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL;
  return new GeminiProvider(model);
}