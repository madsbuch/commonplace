//! What a recording is made of, without I/O (AUD-6): its script (chapters
//! of chunks, each chunk's passages written as it's needed), the pieces it's
//! spoken in (one per passage, `<recording>.<chapter>.<chunk>.<passage>`),
//! and what to make next, `audio.lead` ahead of the listener or all of it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Spec: AUD-6
/// `audio.lead` in the spec: how far ahead of the listener a recording is made.
pub const LEAD_SECONDS: f64 = 180.0;
/// A passage the speech model is given at once: long enough to sound whole,
/// short enough to come back quickly (as the app's `MAX_PASSAGE`).
pub const MAX_PASSAGE: usize = 900;
/// How fast a passage is read, before any is: for how long one not yet made will take.
pub const CHARS_PER_SECOND: f64 = 15.0;
/// Silence before the first passage, after a passage, and after a chapter's last.
pub const LEAD_IN: f64 = 0.4;
pub const BETWEEN_PARAGRAPHS: f64 = 0.45;
pub const BETWEEN_CHAPTERS: f64 = 1.2;

/// A recording's script, as the app writes it (src/lib/audio.ts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Script {
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chapter {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks: Option<Vec<Chunk>>,
    /// A recording made before: its chapter's passages, written at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraphs: Option<Vec<String>>,
}

/// Source text the script model is given at once, and what it wrote of it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chunk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// What's spoken, a piece each; null until written.
    pub passages: Option<Vec<String>>,
}

impl Chapter {
    /// Its chunks; a chapter made before is one chunk, already written.
    pub fn chunks(&self) -> Vec<Chunk> {
        match (&self.chunks, &self.paragraphs) {
            (Some(c), _) => c.clone(),
            (None, Some(p)) => vec![Chunk { source: None, passages: Some(p.clone()) }],
            (None, None) => Vec::new(),
        }
    }
}

/// Where a piece sits in its recording's script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PieceKey {
    pub chapter: usize,
    pub chunk: usize,
    pub passage: usize,
}

impl PieceKey {
    pub fn id(&self, recording: &str) -> String {
        format!("{recording}.{}.{}.{}", self.chapter, self.chunk, self.passage)
    }

    /// The key in a piece's id, if it's one of `recording`'s.
    pub fn parse(id: &str, recording: &str) -> Option<PieceKey> {
        let rest = id.strip_prefix(recording)?.strip_prefix('.')?;
        let mut n = rest.split('.').map(|x| x.parse::<usize>().ok());
        let key = PieceKey { chapter: n.next()??, chunk: n.next()??, passage: n.next()?? };
        n.next().is_none().then_some(key)
    }
}

/// The recording a piece's id belongs to: all before its last three parts.
pub fn recording_of(piece: &str) -> Option<&str> {
    let mut parts = piece.rsplitn(4, '.');
    let (p, k, c, rec) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    [p, k, c].iter().all(|x| x.parse::<usize>().is_ok()).then_some(rec)
}

/// A place in the recording: a passage to speak, or a chunk not yet written.
#[derive(Debug, Clone, PartialEq)]
pub enum Slot {
    Piece { key: PieceKey, text: String, first: bool, pause: f64 },
    Unwritten { chapter: usize, chunk: usize, chars: usize },
}

impl Slot {
    fn chars(&self) -> usize {
        match self {
            Slot::Piece { text, .. } => text.chars().count(),
            Slot::Unwritten { chars, .. } => *chars,
        }
    }

    fn is_at(&self, at: &PieceKey) -> bool {
        match self {
            Slot::Piece { key, .. } => key == at,
            Slot::Unwritten { chapter, chunk, .. } => *chapter == at.chapter && *chunk == at.chunk,
        }
    }
}

