// Native Gemini generateContent compatibility endpoint (CPA parity).
// Mari's media vision lane POSTs {base}/{model}:generateContent with a
// google-native body (systemInstruction/contents/inlineData/fileData) and an
// x-goog-api-key header; this module maps it onto the antigravity lane.

function partsToOpenAiContent(parts) {
  const out = [];
  for (const part of parts ?? []) {
    if (typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part.inlineData?.data) {
      out.push({
        type: 'image_url',
        image_url: { url: `data:${part.inlineData.mimeType || 'application/octet-stream'};base64,${part.inlineData.data}` },
      });
    } else if (part.fileData?.fileUri) {
      // antigravity accepts google-native fileData parts (verified live:
      // a YouTube fileUri reached the backend and was analyzed) — carry it
      // through the OpenAI shape as a dedicated marker part.
      out.push({
        type: 'file_uri',
        fileUri: part.fileData.fileUri,
        mimeType: part.fileData.mimeType || null,
        ...(part.videoMetadata ? { videoMetadata: part.videoMetadata } : {}),
      });
    } else if (part.functionCall?.name) {
      // native tool flow is not used by the known caller; keep it lossless anyway
      out.push({ type: 'text', text: `[tool call ${part.functionCall.name}]` });
    }
  }
  return out;
}

/** native generateContent request body -> OpenAI chat body (model carried separately) */
export function geminiNativeToOpenAi(nativeBody, { model }) {
  const messages = [];
  const sys = nativeBody?.systemInstruction;
  if (sys && typeof sys === 'object') {
    const text = (Array.isArray(sys) ? sys : (sys.parts ?? []))
      .map((p) => p.text)
      .filter((t) => typeof t === 'string')
      .join('\n\n');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const content of nativeBody?.contents ?? []) {
    messages.push({
      role: content.role === 'model' ? 'assistant' : 'user',
      content: partsToOpenAiContent(content.parts),
    });
  }
  const cfg = nativeBody?.generationConfig ?? {};
  return {
    model,
    messages,
    max_tokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
    top_p: cfg.topP,
    stop: cfg.stopSequences,
  };
}

/** antigravity (google-native) response -> native generateContent response */
export function antigravityToGeminiNative(respJson) {
  const wrapper = respJson?.response ?? respJson;
  return wrapper; // candidates/usageMetadata/promptFeedback — already the native shape
}
