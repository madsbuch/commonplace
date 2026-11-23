//! Checking the connection (SYN-23, SYN-24): why this device can't reach
//! another, in plain words, with what to do about it.
//!
//! "No route to host" alone can mean four different things, and how soon it
//! comes tells them apart. macOS's Local Network privacy refuses an app at
//! once, before anything leaves the computer (Apple's TN3179: the connection
//! fails with EHOSTUNREACH). A device that's asleep, gone, or kept apart by
//! the router fails only after the network has asked for it for seconds.
//! Another network, or a VPN, shows in where the system would send the
//! packets from. And a device that answers but refuses has no Commonplace
//! listening.

use super::{discovery, session};
use serde::Serialize;
use sqlx::SqlitePool;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// A refusal sooner than this came from this device itself, not the network.
const AT_ONCE: Duration = Duration::from_millis(150);
/// How long a device is given to answer.
const WAIT: Duration = Duration::from_secs(4);
/// How long the search waits for answers.
const SEARCH: Duration = Duration::from_millis(1500);

/// What a connection attempt came to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Reach {
    Connected,
    /// Something answered, but nothing listens there: Commonplace isn't open.
    Refused,
    /// This device refused before anything left it: on macOS, Local Network privacy.
    BlockedHere,
    /// Nothing answered: asleep, gone, another network, or the router keeps devices apart.
    NotAnswering,
    /// This device has no way to that address.
    NoRoute,
    Failed,
}

// Spec: SYN-24
/// Why an attempt failed, from what the system said and how soon it said it.
pub fn classify(error: Option<ErrorKind>, timed_out: bool, took: Duration, macos: bool) -> Reach {
    if timed_out {
        return Reach::NotAnswering;
    }
    match error {
        None => Reach::Connected,
        Some(ErrorKind::ConnectionRefused) => Reach::Refused,
        Some(ErrorKind::HostUnreachable) if macos && took < AT_ONCE => Reach::BlockedHere,
        Some(ErrorKind::PermissionDenied) => Reach::BlockedHere,
        Some(ErrorKind::HostUnreachable | ErrorKind::TimedOut) => Reach::NotAnswering,
        Some(ErrorKind::NetworkUnreachable) => Reach::NoRoute,
        Some(_) => Reach::Failed,
    }
}

/// What to tell the author about a connection that failed, after the system's own words.
pub fn hint(reach: Reach) -> &'static str {
    match reach {
        Reach::BlockedHere => {
            "macOS is keeping Commonplace off the local network: turn it on in System Settings → Privacy & Security → Local Network, then try again"
        }
        Reach::NotAnswering => "the device doesn't answer: is it on the same Wi-Fi and awake, with Commonplace open?",
        Reach::Refused => "the device is there, but Commonplace isn't open on it",
        Reach::NoRoute => "this device has no way to that address: is it on the same network, without a VPN?",
        Reach::Connected | Reach::Failed => "",
    }
}

// Spec: SYN-24
/// A failed connection as sync says it: the address, the system's words, and what they mean.
pub fn failure(addr: SocketAddr, error: &std::io::Error, took: Duration) -> String {
    let h = hint(classify(Some(error.kind()), false, took, cfg!(target_os = "macos")));
    if h.is_empty() {
        format!("{addr}: {error}")
    } else {
        format!("{addr}: {error} ({h})")
    }
}

/// Tries to connect to `addr`, timing it.
pub async fn connect(addr: SocketAddr) -> (std::result::Result<TcpStream, String>, Duration) {
    let start = Instant::now();
    let r = timeout(session::CONNECT_TIMEOUT, TcpStream::connect(addr)).await;
    let took = start.elapsed();
    let r = match r {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(failure(addr, &e, took)),
        Err(_) => Err(format!("{addr}: no answer in {} s ({})", session::CONNECT_TIMEOUT.as_secs(), hint(Reach::NotAnswering))),
    };
    (r, took)
}

/// One of this device's networks.
#[derive(Debug, Clone, PartialEq)]
pub struct Net {
    pub name: String,
    pub ip: Ipv4Addr,
    pub mask: Ipv4Addr,
}

impl Net {
    pub fn holds(&self, ip: Ipv4Addr) -> bool {
        u32::from(self.ip) & u32::from(self.mask) == u32::from(ip) & u32::from(self.mask)
    }
    fn prefix(&self) -> u32 {
        u32::from(self.mask).count_ones()
    }
}

