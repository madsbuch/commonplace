import { describe, expect, test } from "bun:test";
import { contentToText, emptyStreamState, foldChunk, isTextModel, promptPricePerMillion, splitSse, usageOf } from "../src/lib/openrouter";
import { parseChatChunk, parseChatResponse, parseModelList, parseModelsResponse } from "../src/lib/schemas";

describe("server-sent events", () => {
  test("complete events are cut out; the rest waits", () => {
    const { data, rest } = splitSse('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    expect(data).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  test("comments and [DONE] are dropped, CRLF is fine", () => {
    const { data, rest } = splitSse(': OPENROUTER PROCESSING\r\n\r\ndata: {"x":1}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(data).toEqual(['{"x":1}']);
    expect(rest).toBe("");
  });

  test("a payload split over data lines is joined", () => {
    expect(splitSse("data: {\"a\":\ndata: 1}\n\n").data).toEqual(['{"a":\n1}']);
  });
});

// Spec: AI-3
describe("a streamed answer", () => {
  const chunks = [
    '{"model":"anthropic/claude-sonnet-5.5","choices":[{"delta":{"content":"Why "}}]}',
    '{"choices":[{"delta":{"content":"does "}}]}',
    '{"choices":[{"delta":{"content":"it hold?"},"finish_reason":"stop"}]}',
    '{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":40,"cost":0.0042}}',
  ];

  test("folds into the text, the model and the reported cost", () => {
    let state = emptyStreamState();
    for (const c of chunks) {
      const parsed = parseChatChunk(c);
      if (parsed) state = foldChunk(state, parsed);
    }
    expect(state.text).toBe("Why does it hold?");
    expect(state.model).toBe("anthropic/claude-sonnet-5.5");
    expect(state.finishReason).toBe("stop");
    expect(state.usage).toEqual({ promptTokens: 1200, completionTokens: 40, costUsd: 0.0042 });
    expect(state.error).toBeNull();
  });

  test("an error mid-stream is kept", () => {
    const parsed = parseChatChunk('{"error":{"message":"Provider overloaded","code":502}}');
    expect(parsed).not.toBeNull();
    if (parsed) expect(foldChunk(emptyStreamState(), parsed).error).toBe("Provider overloaded");
  });

  test("a chunk that isn't JSON is skipped", () => {
    expect(parseChatChunk("not json")).toBeNull();
  });
});

describe("responses", () => {
  test("usage without a cost isn't logged", () => {
    expect(usageOf(parseChatResponse({ usage: { prompt_tokens: 10 } }))).toBeNull();
    expect(usageOf(parseChatResponse({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } }))).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      costUsd: 0,
    });
  });

  test("a malformed field doesn't sink the rest", () => {
    const r = parseChatResponse({ choices: [{ message: { content: "hi" } }], usage: "weird" });
    expect(contentToText(r.choices?.[0]?.message?.content)).toBe("hi");
    expect(r.usage).toBeUndefined();
  });

  test("an unrecognisable body parses as nothing", () => {
    expect(parseChatResponse("oops")).toEqual({});
  });

  test("content given as parts is flattened", () => {
    expect(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }, { other: 1 }])).toBe("ab");
  });
});

// Spec: AI-2
describe("the model list", () => {
  test("keeps valid models, drops the rest", () => {
    const models = parseModelsResponse({
      data: [
        { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", pricing: { prompt: "0.000003" }, context_length: 200000 },
        { name: "no id" },
        { id: "x/image", name: "Image model", architecture: { output_modalities: ["image"] } },
      ],
    });
    expect(models?.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5", "x/image"]);
    const [sonnet, image] = models ?? [];
    expect(sonnet && promptPricePerMillion(sonnet)).toBeCloseTo(3, 6);
    expect(sonnet && isTextModel(sonnet)).toBe(true);
    expect(image && isTextModel(image)).toBe(false);
  });

  test("an unexpected envelope is null", () => {
    expect(parseModelsResponse({ models: [] })).toBeNull();
    expect(parseModelList("nope")).toBeNull();
  });

  test("variable pricing is unknown", () => {
    const [m] = parseModelList([{ id: "a/b", name: "B", pricing: { prompt: "-1" } }]) ?? [];
    expect(m && promptPricePerMillion(m)).toBeNull();
  });
});
