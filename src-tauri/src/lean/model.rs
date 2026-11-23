//! Lean blocks without I/O: module names, imports between blocks, the hash a
//! verdict holds for, and a verdict from Lean's messages. `src/lib/leanModel.ts`
//! computes the same names, imports and hashes; the tests pin both to the
//! same examples.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

// Spec: LEAN-2
/// `lean.module-root` in the spec: a block named `Peano` is `Book.Peano`.
pub const MODULE_ROOT: &str = "Book";

/// Whether `name` can name a block's module: identifiers joined by dots.
pub fn is_module_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 200
        && name.split('.').all(|c| {
            let mut chars = c.chars();
            match chars.next() {
                Some(f) if f.is_alphabetic() || f == '_' => {
                    chars.all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '\'' | '!' | '?'))
                }
                _ => false,
            }
        })
}

/// The source without comments (`/- … -/`, then `-- …`), as the header is read.
fn without_comments(source: &str) -> String {
    let mut text = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(i) = rest.find("/-") {
        text.push_str(&rest[..i]);
        text.push(' ');
        rest = match rest[i + 2..].find("-/") {
            Some(j) => &rest[i + 2 + j + 2..],
            None => "",
        };
    }
    text.push_str(rest);
    text.split('\n')
        .map(|l| match l.find("--") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// Spec: LEAN-2
/// The blocks a source imports: the names after `import Book.` in its header.
pub fn imports_of(source: &str) -> Vec<String> {
    let text = without_comments(source);
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let prefix = format!("{MODULE_ROOT}.");
    let mut names: Vec<String> = Vec::new();
    let mut i = usize::from(tokens.first() == Some(&"prelude"));
    while tokens.get(i) == Some(&"import") {
        i += 1;
        if tokens.get(i) == Some(&"runtime") {
            i += 1;
        }
        let Some(m) = tokens.get(i) else { break };
        if let Some(name) = m.strip_prefix(&prefix) {
            if is_module_name(name) && !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
        i += 1;
    }
    names
}

// Spec: LEAN-5
/// SHA-256 (hex) of the block's name, a newline, and its source.
pub fn hash(name: &str, source: &str) -> String {
    hex::encode(Sha256::digest(format!("{name}\n{source}").as_bytes()))
}

/// A Lean block as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub id: String,
    pub name: String,
    pub source: String,
}

/// A block a verdict depended on, as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dep {
    pub name: String,
    pub hash: String,
}

/// The book's named Lean blocks by name. When blocks share a name, the one
/// with the smallest id has it (every device picks the same one).
pub fn by_name(blocks: &[Block]) -> BTreeMap<String, &Block> {
    let mut index: BTreeMap<String, &Block> = BTreeMap::new();
    for b in blocks.iter().filter(|b| is_module_name(&b.name)) {
        match index.get(&b.name) {
            Some(held) if held.id <= b.id => {}
            _ => {
                index.insert(b.name.clone(), b);
            }
        }
    }
    index
}

// Spec: LEAN-5
/// Every block `source` imports, directly or through others, as they are.
pub fn deps_of(source: &str, index: &BTreeMap<String, &Block>) -> Vec<Dep> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue = imports_of(source);
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(b) = index.get(&name) {
            queue.extend(imports_of(&b.source));
        }
    }
    seen.into_iter()
        .filter_map(|name| index.get(&name).map(|b| Dep { hash: hash(&b.name, &b.source), name }))
        .collect()
}

/// One of Lean's messages about a block (positions as Lean gives them: from 0).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "error" | "warning" | "information" | "hint".
    pub severity: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub text: String,
}

fn position(v: &Value) -> (u32, u32) {
    let n = |k: &str| v.get(k).and_then(Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX));
    (n("line"), n("character"))
}

