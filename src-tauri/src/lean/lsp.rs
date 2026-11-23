//! A small client for Lean's language server (`lake serve`): JSON-RPC over
//! stdio with LSP's `Content-Length` framing. It sends requests and
//! notifications, answers the server's own requests with nothing, and keeps
//! the latest diagnostics Lean published for each file. Generic over its
//! streams, so the tests talk to a stand-in server in memory.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

type Result<T> = std::result::Result<T, String>;
type Writer = Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>;
type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value>>>>>;
/// Per file (its path, decoded from the URI): the version Lean published for, and its diagnostics.
type Diagnostics = Arc<Mutex<HashMap<String, (Option<i64>, Vec<Value>)>>>;

pub struct Lsp {
    writer: Writer,
    next_id: AtomicI64,
    pending: Pending,
    diagnostics: Diagnostics,
    closed: Arc<AtomicBool>,
}

/// One message, framed as LSP frames it.
pub fn frame(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// The next message, or None at the end of the stream.
pub async fn read_message<R: AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Option<Value>> {
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            length = v.trim().parse().ok();
        }
    }
    let mut body = vec![0u8; length.unwrap_or(0)];
    r.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

// Spec: LEAN-3
/// A file's URI, as LSP names it: `file://` and the path, percent-encoded.
pub fn uri_of(path: &std::path::Path) -> String {
    let mut out = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A URI's path, percent-decoded: how files are told apart, whichever way a URI was spelled.
pub fn path_of(uri: &str) -> String {
    let raw = uri.strip_prefix("file://").unwrap_or(uri).as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&raw[i + 1..i + 3]), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Lsp {
    pub fn new<R, W>(reader: R, writer: W) -> Lsp
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let writer: Writer = Arc::new(tokio::sync::Mutex::new(Box::new(writer)));
        let pending: Pending = Arc::default();
        let diagnostics: Diagnostics = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (w, p, d, c) = (writer.clone(), pending.clone(), diagnostics.clone(), closed.clone());
        tokio::spawn(async move {
            let mut r = BufReader::new(reader);
            while let Ok(Some(msg)) = read_message(&mut r).await {
                let id = msg.get("id").cloned();
                match msg.get("method").and_then(Value::as_str) {
                    // The server asks something of us: nothing to say.
                    Some(_) if id.is_some() => {
                        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
                        let mut w = w.lock().await;
                        let _ = w.write_all(&frame(&reply)).await;
                        let _ = w.flush().await;
                    }
                    Some("textDocument/publishDiagnostics") => {
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                        let version = params.get("version").and_then(Value::as_i64);
                        let list = params.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default();
                        if let Ok(mut d) = d.lock() {
                            d.insert(path_of(uri), (version, list));
                        }
                    }
                    Some(_) => {}
                    None => {
                        let Some(id) = id.and_then(|v| v.as_i64()) else { continue };
                        let waiting = p.lock().ok().and_then(|mut p| p.remove(&id));
                        if let Some(tx) = waiting {
                            let result = match msg.get("error") {
                                Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("the Lean server refused").to_string()),
                                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(result);
                        }
                    }
                }
            }
            // The server is gone: nobody waits forever.
            c.store(true, Ordering::SeqCst);
            if let Ok(mut p) = p.lock() {
                for (_, tx) in p.drain() {
                    let _ = tx.send(Err("the Lean server stopped".into()));
                }
            }
        });
        Lsp { writer, next_id: AtomicI64::new(1), pending, diagnostics, closed }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    async fn send(&self, message: &Value) -> Result<()> {
        if self.is_closed() {
            return Err("the Lean server stopped".into());
        }
        let mut w = self.writer.lock().await;
        w.write_all(&frame(message)).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    pub async fn request(&self, method: &str, params: Value, within: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        if let Err(e) = self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err(e);
        }
        match tokio::time::timeout(within, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("the Lean server stopped".into()),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("Lean took longer than {} s", within.as_secs()))
            }
        }
    }

    /// What Lean last published for the file at `uri`, if it was for `version`.
    pub fn diagnostics(&self, uri: &str, version: i64) -> Vec<Value> {
        self.diagnostics
            .lock()
            .ok()
            .and_then(|d| d.get(&path_of(uri)).cloned())
            .filter(|(v, _)| v.is_none_or(|v| v == version))
            .map(|(_, list)| list)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};

    /// A stand-in for Lean's server: answers `initialize`, publishes
    /// diagnostics for each version it's given (an error for a line saying
    /// `error!`), asks the client something once, and answers
    /// `textDocument/waitForDiagnostics` once it has published.
    async fn stand_in<S: AsyncRead + AsyncWrite + Send + Unpin + 'static>(io: S) {
        let (r, mut w) = split(io);
        let mut r = BufReader::new(r);
        let mut texts: HashMap<String, (i64, String)> = HashMap::new();
        while let Ok(Some(msg)) = read_message(&mut r).await {
            let method = msg.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
            let id = msg.get("id").cloned();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let out = match method.as_str() {
                "initialize" => {
                    let ask = json!({ "jsonrpc": "2.0", "id": "s1", "method": "client/registerCapability", "params": {} });
                    w.write_all(&frame(&ask)).await.unwrap();
                    Some(json!({ "capabilities": {} }))
                }
                "textDocument/didOpen" => {
                    let doc = &params["textDocument"];
                    texts.insert(doc["uri"].as_str().unwrap().into(), (doc["version"].as_i64().unwrap(), doc["text"].as_str().unwrap().into()));
                    None
                }
                "textDocument/didChange" => {
                    let doc = &params["textDocument"];
                    let text = params["contentChanges"][0]["text"].as_str().unwrap().to_string();
                    texts.insert(doc["uri"].as_str().unwrap().into(), (doc["version"].as_i64().unwrap(), text));
                    None
                }
                "textDocument/waitForDiagnostics" => {
                    let uri = params["uri"].as_str().unwrap().to_string();
                    let (version, text) = texts.get(&uri).cloned().unwrap();
                    let diags: Vec<Value> = text
                        .lines()
                        .enumerate()
                        .filter(|(_, l)| l.contains("error!"))
                        .map(|(i, _)| json!({ "severity": 1, "message": "unexpected error!", "range": { "start": { "line": i, "character": 0 }, "end": { "line": i, "character": 6 } } }))
                        .collect();
                    // Spelled differently from how the client sent it, as a server may.
                    let respelled = format!("file://{}", path_of(&uri));
                    let publish = json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": { "uri": respelled, "version": version, "diagnostics": diags } });
                    w.write_all(&frame(&publish)).await.unwrap();
                    Some(json!({}))
                }
                "$/lean/plainGoal" => Some(json!({ "rendered": "⊢ True", "goals": ["⊢ True"] })),
                "shutdown" => break,
                _ => None,
            };
            if let (Some(id), Some(result)) = (id, out) {
                w.write_all(&frame(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))).await.unwrap();
            }
            w.flush().await.unwrap();
        }
    }

    fn client() -> Lsp {
        let (ours, theirs) = duplex(1 << 16);
        tokio::spawn(stand_in(theirs));
        let (r, w) = split(ours);
        Lsp::new(r, w)
    }

    #[tokio::test]
    async fn requests_notifications_and_diagnostics() {
        let lsp = client();
        let init = lsp.request("initialize", json!({}), Duration::from_secs(5)).await.unwrap();
        assert!(init.get("capabilities").is_some());
        let uri = uri_of(std::path::Path::new("/tmp/Application Support/Book/Peano.lean"));
        assert!(uri.contains("Application%20Support"));
        lsp.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "lean4", "version": 1, "text": "def x := 1\nerror!" } }))
            .await
            .unwrap();
        lsp.request("textDocument/waitForDiagnostics", json!({ "uri": uri, "version": 1 }), Duration::from_secs(5)).await.unwrap();
        let d = lsp.diagnostics(&uri, 1);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["range"]["start"]["line"], 1);
        // A newer version: the old diagnostics don't count for it until Lean speaks.
        lsp.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": "def x := 1" }] }))
            .await
            .unwrap();
        assert_eq!(lsp.diagnostics(&uri, 2).len(), 0);
        lsp.request("textDocument/waitForDiagnostics", json!({ "uri": uri, "version": 2 }), Duration::from_secs(5)).await.unwrap();
        assert!(lsp.diagnostics(&uri, 2).is_empty());
        let goal = lsp.request("$/lean/plainGoal", json!({}), Duration::from_secs(5)).await.unwrap();
        assert_eq!(goal["goals"][0], "⊢ True");
    }

    #[tokio::test]
    async fn a_stopped_server_fails_what_waits() {
        let lsp = client();
        lsp.request("initialize", json!({}), Duration::from_secs(5)).await.unwrap();
        let _ = lsp.notify("shutdown", json!({})).await;
        // The stand-in stops reading; the stream closes with it.
        let r = lsp.request("textDocument/waitForDiagnostics", json!({ "uri": "file:///x", "version": 1 }), Duration::from_secs(5)).await;
        assert!(r.is_err());
    }

    #[test]
    fn uris_round_trip() {
        let p = std::path::Path::new("/Users/me/Library/Application Support/com.x/lean/Book/Ünï.lean");
        assert_eq!(path_of(&uri_of(p)), p.to_string_lossy());
        assert_eq!(path_of("file:///a%20b/c.lean"), "/a b/c.lean");
    }
}
