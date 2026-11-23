//! Lean on the author's computers (LEAN-3 to LEAN-8): a Lake workspace with
//! Mathlib in the app's data folder (workspace.rs), Lean's language server
//! (`lake serve`, spoken to by lsp.rs) to check Lean blocks and read the
//! proof state, and verdicts written to `lean_checks`, which syncs
//! (service.rs). Compiled for desktop only: phones carry none of it (LEAN-7).

pub mod lsp;
pub mod model;
pub mod service;
pub mod workspace;
