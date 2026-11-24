//! The audio library's audio (AUD-5 to AUD-7): passages spoken through
//! OpenRouter (speech.rs), Opus in WebM (encode.rs, webm.rs), and the job
//! that makes a recording's audio from its script (render.rs). Runs on every
//! device, phones included: it's pure Rust.

pub mod encode;
pub mod plan;
pub mod render;
pub mod script;
pub mod speech;
pub mod webm;
