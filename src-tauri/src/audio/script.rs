//! Writing a chunk of a recording's script (AUD-3, AUD-5, AUD-6): the source
//! text to the script model through OpenRouter, with the prompt in
//! `verbatim.md`, and the paragraphs to speak back as structured JSON. Done
//! here, not in the app, so a recording made as it's listened to carries on
//! with the app in the background on a phone, where the web view stops.

use super::speech::transient_status;
use serde_json::{json, Value};
use tauri_plugin_http::reqwest;

// Spec: AUD-3
/// What the script model is told: keep the prose, say the maths, drop the authors.
pub const VERBATIM_PROMPT: &str = include_str!("verbatim.md");
// Spec: AUD-5
/// `audio.script-model` in the spec.
pub const DEFAULT_SCRIPT_MODEL: &str = "anthropic/claude-haiku-5.5";
// Spec: AI-7
/// `ai.most-answer.audio-script` in the spec.
pub const MOST_ANSWER: u32 = 16_000;
const CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";

/// Why a chunk wasn't written, and whether trying again could help.
#[derive(Debug, PartialEq)]
pub struct WriteError {
    pub message: String,
    /// The network, a timeout, or the service busy: worth waiting for (WORK-4).
    pub transient: bool,
    /// The answer came back but couldn't be read: worth asking again once or twice.
    pub unusable: bool,
}

impl WriteError {
    fn lasting(message: String) -> Self {
        WriteError { message, transient: false, unusable: false }
    }
}

/// A chunk, written: its paragraphs to speak, and what writing it cost.
#[derive(Debug, PartialEq)]
pub struct Written {
    pub paragraphs: Vec<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost: f64,
}

/// The request: the prompt, the chunk, the answer's shape, and the most it may run to.
pub fn request(model: &str, source: &str) -> Value {
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": VERBATIM_PROMPT },
            { "role": "user", "content": source },
        ],
        "usage": { "include": true },
        // Spec: AI-7
        "max_tokens": MOST_ANSWER,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "spoken_passage",
                "strict": true,
                "schema": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["paragraphs"],
                    "properties": { "paragraphs": { "type": "array", "items": { "type": "string" } } },
                },
            },
        },
    })
}

/// A message's text, whether it came as a string or as parts.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

