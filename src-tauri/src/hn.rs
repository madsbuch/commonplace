//! Hacker News threads for the library (LIB-31, LIB-33): the story and every
//! comment in it, fetched from the site's own API
//! (`hacker-news.firebaseio.com/v0/item/<id>.json`, one request an item, a
//! few at once). Only the thread's id goes out. Asked for a comment, it climbs
//! to the story above it first. What comes back is the site's items as they
//! are, for the frontend to keep (src/lib/threads.ts); items the site answers
//! `null` for are `missing`, and those the network kept from us are `failed`
//! (neither is taken to mean anything was deleted).

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::time::Duration;
use tauri_plugin_http::reqwest;

const API: &str = "https://hacker-news.firebaseio.com/v0/item/";
/// How many items are asked for at once.
const AT_ONCE: usize = 16;
/// The most items a thread is fetched with (the largest threads have a few thousand).
const MOST_ITEMS: usize = 20_000;
/// How far up a comment's parents are followed to find its story.
const MOST_CLIMB: usize = 1_000;
const WAIT: Duration = Duration::from_secs(20);
/// Waits before trying an item again, after the network failed it.
const RETRIES: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(2000)];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// The story's id: the one asked for, or the story above the comment asked for.
    pub story: u64,
    /// The id asked for.
    pub asked: u64,
    /// Every item reached, as the site gives it, the story first.
    pub items: Vec<Value>,
    /// Items the site has nothing for (it answered `null`).
    pub missing: Vec<u64>,
    /// Items the network kept from us.
    pub failed: Vec<u64>,
}

/// What asking for one item gave.
pub enum Got {
    Item(Value),
    Missing,
    Failed(String),
}

fn kids(item: &Value) -> Vec<u64> {
    item.get("kids").and_then(Value::as_array).map(|k| k.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
}

// Spec: LIB-31
/// The thread `start` is in: climbs from a comment to its story, then takes
/// every comment under it, a level at a time, `AT_ONCE` items at once.
pub async fn walk<F, Fut>(start: u64, fetch: F) -> Result<Fetched, String>
where
    F: Fn(u64) -> Fut,
    Fut: Future<Output = Got>,
{
    let mut id = start;
    let mut climbed = 0;
    let story = loop {
        match fetch(id).await {
            Got::Item(v) => {
                let parent = v.get("parent").and_then(Value::as_u64);
                match (v.get("type").and_then(Value::as_str), parent) {
                    (Some("comment"), Some(p)) if climbed < MOST_CLIMB => {
                        id = p;
                        climbed += 1;
                    }
                    // A poll's option belongs to its poll, as a comment to its story.
                    (Some("pollopt"), Some(p)) if climbed < MOST_CLIMB => {
                        id = p;
                        climbed += 1;
                    }
                    _ => break v,
                }
            }
            Got::Missing => return Err(format!("Hacker News has no item {id}.")),
            Got::Failed(e) => return Err(e),
        }
    };
    let story_id = story.get("id").and_then(Value::as_u64).unwrap_or(id);
    let mut level = kids(&story);
    let mut items = vec![story];
    let (mut missing, mut failed) = (Vec::new(), Vec::new());
    let fetch = &fetch;
    while !level.is_empty() && items.len() < MOST_ITEMS {
        let room = MOST_ITEMS - items.len();
        level.truncate(room);
        let got: Vec<(u64, Got)> = stream::iter(level.drain(..)).map(|id| async move { (id, fetch(id).await) }).buffer_unordered(AT_ONCE).collect().await;
        let mut next = Vec::new();
        for (id, g) in got {
            match g {
                Got::Item(v) => {
                    next.extend(kids(&v));
                    items.push(v);
                }
                Got::Missing => missing.push(id),
                Got::Failed(_) => failed.push(id),
            }
        }
        level = next;
    }
    Ok(Fetched { story: story_id, asked: start, items, missing, failed })
}

/// One item from the site, tried again when the network fails it.
async fn item(client: &reqwest::Client, id: u64) -> Got {
    let url = format!("{API}{id}.json");
    let mut last = String::new();
    for wait in std::iter::once(Duration::ZERO).chain(RETRIES) {
        tokio::time::sleep(wait).await;
        let res = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last = format!("couldn't fetch Hacker News item {id}: {}", crate::diagnostics::chain(&e));
                continue;
            }
        };
        let status = res.status();
        if !status.is_success() {
            last = format!("Hacker News answered {status} for item {id}");
            if status.is_server_error() || status.as_u16() == 429 || status.as_u16() == 408 {
                continue;
            }
            return Got::Failed(last);
        }
        let bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => {
                last = format!("Hacker News item {id} stopped arriving: {}", crate::diagnostics::chain(&e));
                continue;
            }
        };
        return match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Null) => Got::Missing,
            Ok(v) => Got::Item(v),
            Err(e) => Got::Failed(format!("Hacker News item {id} isn't JSON: {e}")),
        };
    }
    Got::Failed(last)
}

