const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const MAX_INLINE_IMAGE_BYTES = 14 * 1024 * 1024;
const MAX_MULTIMODAL_IMAGES = 48;

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateText(prompt: string): Promise<string>;
  generateJson(prompt: string): Promise<string>;
  generateMultimodal(
    prompt: string,
    images: GeminiImageInput[],
  ): Promise<string>;
}

export interface GeminiImageInput {
  label: string;
  mimeType: "image/jpeg";
  data: Uint8Array;
}

export class GeminiAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiAPIError";
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

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  constructor(
    readonly model: string,
    private readonly getApiKey: () => string | undefined = () =>
      process.env["GEMINI_API_KEY"],
  ) {}

  async generateText(prompt: string): Promise<string> {
    return this.request([{ text: prompt }]);
  }

  async generateJson(prompt: string): Promise<string> {
    return this.request([{ text: prompt }], {
      responseMimeType: "application/json",
      temperature: 0.25,
      maxOutputTokens: 8192,
    });
  }

  async generateMultimodal(
    prompt: string,
    images: GeminiImageInput[],
  ): Promise<string> {
    if (images.length === 0 || images.length > MAX_MULTIMODAL_IMAGES) {
      throw new Error(
        `Gemini Vision requires between 1 and ${MAX_MULTIMODAL_IMAGES} images per request.`,
      );
    }

    const totalImageBytes = images.reduce(
      (total, image) => total + image.data.byteLength,
      0,
    );
    if (totalImageBytes > MAX_INLINE_IMAGE_BYTES) {
      throw new Error("Gemini Vision image payload exceeds the safe request limit.");
    }

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const image of images) {
      parts.push({ text: image.label });
      parts.push({
        inline_data: {
          mime_type: image.mimeType,
          data: Buffer.from(image.data).toString("base64"),
        },
      });
    }

    return this.request(parts, {
      responseMimeType: "application/json",
      temperature: 0.15,
      maxOutputTokens: 8192,
    });
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

    let response: Response;
    try {
      response = await fetch(
        `${GEMINI_API_BASE_URL}/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new GeminiAPIError("Gemini API could not be reached.");
    }

    if (!response.ok) {
      throw new GeminiAPIError(
        `Gemini API request failed with status ${response.status}.`,
      );
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