// Spec: AUD-6
/// The recording in order: every passage, and every chunk not yet written.
pub fn slots(script: &Script) -> Vec<Slot> {
    let mut out = Vec::new();
    let chapters = script.chapters.len();
    for (c, chapter) in script.chapters.iter().enumerate() {
        let chunks = chapter.chunks();
        let last_chunk = chunks.len().saturating_sub(1);
        for (k, chunk) in chunks.iter().enumerate() {
            match &chunk.passages {
                None => out.push(Slot::Unwritten { chapter: c, chunk: k, chars: chunk.source.as_deref().map_or(0, |s| s.chars().count()) }),
                Some(passages) => {
                    let spoken: Vec<(usize, &String)> = passages.iter().enumerate().filter(|(_, p)| !p.trim().is_empty()).collect();
                    for (n, (p, text)) in spoken.iter().enumerate() {
                        let ends_chapter = k == last_chunk && n + 1 == spoken.len();
                        out.push(Slot::Piece {
                            key: PieceKey { chapter: c, chunk: k, passage: *p },
                            text: (*text).clone(),
                            first: out.is_empty(),
                            pause: if ends_chapter && c + 1 < chapters { BETWEEN_CHAPTERS } else { BETWEEN_PARAGRAPHS },
                        });
                    }
                }
            }
        }
    }
    out
}

/// What to make next.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    /// Write this chunk's passages first.
    Write { chapter: usize, chunk: usize },
    /// Speak these passages (a few at once).
    Speak(Vec<PieceKey>),
    /// Everything wanted is made.
    Nothing,
}

/// How fast this recording is read, from what's made: characters a second.
pub fn pace(slots: &[Slot], made: &HashMap<PieceKey, f64>) -> f64 {
    let (chars, secs) = slots.iter().fold((0usize, 0.0f64), |(c, s), slot| match slot {
        Slot::Piece { key, text, .. } => made.get(key).map_or((c, s), |sec| (c + text.chars().count(), s + sec)),
        Slot::Unwritten { .. } => (c, s),
    });
    if chars > 0 && secs > 1.0 {
        chars as f64 / secs
    } else {
        CHARS_PER_SECOND
    }
}

// Spec: AUD-6, AUD-13
/**
 * What to make next: from `from` (where the listener is; the start if
 * unknown), the first thing not made within `lead` seconds (all of it when
 * `lead` is None). Passages are spoken up to `at_once` together; a chunk
 * not yet written is written first.
 */
pub fn next(slots: &[Slot], made: &HashMap<PieceKey, f64>, from: Option<&PieceKey>, lead: Option<f64>, at_once: usize) -> Next {
    let start = from.and_then(|f| slots.iter().position(|s| s.is_at(f))).unwrap_or(0);
    let pace = pace(slots, made);
    let mut ahead = 0.0;
    let mut speak = Vec::new();
    for slot in &slots[start..] {
        if lead.is_some_and(|l| ahead >= l) {
            break;
        }
        match slot {
            Slot::Unwritten { chapter, chunk, .. } => {
                if speak.is_empty() {
                    return Next::Write { chapter: *chapter, chunk: *chunk };
                }
                break;
            }
            Slot::Piece { key, .. } => match made.get(key) {
                Some(sec) => ahead += sec,
                None => {
                    speak.push(*key);
                    if speak.len() >= at_once {
                        break;
                    }
                    ahead += slot.chars() as f64 / pace;
                }
            },
        }
    }
    if speak.is_empty() {
        Next::Nothing
    } else {
        Next::Speak(speak)
    }
}

/// Whether every passage of the recording is made.
pub fn complete(slots: &[Slot], made: &HashMap<PieceKey, f64>) -> bool {
    slots.iter().all(|s| matches!(s, Slot::Piece { key, .. } if made.contains_key(key)))
}

/// How much of the recording is made, by its text: 0 to 1.
pub fn progress(slots: &[Slot], made: &HashMap<PieceKey, f64>) -> f64 {
    let total: usize = slots.iter().map(Slot::chars).sum();
    let done: usize = slots.iter().filter(|s| matches!(s, Slot::Piece { key, .. } if made.contains_key(key))).map(Slot::chars).sum();
    if total == 0 {
        1.0
    } else {
        done as f64 / total as f64
    }
}