// Spec: LIB-31, LIB-33
/// The thread item `id` is in, fetched whole from Hacker News.
pub async fn thread(id: u64) -> Result<Fetched, String> {
    let client = reqwest::Client::builder().timeout(WAIT).build().map_err(|e| e.to_string())?;
    walk(id, |i| item(&client, i)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn site() -> HashMap<u64, Value> {
        let mut m = HashMap::new();
        m.insert(1, json!({ "id": 1, "type": "story", "title": "A story", "kids": [2, 3, 6] }));
        m.insert(2, json!({ "id": 2, "type": "comment", "parent": 1, "text": "First", "kids": [4, 5] }));
        m.insert(3, json!({ "id": 3, "type": "comment", "parent": 1, "deleted": true, "kids": [7] }));
        m.insert(4, json!({ "id": 4, "type": "comment", "parent": 2, "text": "Reply" }));
        m.insert(5, json!({ "id": 5, "type": "comment", "parent": 2, "text": "Another", "dead": true }));
        m.insert(7, json!({ "id": 7, "type": "comment", "parent": 3, "text": "Under a deleted one" }));
        m
    }

    fn ask(m: &HashMap<u64, Value>, id: u64) -> Got {
        match id {
            6 => Got::Missing,
            8 => Got::Failed("offline".into()),
            _ => m.get(&id).cloned().map_or(Got::Missing, Got::Item),
        }
    }

    // Spec: LIB-31
    #[tokio::test]
    async fn takes_every_comment_under_the_story() {
        let m = site();
        let f = walk(1, |id| std::future::ready(ask(&m, id))).await.unwrap();
        let mut ids: Vec<u64> = f.items.iter().filter_map(|v| v["id"].as_u64()).collect();
        assert_eq!(f.items[0]["id"], 1);
        ids.sort();
        assert_eq!(ids, vec![1, 2, 3, 4, 5, 7], "deleted and dead ones too, and what's under them");
        assert_eq!(f.missing, vec![6]);
        assert!(f.failed.is_empty());
    }

    // Spec: LIB-31
    #[tokio::test]
    async fn a_comment_brings_its_whole_thread() {
        let m = site();
        let f = walk(4, |id| std::future::ready(ask(&m, id))).await.unwrap();
        assert_eq!((f.story, f.asked), (1, 4));
        assert_eq!(f.items.len(), 6);
    }

    #[tokio::test]
    async fn what_the_network_kept_back_is_told_apart() {
        let mut m = site();
        m.insert(1, json!({ "id": 1, "type": "story", "kids": [2, 8] }));
        let f = walk(1, |id| std::future::ready(ask(&m, id))).await.unwrap();
        assert_eq!(f.failed, vec![8]);
        assert!(f.missing.is_empty());
        assert!(walk(6, |id| std::future::ready(ask(&m, id))).await.is_err());
    }
}