/// This device's IPv4 networks, loopback aside.
pub fn networks() -> Vec<Net> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some(Net { name: i.name.clone(), ip: v4.ip, mask: v4.netmask }),
            _ => None,
        })
        .collect()
}

/// The address this device would send to `to` from: which way the system routes it.
fn route_from(to: IpAddr) -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    s.connect((to, 9)).ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Whether this part is fine; none for what's only said.
    pub ok: Option<bool>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// What stands in the way and what to do, or that nothing does.
    pub verdict: String,
    /// A setting that would fix it: "local-network" (macOS's Local Network privacy).
    pub fix: Option<String>,
    pub lines: Vec<Line>,
}

/// A device to try.
pub struct Target {
    pub label: String,
    pub addr: SocketAddr,
}

/// What a device came to, for the verdict: the worst one counts.
#[derive(Debug, Clone, PartialEq)]
pub enum Finding {
    Reached,
    Blocked,
    OtherNetwork { label: String, theirs: Ipv4Addr },
    ThroughVpn { label: String, via: String },
    NotAnswering { label: String, ip: IpAddr },
    NotOpen { label: String },
    Failed { label: String, error: String },
}

fn rank(f: &Finding) -> u8 {
    match f {
        Finding::Blocked => 0,
        Finding::ThroughVpn { .. } => 1,
        Finding::OtherNetwork { .. } => 2,
        Finding::NotAnswering { .. } => 3,
        Finding::NotOpen { .. } => 4,
        Finding::Failed { .. } => 5,
        Finding::Reached => 6,
    }
}

// Spec: SYN-23
/// The verdict from what was found: the first thing in the way, and what to do about it.
pub fn verdict(on_network: bool, tried: usize, findings: &[Finding]) -> (String, Option<String>) {
    if !on_network {
        return ("This device isn't on a local network: connect it to the same Wi-Fi as your other devices.".into(), None);
    }
    if tried == 0 {
        return ("There's no other device to try yet: show a pairing code on one device and scan it with the other.".into(), None);
    }
    let worst = findings.iter().min_by_key(|f| rank(f));
    match worst {
        Some(Finding::Blocked) => (
            "macOS is keeping Commonplace off the local network. Open System Settings → Privacy & Security → Local Network and turn Commonplace on, then try again. A new version of the app can need it turned on again.".into(),
            Some("local-network".into()),
        ),
        Some(Finding::ThroughVpn { label, via }) => (
            format!("Traffic to {label} leaves through {via}, likely a VPN: turn it off, or let it allow the local network."),
            None,
        ),
        Some(Finding::OtherNetwork { label, theirs }) => (
            format!("{label} ({theirs}) is on another network than this device: put both on the same Wi-Fi."),
            None,
        ),
        Some(Finding::NotAnswering { label, ip }) => (
            format!("{label} at {ip} doesn't answer. Is it on the same Wi-Fi and awake, with Commonplace open? Some routers keep Wi-Fi devices from reaching each other (guest networks, \"client isolation\")."),
            None,
        ),
        Some(Finding::NotOpen { label }) => (format!("{label} is on the network, but Commonplace isn't open on it: open it there and try again."), None),
        Some(Finding::Failed { label, error }) => (format!("Reaching {label} failed: {error}"), None),
        Some(Finding::Reached) | None => ("Every device tried answers: sync can reach them.".into(), None),
    }
}