/// A language-server diagnostic as a message.
pub fn message_of(d: &Value) -> Option<Message> {
    let text = d.get("message")?.as_str()?.to_string();
    let range = d.get("range")?;
    let (line, column) = position(range.get("start")?);
    let (end_line, end_column) = position(range.get("end")?);
    let severity = match d.get("severity").and_then(Value::as_u64) {
        Some(1) => "error",
        Some(2) => "warning",
        Some(4) => "hint",
        _ => "information",
    };
    Some(Message { severity: severity.into(), line, column, end_line, end_column, text })
}

// Spec: LEAN-3, LEAN-5
/// "errors" with any error, "sorry" when it holds only by `sorry`, else "verified".
pub fn status_of(messages: &[Message]) -> &'static str {
    if messages.iter().any(|m| m.severity == "error") {
        "errors"
    } else if messages.iter().any(|m| m.severity == "warning" && m.text.contains("declaration uses 'sorry'")) {
        "sorry"
    } else {
        "verified"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn module_names() {
        assert!(is_module_name("Peano"));
        assert!(is_module_name("Logic.Classical"));
        assert!(is_module_name("Nat.add_comm'"));
        assert!(!is_module_name(""));
        assert!(!is_module_name("1st"));
        assert!(!is_module_name("a..b"));
        assert!(!is_module_name("a b"));
        assert!(!is_module_name("Peano."));
    }

    #[test]
    fn imports_as_the_frontend_reads_them() {
        let src = "-- the naturals\nimport Mathlib.Data.Nat.Basic\nimport Book.Peano\n/- a comment\nimport Book.Hidden -/\nimport Book.Logic.Classical\n\ntheorem x : True := trivial\nimport Book.NotHeader";
        assert_eq!(imports_of(src), vec!["Peano", "Logic.Classical"]);
        assert_eq!(imports_of("prelude\nimport Book.A"), vec!["A"]);
        assert!(imports_of("def x := 1").is_empty());
    }

    #[test]
    fn the_same_hash_as_the_frontend() {
        // tests/lean.test.ts pins the same input to the same hash.
        assert_eq!(hash("Peano", "def x := 1"), "d40223bcd6415ac459f351d98e8eb80dc898e05cc28543bb790c023e17870c8c");
    }

    fn block(id: &str, name: &str, source: &str) -> Block {
        Block { id: id.into(), name: name.into(), source: source.into() }
    }

    #[test]
    fn deps_are_transitive_and_survive_cycles() {
        let blocks = vec![
            block("blk_1", "A", "import Book.B\ndef a := 1"),
            block("blk_2", "B", "import Book.C\ndef b := 1"),
            block("blk_3", "C", "import Book.A\ndef c := 1"),
            block("blk_4", "", "def scratch := 1"),
        ];
        let index = by_name(&blocks);
        let deps = deps_of("import Book.A\nimport Mathlib", &index);
        let names: Vec<&str> = deps.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["A", "B", "C"]);
        assert_eq!(deps[0].hash, hash("A", "import Book.B\ndef a := 1"));
        // A missing block is no dependency (Lean reports the import).
        assert!(deps_of("import Book.Missing", &index).is_empty());
    }

    #[test]
    fn a_shared_name_goes_to_the_smallest_id() {
        let blocks = vec![block("blk_9", "A", "later"), block("blk_1", "A", "earlier")];
        assert_eq!(by_name(&blocks)["A"].source, "earlier");
    }

    #[test]
    fn verdicts_from_messages() {
        let d = |severity: u64, text: &str| {
            message_of(&json!({
                "severity": severity, "message": text,
                "range": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 9 } }
            }))
            .expect("a message")
        };
        assert_eq!(status_of(&[]), "verified");
        assert_eq!(status_of(&[d(3, "2")]), "verified");
        assert_eq!(status_of(&[d(2, "declaration uses 'sorry'")]), "sorry");
        assert_eq!(status_of(&[d(2, "declaration uses 'sorry'"), d(1, "type mismatch")]), "errors");
        let m = d(1, "type mismatch");
        assert_eq!((m.severity.as_str(), m.line, m.column, m.end_column), ("error", 2, 4, 9));
    }
}