/// The made pieces that follow `after` without a gap: what a player's queue can take on.
pub fn run_after(slots: &[Slot], made: &HashMap<PieceKey, f64>, after: &PieceKey) -> Vec<PieceKey> {
    let Some(at) = slots.iter().position(|s| s.is_at(after)) else { return Vec::new() };
    slots[at + 1..]
        .iter()
        .map_while(|s| match s {
            Slot::Piece { key, .. } if made.contains_key(key) => Some(*key),
            _ => None,
        })
        .collect()
}

/// The made pieces without a gap around `at`, and where `at` is among them: a player's queue.
pub fn run_around(slots: &[Slot], made: &HashMap<PieceKey, f64>, at: &PieceKey) -> (Vec<PieceKey>, usize) {
    let Some(i) = slots.iter().position(|s| s.is_at(at)) else { return (Vec::new(), 0) };
    let is_made = |s: &Slot| matches!(s, Slot::Piece { key, .. } if made.contains_key(key));
    if !is_made(&slots[i]) {
        return (Vec::new(), 0);
    }
    let mut first = i;
    while first > 0 && is_made(&slots[first - 1]) {
        first -= 1;
    }
    let mut keys: Vec<PieceKey> = slots[first..=i]
        .iter()
        .filter_map(|s| match s {
            Slot::Piece { key, .. } => Some(*key),
            Slot::Unwritten { .. } => None,
        })
        .collect();
    keys.extend(run_after(slots, made, at));
    (keys, i - first)
}

// Spec: AUD-6
/// Text cut where it reads naturally: at paragraphs, then sentences, then words (as the app's `cut`).
pub fn cut(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let len = |s: &str| s.chars().count();
    let push = |current: &mut String, out: &mut Vec<String>| {
        if !current.trim().is_empty() {
            out.push(current.trim().to_string());
        }
        current.clear();
    };
    for para in text.split("\n\n") {
        let p = para.split_whitespace().collect::<Vec<_>>().join(" ");
        if p.is_empty() {
            continue;
        }
        if len(&p) <= max {
            if !current.is_empty() && len(&current) + len(&p) + 2 > max {
                push(&mut current, &mut out);
            }
            if current.is_empty() {
                current = p;
            } else {
                current = format!("{current}\n\n{p}");
            }
            continue;
        }
        push(&mut current, &mut out);
        for s in sentences(&p) {
            if len(&s) > max {
                push(&mut current, &mut out);
                for w in s.split(' ') {
                    if len(&current) + len(w) + 1 > max {
                        push(&mut current, &mut out);
                    }
                    if current.is_empty() {
                        current = w.to_string();
                    } else {
                        current = format!("{current} {w}");
                    }
                }
                continue;
            }
            if len(&current) + len(&s) > max {
                push(&mut current, &mut out);
            }
            current.push_str(&s);
        }
        push(&mut current, &mut out);
    }
    push(&mut current, &mut out);
    out
}

