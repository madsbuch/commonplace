//! Speaking a passage (AUD-5): OpenRouter's speech endpoint, with the
//! author's key, asking for raw PCM, which comes back as `audio/pcm;rate=…`
//! (or a WAV). As learn-polish found, the model is told to say exactly the
//! passage and nothing else: bare text can be taken as a cue.

use serde_json::{json, Value};
use tauri_plugin_http::reqwest;

type Result<T> = std::result::Result<T, String>;

pub const SPEECH_URL: &str = "https://openrouter.ai/api/v1/audio/speech";

/// Speech as it came: mono 16-bit samples at `rate`.
#[derive(Debug, PartialEq)]
pub struct Speech {
    pub rate: u32,
    pub pcm: Vec<i16>,
}

// Spec: AUD-3, AUD-5
/// What the speech model is given: the passage, with how to read it.
pub fn speech_input(text: &str) -> String {
    format!(
        "Read the following passage from a scientific text aloud, as a calm and clear narrator would. Say exactly this and nothing else:\n\n{text}"
    )
}

/// The value of `name=` in a content type's parameters.
fn param(content_type: &str, name: &str) -> Option<u32> {
    content_type.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| k.trim().eq_ignore_ascii_case(name)).and_then(|(_, v)| v.trim().parse().ok())
}

fn mono(samples: Vec<i16>, channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return samples;
    }
    samples.chunks(channels).map(|c| (c.iter().map(|&s| i32::from(s)).sum::<i32>() / channels as i32) as i16).collect()
}

fn wav(body: &[u8]) -> Result<Speech> {
    if body.len() < 12 || &body[8..12] != b"WAVE" {
        return Err("the speech model sent a WAV file that isn't one".into());
    }
    let (mut channels, mut rate, mut bits) = (1usize, 24_000u32, 16u16);
    let mut at = 12;
    while at + 8 <= body.len() {
        let id = &body[at..at + 4];
        let len = u32::from_le_bytes([body[at + 4], body[at + 5], body[at + 6], body[at + 7]]) as usize;
        let data = &body[at + 8..(at + 8 + len).min(body.len())];
        if id == b"fmt " && data.len() >= 16 {
            channels = usize::from(u16::from_le_bytes([data[2], data[3]]));
            rate = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
            bits = u16::from_le_bytes([data[14], data[15]]);
        } else if id == b"data" {
            if bits != 16 {
                return Err(format!("the speech model sent {bits}-bit audio, not 16-bit"));
            }
            let samples = data.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
            return Ok(Speech { rate, pcm: mono(samples, channels) });
        }
        at += 8 + len + (len & 1);
    }
    Err("the speech model's WAV has no audio".into())
}

/// The audio in a response, whatever form it came in.
pub fn parse_audio(content_type: &str, body: &[u8]) -> Result<Speech> {
    if body.starts_with(b"RIFF") {
        return wav(body);
    }
    let ct = content_type.to_ascii_lowercase();
    let rate = param(&ct, "rate").unwrap_or(24_000);
    let channels = param(&ct, "channels").unwrap_or(1) as usize;
    // L16 is network order (RFC 3551); the rest is little-endian, as Gemini sends it.
    let big = ct.starts_with("audio/l16");
    if ct.starts_with("audio/pcm") || big || ct.contains("octet-stream") {
        let samples = body.chunks_exact(2).map(|b| if big { i16::from_be_bytes([b[0], b[1]]) } else { i16::from_le_bytes([b[0], b[1]]) }).collect();
        return Ok(Speech { rate, pcm: mono(samples, channels) });
    }
    Err(format!("the speech model sent {content_type}, not the PCM asked for"))
}

// Spec: AUD-5
/// One passage, spoken.
pub async fn speak(client: &reqwest::Client, key: &str, model: &str, voice: &str, text: &str) -> Result<Speech> {
    let body = json!({ "model": model, "input": speech_input(text), "voice": voice, "response_format": "pcm" });
    let res = client
        .post(SPEECH_URL)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://github.com/madsbuch/my-book")
        .header("X-Title", "Commonplace")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("couldn't reach OpenRouter: {e}"))?;
    let status = res.status();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
        return Err(format!("OpenRouter said {status}: {message}"));
    }
    parse_audio(&content_type, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_as_gemini_sends_it() {
        let body: Vec<u8> = [1i16, -2, 300].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(parse_audio("audio/pcm;rate=24000;channels=1", &body).unwrap(), Speech { rate: 24_000, pcm: vec![1, -2, 300] });
        assert_eq!(parse_audio("audio/pcm; rate=16000", &body).unwrap().rate, 16_000);
        let be: Vec<u8> = [1i16, -2].iter().flat_map(|s| s.to_be_bytes()).collect();
        assert_eq!(parse_audio("audio/L16;rate=24000", &be).unwrap().pcm, vec![1, -2]);
    }

    #[test]
    fn a_wav_in_stereo_comes_out_mono() {
        let samples: Vec<u8> = [100i16, 300, -100, -300].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut w = b"RIFF\0\0\0\0WAVE".to_vec();
        w.extend(b"fmt ");
        w.extend(16u32.to_le_bytes());
        w.extend(1u16.to_le_bytes());
        w.extend(2u16.to_le_bytes());
        w.extend(22_050u32.to_le_bytes());
        w.extend((22_050u32 * 4).to_le_bytes());
        w.extend(4u16.to_le_bytes());
        w.extend(16u16.to_le_bytes());
        w.extend(b"data");
        w.extend((samples.len() as u32).to_le_bytes());
        w.extend(&samples);
        assert_eq!(parse_audio("audio/wav", &w).unwrap(), Speech { rate: 22_050, pcm: vec![200, -200] });
    }

    #[test]
    fn mp3_isnt_taken_for_pcm() {
        assert!(parse_audio("audio/mpeg", b"ID3...").is_err());
    }

    #[test]
    fn the_model_is_told_to_say_only_the_passage() {
        let input = speech_input("Attention is all you need.");
        assert!(input.ends_with("\n\nAttention is all you need."));
        assert!(input.contains("Say exactly this and nothing else"));
    }
}
