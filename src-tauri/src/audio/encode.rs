//! Speech to Opus (AUD-7): mono PCM, as it comes from the speech model, fed
//! a passage at a time into one Opus encoder at `audio.bitrate`, so a long
//! recording is only ever held as its packets; then the packets into WebM.

use super::webm::{webm_opus, Chapter, OpusTrack};
use opus_pure::{Application, OpusEncoder, OpusHead, MAX_PACKET_BYTES};

type Result<T> = std::result::Result<T, String>;

/// The rate recordings are encoded at: the speech model's own.
pub const SAMPLE_RATE: u32 = 24_000;
// Spec: AUD-7
/// `audio.bitrate` in the spec.
pub const BITRATE_KBPS: i32 = 24;
/// 20 ms frames.
const FRAME_MS: u64 = 20;

/// PCM resampled to `SAMPLE_RATE` (linearly: speech, already band-limited).
pub fn resample(pcm: &[i16], from: u32) -> Vec<i16> {
    if from == SAMPLE_RATE || pcm.is_empty() {
        return pcm.to_vec();
    }
    let n = (pcm.len() as u64 * u64::from(SAMPLE_RATE) / u64::from(from)) as usize;
    (0..n)
        .map(|i| {
            let x = i as f64 * f64::from(from) / f64::from(SAMPLE_RATE);
            let j = x.floor() as usize;
            let a = f64::from(pcm[j.min(pcm.len() - 1)]);
            let b = f64::from(pcm[(j + 1).min(pcm.len() - 1)]);
            (a + (b - a) * (x - j as f64)).round() as i16
        })
        .collect()
}

/// An Opus stream being written, a passage at a time.
pub struct OpusStream {
    encoder: OpusEncoder,
    pre_skip: u16,
    pending: Vec<i16>,
    packets: Vec<Vec<u8>>,
    /// Samples of real audio taken in.
    samples: u64,
    chapters: Vec<Chapter>,
}

impl OpusStream {
    pub fn new() -> Result<OpusStream> {
        let mut encoder = OpusEncoder::new(SAMPLE_RATE as i32, 1, Application::Voip).map_err(|e| e.to_string())?;
        encoder.bitrate_bps = BITRATE_KBPS * 1000;
        let pre_skip = OpusHead::for_encoder(&encoder, SAMPLE_RATE).pre_skip;
        Ok(OpusStream { encoder, pre_skip, pending: Vec::new(), packets: Vec::new(), samples: 0, chapters: Vec::new() })
    }

    /// Seconds of audio taken in so far.
    pub fn seconds(&self) -> f64 {
        self.samples as f64 / f64::from(SAMPLE_RATE)
    }

    /// A chapter starts here. (Recordings are made a passage at a time now,
    /// so their chapters are the app's; the browser checks' fixture keeps them.)
    #[cfg(test)]
    pub fn chapter(&mut self, title: &str) {
        self.chapters.push(Chapter { title: title.to_string(), start_ms: self.samples * 1000 / u64::from(SAMPLE_RATE) });
    }

    fn frame(&self) -> usize {
        (SAMPLE_RATE / 50) as usize
    }

    fn encode_pending(&mut self) -> Result<()> {
        let frame = self.frame();
        let mut out = vec![0u8; MAX_PACKET_BYTES];
        let mut at = 0;
        while self.pending.len() - at >= frame {
            let n = self.encoder.encode_s16(&self.pending[at..at + frame], frame, &mut out).map_err(|e| e.to_string())?;
            self.packets.push(out[..n].to_vec());
            at += frame;
        }
        self.pending.drain(..at);
        Ok(())
    }

    /// Speech at `SAMPLE_RATE`.
    pub fn push(&mut self, pcm: &[i16]) -> Result<()> {
        self.samples += pcm.len() as u64;
        self.pending.extend_from_slice(pcm);
        self.encode_pending()
    }