/// The paragraphs in an answer (forgivingly: a code fence around the JSON, numbers for text), or why there are none.
pub fn parse_answer(body: &Value) -> Result<Written, WriteError> {
    if let Some(message) = body.pointer("/error/message").and_then(Value::as_str) {
        return Err(WriteError::lasting(message.to_string()));
    }
    let choice = body.pointer("/choices/0").ok_or_else(|| WriteError { message: "the script model sent no answer".into(), transient: false, unusable: true })?;
    // Spec: AI-7
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err(WriteError::lasting(format!("The answer reached the most it may run to ({MOST_ANSWER} tokens) before it was done.")));
    }
    let text = text_of(choice.pointer("/message/content").unwrap_or(&Value::Null));
    let trimmed = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let answer: Value = serde_json::from_str(trimmed).map_err(|_| WriteError { message: "the script model's answer wasn't JSON".into(), transient: false, unusable: true })?;
    let paragraphs: Vec<String> = answer
        .get("paragraphs")
        .and_then(Value::as_array)
        .map(|ps| {
            ps.iter()
                .map(|p| match p {
                    Value::String(s) => s.trim().to_string(),
                    other => other.to_string(),
                })
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if paragraphs.is_empty() {
        return Err(WriteError { message: "the script model wrote nothing to read".into(), transient: false, unusable: true });
    }
    let usage = |name: &str| body.pointer(&format!("/usage/{name}"));
    Ok(Written {
        paragraphs,
        prompt_tokens: usage("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
        completion_tokens: usage("completion_tokens").and_then(Value::as_i64).unwrap_or(0),
        cost: usage("cost").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

// Spec: AUD-3, AUD-5
/// One chunk of source text, written to be spoken.
pub async fn write(client: &reqwest::Client, key: &str, model: &str, source: &str) -> Result<Written, WriteError> {
    let res = client
        .post(CHAT_URL)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://github.com/madsbuch/commonplace")
        .header("X-Title", "Commonplace")
        .body(request(model, source).to_string())
        .send()
        .await
        // Spec: WORK-4
        .map_err(|e| WriteError { message: format!("couldn't reach OpenRouter: {}", crate::diagnostics::chain(&e)), transient: true, unusable: false })?;
    let status = res.status().as_u16();
    let body = res
        .bytes()
        .await
        .map_err(|e| WriteError { message: format!("the script model's answer stopped arriving: {}", crate::diagnostics::chain(&e)), transient: true, unusable: false })?;
    let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = json.pointer("/error/message").and_then(Value::as_str).map_or_else(|| format!("OpenRouter answered {status}"), str::to_string);
        return Err(WriteError { message, transient: transient_status(status) || status == 425, unusable: false });
    }
    parse_answer(&json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value from one of the spec's files.
    fn spec_value(file: &str, id: &str) -> Value {
        let spec: Value = serde_json::from_str(file).unwrap();
        spec["values"].as_array().unwrap().iter().find(|v| v["id"] == id).unwrap()["value"].clone()
    }

    #[test]
    fn its_constants_are_the_specs() {
        assert_eq!(spec_value(include_str!("../../../.spec/ai.json"), "ai.most-answer.audio-script"), json!(MOST_ANSWER));
        assert_eq!(spec_value(include_str!("../../../.spec/library/audio.json"), "audio.script-model"), json!(DEFAULT_SCRIPT_MODEL));
    }

    #[test]
    fn the_model_is_told_to_keep_the_prose_and_say_the_maths() {
        let r = request("m", "2.1 Attention\n\nsoftmax");
        assert_eq!(r["messages"][0]["content"], VERBATIM_PROMPT);
        assert!(VERBATIM_PROMPT.contains("Keep every word of the prose exactly"));
        // Spec: AUD-3
        assert!(VERBATIM_PROMPT.contains("Drop what isn't read aloud: the authors' names, their institutions"));
        assert_eq!(r["max_tokens"], MOST_ANSWER);
        assert_eq!(r["response_format"]["json_schema"]["strict"], true);
    }

    #[test]
    fn an_answer_gives_its_paragraphs_and_what_it_cost() {
        let body = json!({ "choices": [{ "message": { "content": "```json\n{\"paragraphs\":[\" x squared. \",\"\",\"Next.\"]}\n```" }, "finish_reason": "stop" }], "usage": { "prompt_tokens": 900, "completion_tokens": 40, "cost": 0.0004 } });
        let w = parse_answer(&body).unwrap();
        assert_eq!(w.paragraphs, vec!["x squared.", "Next."]);
        assert_eq!((w.prompt_tokens, w.completion_tokens), (900, 40));
        assert!((w.cost - 0.0004).abs() < 1e-12);
    }

    #[test]
    fn an_answer_cut_off_or_unreadable_says_so() {
        let cut = json!({ "choices": [{ "message": { "content": "{\"paragraphs\":[\"x" }, "finish_reason": "length" }] });
        let e = parse_answer(&cut).unwrap_err();
        assert!(e.message.contains("most it may run to") && !e.unusable && !e.transient);
        let junk = json!({ "choices": [{ "message": { "content": "Sorry." }, "finish_reason": "stop" }] });
        assert!(parse_answer(&junk).unwrap_err().unusable);
        let empty = json!({ "choices": [{ "message": { "content": [{ "type": "text", "text": "{\"paragraphs\":[]}" }] } }] });
        assert!(parse_answer(&empty).unwrap_err().unusable);
        let refused = json!({ "error": { "message": "No credits" } });
        assert_eq!(parse_answer(&refused).unwrap_err().message, "No credits");
    }
}