/// A paragraph's sentences, each with the space after it.
fn sentences(p: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = p.chars().peekable();
    while let Some(ch) = chars.next() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?') {
            while let Some(&n) = chars.peek() {
                if matches!(n, '.' | '!' | '?' | '"' | '\'' | ')' | ']') {
                    current.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            while let Some(&n) = chars.peek() {
                if n.is_whitespace() {
                    current.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

// Spec: AUD-6
/// What the speech model is given: one paragraph at a time, long ones cut at sentences.
pub fn passages(paragraphs: &[String]) -> Vec<String> {
    paragraphs.iter().flat_map(|p| cut(p, MAX_PASSAGE).into_iter().flat_map(|c| c.split("\n\n").map(str::to_string).collect::<Vec<_>>())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(json: &str) -> Script {
        serde_json::from_str(json).unwrap()
    }

    fn pk(c: usize, k: usize, p: usize) -> PieceKey {
        PieceKey { chapter: c, chunk: k, passage: p }
    }

    const TWO_CHAPTERS: &str = r#"{"chapters":[
        {"title":"One","chunks":[{"source":"a","passages":["First.","Second."]},{"source":"b","passages":null}]},
        {"title":"Two","chunks":[{"source":"c","passages":["Third."]}]}]}"#;

    #[test]
    fn a_piece_is_named_by_its_recording_and_place() {
        let k = pk(2, 0, 7);
        assert_eq!(k.id("recordings_01abc"), "recordings_01abc.2.0.7");
        assert_eq!(PieceKey::parse("recordings_01abc.2.0.7", "recordings_01abc"), Some(k));
        assert_eq!(PieceKey::parse("recordings_01abc.2.0", "recordings_01abc"), None);
        assert_eq!(PieceKey::parse("recordings_02xyz.2.0.7", "recordings_01abc"), None);
        assert_eq!(recording_of("recordings_01abc.2.0.7"), Some("recordings_01abc"));
        assert_eq!(recording_of("recordings_01abc"), None);
    }

    #[test]
    fn scripts_made_before_read_as_one_written_chunk_a_chapter() {
        let s = script(r#"{"chapters":[{"title":"1 Introduction","paragraphs":["One.","Two."]}]}"#);
        let slots = slots(&s);
        assert_eq!(slots.len(), 2);
        assert!(matches!(&slots[0], Slot::Piece { key, first: true, .. } if *key == pk(0, 0, 0)));
    }

    #[test]
    fn the_recording_is_its_passages_in_order_and_its_chunks_not_yet_written() {
        let s = script(TWO_CHAPTERS);
        let slots = slots(&s);
        assert_eq!(slots.len(), 4);
        assert!(matches!(&slots[0], Slot::Piece { first: true, pause, .. } if *pause == BETWEEN_PARAGRAPHS));
        assert!(matches!(&slots[2], Slot::Unwritten { chapter: 0, chunk: 1, chars: 1 }));
        // The last of the recording pauses as a paragraph does; not a chapter.
        assert!(matches!(&slots[3], Slot::Piece { key, first: false, pause, .. } if *key == pk(1, 0, 0) && *pause == BETWEEN_PARAGRAPHS));
        // Written, a chapter's last passage pauses for the chapter.
        let mut s = s;
        if let Some(chunks) = s.chapters[0].chunks.as_mut() {
            chunks[1].passages = Some(vec!["Fourth.".into()]);
        }
        assert!(matches!(&slots_of(&s)[2], Slot::Piece { pause, .. } if *pause == BETWEEN_CHAPTERS));
    }

    fn slots_of(s: &Script) -> Vec<Slot> {
        slots(s)
    }

    #[test]
    fn what_comes_next_is_the_first_thing_not_made_within_the_lead() {
        let slots = slots(&script(TWO_CHAPTERS));
        let mut made = HashMap::new();
        assert_eq!(next(&slots, &made, None, Some(LEAD_SECONDS), 3), Next::Speak(vec![pk(0, 0, 0), pk(0, 0, 1)]));
        made.insert(pk(0, 0, 0), 10.0);
        made.insert(pk(0, 0, 1), 10.0);
        assert_eq!(next(&slots, &made, None, Some(LEAD_SECONDS), 3), Next::Write { chapter: 0, chunk: 1 });
        // Within a short lead, what's made is enough.
        assert_eq!(next(&slots, &made, None, Some(15.0), 3), Next::Nothing);
        // From further on, further on is made.
        assert_eq!(next(&slots, &made, Some(&pk(1, 0, 0)), Some(LEAD_SECONDS), 3), Next::Speak(vec![pk(1, 0, 0)]));
        // Skipping to a chunk not yet written writes it.
        assert_eq!(next(&slots, &made, Some(&pk(0, 1, 0)), Some(5.0), 3), Next::Write { chapter: 0, chunk: 1 });
        // All of it: everything, from the start.
        made.insert(pk(1, 0, 0), 3.0);
        assert_eq!(next(&slots, &made, Some(&pk(1, 0, 0)), None, 3), Next::Nothing);
        assert_eq!(next(&slots, &made, None, None, 3), Next::Write { chapter: 0, chunk: 1 });
        assert!(!complete(&slots, &made));
        // "First." "Second." and "Third." made, of those and one character not yet written.
        assert!((progress(&slots, &made) - 19.0 / 20.0).abs() < 1e-9);
    }

    #[test]
    fn at_most_so_many_passages_are_spoken_at_once() {
        let s = script(r#"{"chapters":[{"title":"A","chunks":[{"passages":["1.","2.","3.","4.","5."]}]}]}"#);
        let slots = slots(&s);
        assert_eq!(next(&slots, &HashMap::new(), None, None, 3), Next::Speak(vec![pk(0, 0, 0), pk(0, 0, 1), pk(0, 0, 2)]));
    }

    #[test]
    fn the_lead_is_counted_in_seconds_of_listening() {
        // Ten passages of 150 characters: ten seconds each before any is made.
        let p: Vec<String> = (0..10).map(|i| format!("{i}{}", "x".repeat(149))).collect();
        let s = Script { chapters: vec![Chapter { title: "A".into(), chunks: Some(vec![Chunk { source: None, passages: Some(p) }]), paragraphs: None }] };
        let slots = slots(&s);
        let mut made = HashMap::new();
        for i in 0..3 {
            made.insert(pk(0, 0, i), 10.0);
        }
        // 30 s made; a lead of 45 s wants two more.
        assert_eq!(next(&slots, &made, None, Some(45.0), 5), Next::Speak(vec![pk(0, 0, 3), pk(0, 0, 4)]));
        assert_eq!(next(&slots, &made, None, Some(25.0), 5), Next::Nothing);
    }

    #[test]
    fn a_queue_is_the_run_of_made_pieces_around_where_it_plays() {
        let slots = slots(&script(TWO_CHAPTERS));
        let mut made = HashMap::new();
        made.insert(pk(0, 0, 0), 1.0);
        made.insert(pk(0, 0, 1), 1.0);
        made.insert(pk(1, 0, 0), 1.0);
        assert_eq!(run_around(&slots, &made, &pk(0, 0, 1)), (vec![pk(0, 0, 0), pk(0, 0, 1)], 1));
        // Not across a chunk not yet written.
        assert_eq!(run_after(&slots, &made, &pk(0, 0, 1)), vec![]);
        assert_eq!(run_after(&slots, &made, &pk(0, 0, 0)), vec![pk(0, 0, 1)]);
        assert_eq!(run_around(&slots, &made, &pk(1, 0, 0)), (vec![pk(1, 0, 0)], 0));
        assert_eq!(run_around(&slots, &HashMap::new(), &pk(0, 0, 0)), (vec![], 0));
    }

    #[test]
    fn pace_comes_from_what_is_made() {
        let slots = slots(&script(r#"{"chapters":[{"title":"A","chunks":[{"passages":["0123456789"]}]}]}"#));
        assert_eq!(pace(&slots, &HashMap::new()), CHARS_PER_SECOND);
        let mut made = HashMap::new();
        made.insert(pk(0, 0, 0), 2.0);
        assert_eq!(pace(&slots, &made), 5.0);
    }

    #[test]
    fn text_is_cut_at_paragraphs_then_sentences_then_words() {
        assert_eq!(cut("One.\n\nTwo.", 100), vec!["One.\n\nTwo."]);
        assert_eq!(cut("One.\n\nTwo.", 6), vec!["One.", "Two."]);
        assert_eq!(cut("First sentence. Second one here.", 20), vec!["First sentence.", "Second one here."]);
        let long = "word ".repeat(30);
        assert!(cut(&long, 20).iter().all(|c| c.chars().count() <= 20));
        let p = passages(&["A short one.".to_string(), format!("{} And more.", "Long sentence here. ".repeat(60))]);
        assert_eq!(p[0], "A short one.");
        assert!(p.len() > 2 && p.iter().all(|x| x.chars().count() <= MAX_PASSAGE));
    }

    #[test]
    fn a_script_written_back_keeps_what_the_app_wrote() {
        let s = script(TWO_CHAPTERS);
        let back: Script = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        assert!(serde_json::to_string(&s).unwrap().contains(r#""passages":null"#));
    }
}
