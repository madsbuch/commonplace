//! The app's folders under its earlier identifier (APP-13): it was
//! `com.madsbuch.mybook`, and a computer's folders are named after the
//! identifier. The first time it starts as `app.identifier`, what's in the
//! old folders moves into the new ones: the database with its instance
//! marker (so the device stays the same device, tandem.SYN-16), recordings,
//! backups, snapshots, the Lean workspace. Phones can't do this: another
//! app's data is out of reach there.

use std::path::Path;

pub const EARLIER: &str = "com.madsbuch.mybook";
pub const NOW: &str = "com.madsbuch.commonplace";

/// The earlier identifier for `identifier` (development builds carry `.dev` on both).
pub fn earlier_of(identifier: &str) -> Option<String> {
    identifier.strip_prefix(NOW).map(|rest| format!("{EARLIER}{rest}"))
}

// Spec: APP-13
/// Moves what's in `old` into `new`, unless `new` already holds a book
/// (`book.db`): what's there stays. Returns how many entries moved.
pub fn move_into(old: &Path, new: &Path) -> std::io::Result<usize> {
    if !old.is_dir() || new.join(crate::DB_FILE).exists() {
        return Ok(0);
    }
    std::fs::create_dir_all(new)?;
    let mut moved = 0;
    for entry in std::fs::read_dir(old)? {
        let entry = entry?;
        let to = new.join(entry.file_name());
        if to.exists() {
            continue;
        }
        std::fs::rename(entry.path(), &to)?;
        moved += 1;
    }
    // Gone, if nothing's left in it.
    let _ = std::fs::remove_dir(old);
    Ok(moved)
}

/// The folders the app keeps under its identifier, with their earlier names.
pub fn folders(dirs: &[std::path::PathBuf], identifier: &str) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    let Some(old_id) = earlier_of(identifier) else { return Vec::new() };
    let mut out: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for new in dirs {
        if new.file_name().and_then(|n| n.to_str()) != Some(identifier) {
            continue;
        }
        let old = new.with_file_name(&old_id);
        if !out.iter().any(|(_, n)| n == new) {
            out.push((old, new.clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_builds_move_from_their_own_earlier_folders() {
        assert_eq!(earlier_of("com.madsbuch.commonplace").as_deref(), Some("com.madsbuch.mybook"));
        assert_eq!(earlier_of("com.madsbuch.commonplace.dev").as_deref(), Some("com.madsbuch.mybook.dev"));
        assert_eq!(earlier_of("com.example.other"), None);
    }

    #[test]
    fn only_folders_named_after_the_app_move() {
        let dirs = vec![
            std::path::PathBuf::from("/Users/a/Library/Application Support/com.madsbuch.commonplace"),
            std::path::PathBuf::from("/Users/a/Library/Application Support/com.madsbuch.commonplace"),
            std::path::PathBuf::from("/Users/a/Library/Caches/somewhere"),
        ];
        let f = folders(&dirs, "com.madsbuch.commonplace");
        assert_eq!(f.len(), 1);
        assert!(f[0].0.ends_with("Application Support/com.madsbuch.mybook"));
    }

    #[test]
    fn the_book_moves_with_its_marker_once_and_never_over_a_book() {
        let root = std::env::temp_dir().join(format!("commonplace-earlier-{}", crate::diagnostics::now_ms()));
        let (old, new) = (root.join("com.madsbuch.mybook"), root.join("com.madsbuch.commonplace"));
        std::fs::create_dir_all(old.join("recordings")).unwrap();
        std::fs::write(old.join("book.db"), b"the book").unwrap();
        std::fs::write(old.join("book.db.instance"), b"marker").unwrap();
        // The new folder may already exist (made before the app's own setup), empty of a book.
        std::fs::create_dir_all(&new).unwrap();
        assert_eq!(move_into(&old, &new).unwrap(), 3);
        assert_eq!(std::fs::read(new.join("book.db")).unwrap(), b"the book");
        assert_eq!(std::fs::read(new.join("book.db.instance")).unwrap(), b"marker");
        assert!(new.join("recordings").is_dir() && !old.exists());
        // Once there's a book, an old folder found later doesn't overwrite it.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("book.db"), b"older").unwrap();
        assert_eq!(move_into(&old, &new).unwrap(), 0);
        assert_eq!(std::fs::read(new.join("book.db")).unwrap(), b"the book");
        let _ = std::fs::remove_dir_all(&root);
    }
}