    pub fn silence(&mut self, seconds: f64) -> Result<()> {
        let n = (seconds * f64::from(SAMPLE_RATE)) as usize;
        self.push(&vec![0; n])
    }

    /// The finished file: what's left flushed through the encoder's delay, as WebM.
    pub fn finish(mut self, title: &str) -> Result<(Vec<u8>, f64, Vec<Chapter>)> {
        let duration = self.seconds();
        // Enough silence to flush the encoder's delay, then whole frames.
        let ticks = 48_000 / SAMPLE_RATE as usize;
        let flush = (self.pre_skip as usize).div_ceil(ticks);
        let frame = self.frame();
        let tail = (self.pending.len() + flush).div_ceil(frame) * frame - self.pending.len();
        self.pending.extend(std::iter::repeat_n(0, tail));
        self.encode_pending()?;
        let track = OpusTrack {
            packets: &self.packets,
            frame_ms: FRAME_MS,
            pre_skip: self.pre_skip,
            channels: 1,
            input_rate: SAMPLE_RATE,
            duration_ms: duration * 1000.0,
        };
        Ok((webm_opus(&track, title, &self.chapters), duration, self.chapters))
    }
}

#[cfg(test)]
mod tests {
    use super::super::webm::read::{children, element};
    use super::*;
    use opus_pure::OpusDecoder;

    /// A second of something speech-like: a few tones, rising and falling.
    fn tone(seconds: f64) -> Vec<i16> {
        let n = (seconds * f64::from(SAMPLE_RATE)) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / f64::from(SAMPLE_RATE);
                let f = 180.0 + 60.0 * (t * 3.0).sin();
                ((t * f * std::f64::consts::TAU).sin() * 8000.0 + (t * 2.0 * f * std::f64::consts::TAU).sin() * 3000.0) as i16
            })
            .collect()
    }

    #[test]
    fn resampling_keeps_the_duration() {
        let pcm = vec![0i16; 44_100];
        assert_eq!(resample(&pcm, 44_100).len(), 24_000);
        assert_eq!(resample(&[1, 2, 3], 24_000), vec![1, 2, 3]);
    }

    #[test]
    fn speech_in_opus_in_webm_decodes_back_to_its_length() {
        let mut s = OpusStream::new().unwrap();
        s.chapter("Introduction");
        s.push(&tone(1.5)).unwrap();
        s.silence(0.5).unwrap();
        s.chapter("Model");
        s.push(&tone(1.0)).unwrap();
        let (webm, seconds, chapters) = s.finish("Test").unwrap();
        assert!((seconds - 3.0).abs() < 0.001);
        assert_eq!(chapters.iter().map(|c| c.start_ms).collect::<Vec<_>>(), vec![0, 2000]);
        // Around 24 kbit/s: 3 s is about 9 KB.
        assert!(webm.len() < 16_000, "{} bytes", webm.len());

        // Every block decodes, to at least the audio that went in.
        let (_, d, l) = element(&webm, 0).unwrap();
        let (_, sd, sl) = element(&webm, d + l).unwrap();
        let mut decoder = OpusDecoder::new(48_000, 1).unwrap();
        let mut out = vec![0f32; 5760];
        let mut decoded = 0usize;
        for (id, cd, cl) in children(&webm, sd, sd + sl) {
            if id != 0x1F43_B675 {
                continue;
            }
            for (bid, bd, bl) in children(&webm, cd, cd + cl) {
                if bid == 0xA3 {
                    decoded += decoder.decode(&webm[bd + 4..bd + bl], 5760, &mut out).unwrap();
                }
            }
        }
        assert!(decoded >= 3 * 48_000, "{decoded} samples at 48 kHz");
        assert!(decoded < 3 * 48_000 + 48_000 / 10);

        // The browser checks play this file (tests/browser/fixtures/speech.webm).
        if let Ok(path) = std::env::var("WRITE_SPEECH_FIXTURE") {
            std::fs::write(path, &webm).unwrap();
        }
    }
}