// Spec: SYN-23
/// Checks the connection: this device's networks, whether sync listens, which
/// of the book's devices answer the search, and whether each device there's
/// an address for (the book's, and the code last joined) can be reached.
pub async fn run(pool: &SqlitePool, port: u16, joining: Option<(String, Vec<String>)>) -> Report {
    let mut lines = Vec::new();
    let nets = networks();
    let lan: Vec<&Net> = nets.iter().filter(|n| n.ip.is_private() || n.ip.is_link_local()).collect();
    if lan.is_empty() {
        lines.push(Line { ok: Some(false), text: "This device has no address on a local network.".into() });
    } else {
        let list: Vec<String> = lan.iter().map(|n| format!("{}/{} ({})", n.ip, n.prefix(), n.name)).collect();
        lines.push(Line { ok: Some(true), text: format!("This device is on the local network as {}.", list.join(", ")) });
    }
    lines.push(if port == 0 {
        Line { ok: Some(false), text: "Sync isn't listening here yet.".into() }
    } else {
        Line { ok: Some(true), text: format!("Sync listens on TCP port {port}; devices search on UDP port {}.", discovery::PORT) }
    });

    let me = session::identity(pool).await.ok();
    let mut targets: Vec<Target> = Vec::new();
    if let Some(book) = me.as_ref().and_then(|m| m.book_id.clone()) {
        let my_id = me.as_ref().map(|m| m.device_id.clone()).unwrap_or_default();
        let peers: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT d.id, d.name, p.last_addr FROM book_devices d LEFT JOIN sync_peers p ON p.device_id = d.id
             WHERE d.id <> ? AND d.public_key NOT IN (SELECT public_key FROM book_revocations)",
        )
        .bind(&my_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let last: Vec<String> = peers.iter().filter_map(|(_, _, a)| a.clone()).collect();
        let found = discovery::probe(&session::book_tag(&book), &my_id, &discovery::targets(&last, discovery::PORT), SEARCH).await;
        let name_of = |id: &str| peers.iter().find(|(d, _, _)| d == id).map(|(_, n, _)| n.clone()).unwrap_or_else(|| id.to_string());
        if peers.is_empty() {
            lines.push(Line { ok: None, text: "The book has no other device yet.".into() });
        } else if found.is_empty() {
            lines.push(Line { ok: Some(false), text: format!("No device of the book answered the search (UDP port {}).", discovery::PORT) });
        } else {
            let list: Vec<String> = found.iter().map(|f| format!("{} at {}", name_of(&f.device_id), f.addr.ip())).collect();
            lines.push(Line { ok: Some(true), text: format!("Found by searching: {}.", list.join(", ")) });
        }
        for (id, name, last_addr) in &peers {
            let at = found.iter().find(|f| &f.device_id == id).map(|f| f.addr.ip()).or_else(|| last_addr.as_ref().and_then(|a| a.parse::<SocketAddr>().ok()).map(|a| a.ip()));
            match at {
                Some(ip) => {
                    let port = last_addr.as_ref().and_then(|a| a.parse::<SocketAddr>().ok()).map(|a| a.port()).unwrap_or(session::PREFERRED_PORT);
                    targets.push(Target { label: name.clone(), addr: SocketAddr::new(ip, port) });
                }
                None => lines.push(Line { ok: None, text: format!("{name}: no address known yet.") }),
            }
        }
    } else {
        lines.push(Line { ok: None, text: "This device isn't in a book yet.".into() });
    }
    if let Some((host, addrs)) = joining {
        for a in addrs {
            if let Ok(addr) = a.parse::<SocketAddr>() {
                if !targets.iter().any(|t| t.addr == addr) {
                    targets.push(Target { label: format!("{host} (the code last joined)"), addr });
                }
            }
        }
    }

    let mut findings = Vec::new();
    for t in &targets {
        let (line, finding) = try_one(t, &nets).await;
        lines.push(line);
        findings.push(finding);
    }
    let (verdict, fix) = verdict(!lan.is_empty(), targets.len(), &findings);
    Report { verdict, fix, lines }
}

