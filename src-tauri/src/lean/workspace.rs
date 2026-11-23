//! The Lean workspace a computer keeps (LEAN-8): a Lake project with Mathlib
//! in the app's data folder. Every named Lean block is a file in it,
//! `Book/<Name>.lean`, so blocks import each other as `Book.<Name>`; a block
//! without a name is checked from `Scratch/`. Lean itself comes from elan,
//! which the author installs; setting up fetches Mathlib and its compiled
//! files (`lake exe cache get`).

use super::model::{Block, MODULE_ROOT};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

type Result<T> = std::result::Result<T, String>;

/// The Lake project: Mathlib, and the book's library.
pub const LAKEFILE: &str = r#"# Made by Commonplace: the workspace its Lean blocks are checked in.
name = "commonplace"
defaultTargets = ["Book"]

[[require]]
name = "mathlib"
git = "https://github.com/leanprover-community/mathlib4"
rev = "master"

[[lean_lib]]
name = "Book"
"#;

/// Written once setting up has finished.
const READY: &str = ".commonplace-ready";

pub struct Workspace {
    pub dir: PathBuf,
}

impl Workspace {
    pub fn new(dir: PathBuf) -> Workspace {
        Workspace { dir }
    }

    /// Where a named block's module lives: `Book/Logic/Classical.lean` for `Logic.Classical`.
    pub fn module_path(&self, name: &str) -> PathBuf {
        let mut p = self.dir.join(MODULE_ROOT);
        for c in name.split('.') {
            p.push(c);
        }
        let file = format!("{}.lean", p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default());
        p.set_file_name(file);
        p
    }

    /// Where a block without a (usable) name is checked from.
    pub fn scratch_path(&self, block_id: &str) -> PathBuf {
        self.dir.join("Scratch").join(format!("{block_id}.lean"))
    }

    pub fn is_ready(&self) -> bool {
        self.dir.join(READY).exists()
    }

    /// The Lean the workspace runs, `leanprover/lean4:v4.x.y`.
    pub fn toolchain(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join("lean-toolchain")).ok().map(|s| s.trim().to_string())
    }

    // Spec: LEAN-2
    /// Puts every named block in its file (rewriting only what changed, so
    /// Lake rebuilds only that) and removes the files of names gone.
    pub fn write_modules(&self, index: &BTreeMap<String, &Block>) -> Result<()> {
        let mut keep: BTreeSet<PathBuf> = BTreeSet::new();
        for (name, block) in index {
            let path = self.module_path(name);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(block.source.as_str()) {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&path, &block.source).map_err(|e| e.to_string())?;
            }
            keep.insert(path);
        }
        // The library's root module, which Lake builds by default.
        let root = self.dir.join(format!("{MODULE_ROOT}.lean"));
        if !root.exists() {
            std::fs::write(&root, "-- The book's Lean blocks are the modules under Book/.\n").map_err(|e| e.to_string())?;
        }
        remove_others(&self.dir.join(MODULE_ROOT), &keep);
        Ok(())
    }

    pub fn write_scratch(&self, block_id: &str, source: &str) -> Result<PathBuf> {
        let path = self.scratch_path(block_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, source).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

/// Removes the `.lean` files under `dir` not in `keep`.
fn remove_others(dir: &Path, keep: &BTreeSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            remove_others(&p, keep);
        } else if p.extension().is_some_and(|x| x == "lean") && !keep.contains(&p) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The directories a child process looks in for `lean`, `git` and `curl`:
/// elan's first, then the usual places (a Mac app doesn't get the shell's PATH).
fn search_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home() {
        dirs.push(h.join(".elan").join("bin"));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

// Spec: LEAN-8
/// elan's `lake`, if Lean is installed here.
pub fn find_lake() -> Option<PathBuf> {
    std::env::split_paths(&search_path()).map(|d| d.join("lake")).find(|p| p.is_file())
}

/// `lake <args>` in the workspace, with a PATH that finds elan's tools.
pub fn lake(lake: &Path, dir: &Path, args: &[&str]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(lake);
    c.args(args).current_dir(dir).env("PATH", search_path()).kill_on_drop(true);
    c
}

/// Runs one step of setting up, passing on each line it prints.
async fn step(lake_bin: &Path, dir: &Path, args: &[&str], on_line: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
    on_line(format!("$ lake {}", args.join(" ")));
    let mut child = lake(lake_bin, dir, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run lake: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    // Each line as it comes, so a long download shows how it goes.
    let pump = |s: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>| async move {
        if let Some(s) = s {
            let mut r = BufReader::new(s).lines();
            while let Ok(Some(l)) = r.next_line().await {
                on_line(l);
            }
        }
    };
    tokio::join!(
        pump(out.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)),
        pump(err.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>))
    );
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`lake {}` failed ({status})", args.join(" ")))
    }
}

// Spec: LEAN-8
/// Makes the workspace: the Lake project, Mathlib at its latest, the Lean
/// Mathlib wants, and Mathlib's compiled files (several GB, once).
pub async fn set_up(ws: &Workspace, lake_bin: &Path, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<()> {
    std::fs::create_dir_all(&ws.dir).map_err(|e| e.to_string())?;
    std::fs::write(ws.dir.join("lakefile.toml"), LAKEFILE).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(ws.dir.join(READY));
    // Mathlib names the Lean it needs; elan fetches it.
    step(lake_bin, &ws.dir, &["+leanprover-community/mathlib4:lean-toolchain", "update"], on_line).await?;
    let wanted = ws.dir.join(".lake").join("packages").join("mathlib").join("lean-toolchain");
    std::fs::copy(&wanted, ws.dir.join("lean-toolchain")).map_err(|e| format!("Mathlib didn't arrive: {e}"))?;
    step(lake_bin, &ws.dir, &["exe", "cache", "get"], on_line).await?;
    ws.write_modules(&BTreeMap::new())?;
    step(lake_bin, &ws.dir, &["build"], on_line).await?;
    std::fs::write(ws.dir.join(READY), ws.toolchain().unwrap_or_default()).map_err(|e| e.to_string())?;
    on_line("Lean and Mathlib are ready.".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, name: &str, source: &str) -> Block {
        Block { id: id.into(), name: name.into(), source: source.into() }
    }

    #[test]
    fn modules_are_files_under_book() {
        let ws = Workspace::new(PathBuf::from("/w"));
        assert_eq!(ws.module_path("Peano"), PathBuf::from("/w/Book/Peano.lean"));
        assert_eq!(ws.module_path("Logic.Classical"), PathBuf::from("/w/Book/Logic/Classical.lean"));
        assert_eq!(ws.scratch_path("blk_1"), PathBuf::from("/w/Scratch/blk_1.lean"));
    }

    #[test]
    fn writes_what_changed_and_removes_what_went() {
        let dir = std::env::temp_dir().join(format!("commonplace-lean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = Workspace::new(dir.clone());
        let a = block("blk_1", "A", "def a := 1");
        let b = block("blk_2", "Logic.B", "def b := 2");
        let index: BTreeMap<String, &Block> = [("A".to_string(), &a), ("Logic.B".to_string(), &b)].into_iter().collect();
        ws.write_modules(&index).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("Book/A.lean")).unwrap(), "def a := 1");
        assert_eq!(std::fs::read_to_string(dir.join("Book/Logic/B.lean")).unwrap(), "def b := 2");
        assert!(dir.join("Book.lean").exists());
        let only_a: BTreeMap<String, &Block> = [("A".to_string(), &a)].into_iter().collect();
        ws.write_modules(&only_a).unwrap();
        assert!(!dir.join("Book/Logic/B.lean").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
