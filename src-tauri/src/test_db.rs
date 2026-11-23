//! Databases for tests: a scratch folder per test, and a file-backed database
//! with every app migration applied, as tauri-plugin-sql applies them.

use futures_core::future::BoxFuture;
use sqlx::error::BoxDynError;
use sqlx::migrate::{Migration as SqlxMigration, MigrationSource, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// The app's own migration list, fed to sqlx the way tauri-plugin-sql feeds
/// it (each one in a transaction, checksums recorded).
#[derive(Debug)]
pub(crate) struct AppMigrations;

impl MigrationSource<'static> for AppMigrations {
    fn resolve(self) -> BoxFuture<'static, Result<Vec<SqlxMigration>, BoxDynError>> {
        Box::pin(async move {
            Ok(crate::migrations()
                .into_iter()
                .map(|m| SqlxMigration::new(m.version, m.description.into(), m.kind.into(), m.sql.into(), false))
                .collect())
        })
    }
}

/// A fresh scratch directory per test, removed on drop.
pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "commonplace-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A file-backed database (`book.db` in `scratch`) with every app migration applied.
pub(crate) async fn migrated_db(scratch: &Scratch) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(scratch.0.join("book.db"))
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new().connect_with(options).await.unwrap();
    Migrator::new(AppMigrations).await.unwrap().run(&pool).await.unwrap();
    pool
}
