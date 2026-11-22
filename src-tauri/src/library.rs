//! A library item's PDF (`library_files` in `src/db/schema.ts`), byte for
//! byte. Through Rust, as in Tally, because the SQL plugin's JS API can only
//! pass JSON values. The bytes cross the IPC as base64 both ways: raw IPC
//! bodies work on the desktop but don't reach Rust on Android.

use base64::Engine as _;
use sqlx::SqlitePool;

/// Bytes from the base64 the frontend sends (standard alphabet, padded).
pub fn decode(data: &str) -> Result<Vec<u8>, String> {
    // At most the largest file's worth: base64 is 4 characters per 3 bytes.
    if data.len() > MAX_FILE_BYTES / 3 * 4 + 4 {
        return Err(format!("the file is larger than {} MB", MAX_FILE_BYTES / (1024 * 1024)));
    }
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("the file didn't arrive intact: {e}"))
}

/// Bytes as base64 for the frontend.
pub fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// Spec: LIB-2
/// `library.max-file-size` in the spec.
pub const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;

/// Whether `bytes` look like a PDF: the `%PDF-` header within the first
/// kilobyte (some writers put junk before it, and readers allow that).
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

// Spec: LIB-7
/// Stores (or replaces) the PDF of item `item_id`.
pub async fn save(pool: &SqlitePool, item_id: &str, media_type: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("the file is larger than {} MB", MAX_FILE_BYTES / (1024 * 1024)));
    }
    if !looks_like_pdf(bytes) {
        return Err("the file isn't a PDF".into());
    }
    sqlx::query("INSERT OR REPLACE INTO library_files (item_id, media_type, data) VALUES (?, ?, ?)")
        .bind(item_id)
        .bind(media_type)
        .bind(bytes)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Spec: LIB-6
/// The stored PDF of item `item_id`; an error when this device doesn't have it.
pub async fn read(pool: &SqlitePool, item_id: &str) -> Result<Vec<u8>, String> {
    let data: Option<Vec<u8>> = sqlx::query_scalar("SELECT data FROM library_files WHERE item_id = ?")
        .bind(item_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    data.ok_or_else(|| format!("item {item_id} has no PDF on this device"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_db::{migrated_db, Scratch};

    fn fake_pdf(len: usize) -> Vec<u8> {
        let mut v = b"%PDF-1.7\n".to_vec();
        // Includes NULs and 0xFF, which a text round trip would mangle.
        v.extend((0..len).map(|i| (i as u8).wrapping_mul(31)));
        v
    }

    // Spec: LIB-7
    #[tokio::test]
    async fn round_trips_byte_for_byte_and_is_tracked_for_sync() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let pdf = fake_pdf(3_000_000);
        save(&pool, "lib_1", "application/pdf", &pdf).await.unwrap();
        assert_eq!(read(&pool, "lib_1").await.unwrap(), pdf);
        let tracked: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_rows WHERE tbl = 'library_files' AND pk = 'lib_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tracked, 1);
    }

    // Spec: LIB-7
    #[test]
    fn base64_round_trips() {
        let pdf = fake_pdf(100_000);
        assert_eq!(decode(&encode(&pdf)).unwrap(), pdf);
        assert!(decode("not base64!").is_err());
        assert!(decode(&"A".repeat(MAX_FILE_BYTES / 3 * 4 + 8)).is_err());
    }

    // Spec: LIB-2
    #[tokio::test]
    async fn refuses_what_isnt_a_pdf_or_is_too_large() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        assert!(save(&pool, "lib_1", "application/pdf", b"hello").await.is_err());
        assert!(save(&pool, "lib_2", "application/pdf", &fake_pdf(MAX_FILE_BYTES)).await.is_err());
        assert!(read(&pool, "lib_1").await.is_err());
        let mut junk_first = b"\x00\x00junk".to_vec();
        junk_first.extend(fake_pdf(10));
        assert!(looks_like_pdf(&junk_first));
    }
}