/// Tries one device: which way the packets would go, then a connection.
async fn try_one(t: &Target, nets: &[Net]) -> (Line, Finding) {
    let label = &t.label;
    let ip = t.addr.ip();
    let theirs = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
    };
    let near = nets.iter().find(|n| n.holds(theirs) && (n.ip.is_private() || n.ip.is_link_local()));
    let via = route_from(ip);
    let via_net = via.and_then(|v| nets.iter().find(|n| IpAddr::V4(n.ip) == v));
    let start = Instant::now();
    let attempt = timeout(WAIT, TcpStream::connect(t.addr)).await;
    let took = start.elapsed();
    let (kind, timed_out, said) = match &attempt {
        Ok(Ok(_)) => (None, false, String::new()),
        Ok(Err(e)) => (Some(e.kind()), false, e.to_string()),
        Err(_) => (None, true, format!("no answer in {} s", WAIT.as_secs())),
    };
    let reach = classify(kind, timed_out, took, cfg!(target_os = "macos"));
    let ms = took.as_millis();
    let route = match (via, via_net) {
        (Some(v), Some(n)) => format!(", sent from {v} ({})", n.name),
        (Some(v), None) => format!(", sent from {v}"),
        _ => String::new(),
    };
    let finding = match reach {
        Reach::Connected => Finding::Reached,
        Reach::BlockedHere => Finding::Blocked,
        _ if near.is_none() && via_net.is_some_and(|n| !(n.ip.is_private() || n.ip.is_link_local())) => {
            Finding::ThroughVpn { label: label.clone(), via: via_net.map(|n| n.name.clone()).unwrap_or_default() }
        }
        _ if near.is_none() => Finding::OtherNetwork { label: label.clone(), theirs },
        Reach::Refused => Finding::NotOpen { label: label.clone() },
        Reach::NotAnswering | Reach::NoRoute => Finding::NotAnswering { label: label.clone(), ip },
        Reach::Failed => Finding::Failed { label: label.clone(), error: said.clone() },
    };
    let text = match reach {
        Reach::Connected => format!("{label} at {}: answers ({ms} ms{route}).", t.addr),
        _ => {
            let h = hint(reach);
            format!("{label} at {}: {said} after {ms} ms{route}{}{}", t.addr, if h.is_empty() { "" } else { " — " }, h)
        }
    };
    (Line { ok: Some(reach == Reach::Connected), text }, finding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_refusing_at_once_is_local_network_privacy() {
        let fast = Duration::from_millis(3);
        let slow = Duration::from_secs(3);
        assert_eq!(classify(Some(ErrorKind::HostUnreachable), false, fast, true), Reach::BlockedHere);
        assert_eq!(classify(Some(ErrorKind::HostUnreachable), false, slow, true), Reach::NotAnswering);
        assert_eq!(classify(Some(ErrorKind::HostUnreachable), false, fast, false), Reach::NotAnswering);
        assert_eq!(classify(Some(ErrorKind::ConnectionRefused), false, fast, true), Reach::Refused);
        assert_eq!(classify(None, true, slow, true), Reach::NotAnswering);
        assert_eq!(classify(None, false, fast, true), Reach::Connected);
    }

    #[test]
    fn a_failure_says_what_it_means() {
        let e = std::io::Error::from(ErrorKind::ConnectionRefused);
        let addr: SocketAddr = "192.168.1.44:47832".parse().unwrap();
        assert!(failure(addr, &e, Duration::from_millis(2)).ends_with("(the device is there, but Commonplace isn't open on it)"));
    }

    #[tokio::test]
    async fn a_device_that_listens_answers_and_one_that_doesnt_is_said_so() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let home = [Net { name: "lo".into(), ip: Ipv4Addr::new(10, 0, 0, 1), mask: Ipv4Addr::new(255, 0, 0, 0) }];
        let (line, finding) = try_one(&Target { label: "Phone".into(), addr }, &home).await;
        assert_eq!(finding, Finding::Reached);
        assert!(line.text.starts_with(&format!("Phone at {addr}: answers (")), "{}", line.text);
        drop(l);
        let (line, _) = try_one(&Target { label: "Phone".into(), addr }, &home).await;
        assert_eq!(line.ok, Some(false));
        assert!(line.text.contains("Commonplace isn't open on it"), "{}", line.text);
    }

    #[test]
    fn networks_hold_their_neighbours() {
        let n = Net { name: "en0".into(), ip: Ipv4Addr::new(192, 168, 1, 20), mask: Ipv4Addr::new(255, 255, 255, 0) };
        assert!(n.holds(Ipv4Addr::new(192, 168, 1, 44)));
        assert!(!n.holds(Ipv4Addr::new(192, 168, 2, 44)));
        assert_eq!(n.prefix(), 24);
    }

    #[test]
    fn the_verdict_names_the_first_thing_in_the_way() {
        let (v, fix) = verdict(true, 2, &[Finding::NotOpen { label: "Phone".into() }, Finding::Blocked]);
        assert!(v.starts_with("macOS is keeping Commonplace off the local network"));
        assert_eq!(fix.as_deref(), Some("local-network"));
        let (v, _) = verdict(true, 1, &[Finding::NotAnswering { label: "Phone".into(), ip: "192.168.1.44".parse().unwrap() }]);
        assert!(v.starts_with("Phone at 192.168.1.44 doesn't answer"));
        assert!(verdict(true, 1, &[Finding::Reached]).0.starts_with("Every device tried answers"));
        assert!(verdict(false, 0, &[]).0.starts_with("This device isn't on a local network"));
        assert!(verdict(true, 0, &[]).0.starts_with("There's no other device to try yet"));
    }
}
