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
            "macOS is keeping Commonplace off the local network: turn it on in System Settings → Privacy & Security → Local Network, or show the code here and scan it with the other device, which can still reach this one"
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

// Spec: SYN-5
/// The addresses to try for `addrs`: a link-local IPv6 address without a
/// scope is tried on each of this device's interfaces that has one.
pub fn candidates(addrs: &[SocketAddr]) -> Vec<SocketAddr> {
    let scopes: Vec<u32> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| matches!(&i.addr, if_addrs::IfAddr::V6(v6) if v6.ip.is_unicast_link_local()))
        .filter_map(|i| i.index)
        .collect();
    let mut out = Vec::new();
    for a in addrs {
        match a {
            SocketAddr::V6(v6) if v6.ip().is_unicast_link_local() && v6.scope_id() == 0 => {
                out.extend(scopes.iter().map(|s| SocketAddr::V6(std::net::SocketAddrV6::new(*v6.ip(), v6.port(), 0, *s))));
            }
            _ => out.push(*a),
        }
    }
    out.dedup();
    out
}

/// An address as a device announces it ("192.168.1.44", "fe80::1%5", "2a00::1") with its port.
pub fn announced(address: &str, port: u16) -> Option<SocketAddr> {
    let (host, scope) = match address.split_once('%') {
        Some((h, s)) => (h, Some(s.parse::<u32>().ok()?)),
        None => (address, None),
    };
    match host.parse::<IpAddr>().ok()? {
        IpAddr::V4(v4) if scope.is_none() && !v4.is_unspecified() && !v4.is_multicast() && !v4.is_broadcast() => Some(SocketAddr::from((v4, port))),
        IpAddr::V6(v6) if !v6.is_unspecified() && !v6.is_multicast() => Some(SocketAddr::V6(std::net::SocketAddrV6::new(v6, port, 0, scope.unwrap_or(0)))),
        _ => None,
    }
}

// Spec: SYN-5, SYN-24
/// Tries every address at once; the first to answer wins. When none does,
/// what each one came to.
pub async fn connect_any(addrs: &[SocketAddr]) -> std::result::Result<(TcpStream, SocketAddr), Vec<String>> {
    use futures_util::stream::{FuturesUnordered, StreamExt};
    if addrs.is_empty() {
        return Err(vec!["no address to try".into()]);
    }
    let mut attempts: FuturesUnordered<_> = addrs.iter().map(|a| async move { (*a, connect(*a).await.0) }).collect();
    let mut failed = Vec::new();
    while let Some((addr, r)) = attempts.next().await {
        match r {
            Ok(s) => return Ok((s, addr)),
            Err(e) => failed.push(e),
        }
    }
    Err(failed)
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
    /// This device would send traffic for its own network out of another interface (a VPN, a per-app setting).
    RoutedAway { network: String, iface: String, via: String },
}

fn rank(f: &Finding) -> u8 {
    match f {
        Finding::Blocked => 0,
        Finding::RoutedAway { .. } => 1,
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
    let worst = findings.iter().min_by_key(|f| rank(f));
    if tried == 0 && !matches!(worst, Some(Finding::RoutedAway { .. })) {
        return ("There's no other device to try yet: show a pairing code on one device and scan it with the other.".into(), None);
    }
    match worst {
        Some(Finding::RoutedAway { network, iface, via }) => (
            format!("This device sends Commonplace's traffic for its own network ({network}, on {iface}) out through {via} instead: a VPN, or a setting for this app, takes it off the local network, so other devices can't reach it and it can't reach them. Turn the VPN off, or let it allow the local network (\"Allow LAN\", or leave Commonplace out of it), and check that Commonplace may use Wi-Fi."),
            None,
        ),
        Some(Finding::Blocked) => (
            "macOS is keeping Commonplace off the local network, so this computer can't reach the others. Open System Settings → Privacy & Security → Local Network and turn Commonplace on, then try again; a new version of the app asks again. Meanwhile the other devices can still reach this computer: show the pairing code here and scan it with the phone.".into(),
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
            format!("{label} at {ip} doesn't answer. Is it on the same Wi-Fi and awake, with Commonplace open? A VPN on it can keep it from answering (check the connection there too), and some routers keep Wi-Fi devices from reaching each other (guest networks, \"client isolation\")."),
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
pub async fn run(
    pool: &SqlitePool,
    port: u16,
    discovery_problem: Option<String>,
    nearby: Vec<super::service::Nearby>,
    joining: Option<(String, Vec<String>, String)>,
) -> Report {
    let mut lines = Vec::new();
    let nets = networks();
    let lan: Vec<&Net> = nets.iter().filter(|n| n.ip.is_private() || n.ip.is_link_local()).collect();
    if lan.is_empty() {
        lines.push(Line { ok: Some(false), text: "This device has no address on a local network.".into() });
    } else {
        let list: Vec<String> = lan.iter().map(|n| format!("{}/{} ({})", n.ip, n.prefix(), n.name)).collect();
        lines.push(Line { ok: Some(true), text: format!("This device is on the local network as {}.", list.join(", ")) });
    }
    // Spec: SYN-23
    // Which way this app's traffic for its own network goes: out of that
    // network's interface, unless a VPN or a setting for the app takes it.
    let mut findings = Vec::new();
    for n in &lan {
        let Some(neighbour) = neighbour(n) else { continue };
        let via = route_from(IpAddr::V4(neighbour));
        let network = format!("{}/{}", Ipv4Addr::from(u32::from(n.ip) & u32::from(n.mask)), n.prefix());
        match via {
            Some(IpAddr::V4(v)) if v != n.ip => {
                let via_name = nets.iter().find(|m| m.ip == v).map(|m| format!("{v} ({})", m.name)).unwrap_or_else(|| v.to_string());
                lines.push(Line { ok: Some(false), text: format!("Traffic for {network} would leave from {via_name}, not from {} ({}).", n.ip, n.name) });
                findings.push((String::new(), true, Finding::RoutedAway { network, iface: n.name.clone(), via: via_name }));
            }
            Some(_) => lines.push(Line { ok: Some(true), text: format!("Traffic for {network} leaves through {}.", n.name) }),
            None => lines.push(Line { ok: None, text: format!("Couldn't tell which way traffic for {network} would go.") }),
        }
    }
    lines.push(if port == 0 {
        Line { ok: Some(false), text: "Sync isn't listening here yet.".into() }
    } else if port != session::PREFERRED_PORT {
        Line { ok: None, text: format!("Sync listens on TCP port {port}: port {} is taken by another app (an earlier Commonplace still installed?).", session::PREFERRED_PORT) }
    } else {
        Line { ok: Some(true), text: format!("Sync listens on TCP port {port}.") }
    });
    lines.push(match &discovery_problem {
        Some(p) => Line { ok: Some(false), text: format!("{p}: other devices won't find this one by searching.") },
        None => Line { ok: Some(true), text: format!("It answers searches on UDP port {}.", discovery::PORT) },
    });

    let me = session::identity(pool).await.ok();
    let my_tag = me.as_ref().and_then(|m| m.book_id.as_deref()).map(session::book_tag).unwrap_or_default();
    // Spec: SYN-5
    // What was found nearby (mDNS), with every address each announced.
    if nearby.is_empty() {
        lines.push(Line { ok: None, text: "No device has been found nearby (mDNS) yet.".into() });
    }
    for n in &nearby {
        let list: Vec<String> = n.addrs.iter().map(|a| a.ip().to_string()).collect();
        let what = if !my_tag.is_empty() && n.book == my_tag {
            " (of this book)"
        } else if !n.pair.is_empty() {
            " (showing a pairing code)"
        } else {
            ""
        };
        let port = n.addrs.first().map(|a| a.port()).unwrap_or(0);
        lines.push(Line { ok: Some(true), text: format!("Found nearby: {}{what} at {}, port {port}.", n.name, list.join(", ")) });
    }
    let mut targets: Vec<Target> = Vec::new();
    for n in nearby.iter().filter(|n| !my_tag.is_empty() && n.book == my_tag) {
        targets.extend(n.addrs.iter().map(|a| Target { label: n.name.clone(), addr: *a }));
    }
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
    if let Some((host, addrs, tag)) = joining {
        let label = format!("{host} (the code last joined)");
        for n in nearby.iter().filter(|n| n.pair == tag) {
            targets.extend(n.addrs.iter().map(|a| Target { label: label.clone(), addr: *a }));
        }
        for a in addrs {
            if let Ok(addr) = a.parse::<SocketAddr>() {
                if !targets.iter().any(|t| t.addr == addr) {
                    targets.push(Target { label: label.clone(), addr });
                }
            }
        }
    }

    for t in &targets {
        let (line, finding) = try_one(t, &nets).await;
        lines.push(line);
        let near = match t.addr.ip() {
            IpAddr::V4(v4) => lan.iter().any(|n| n.holds(v4)),
            IpAddr::V6(_) => true,
        };
        findings.push((t.label.clone(), near, finding));
    }
    let (verdict, fix) = verdict(!lan.is_empty(), targets.len(), &by_device(findings));
    Report { verdict, fix, lines }
}

/// An address on `net` to ask the system the way to: the network's first host, or its second when that's this device.
pub fn neighbour(net: &Net) -> Option<Ipv4Addr> {
    if net.prefix() >= 31 {
        return None;
    }
    let base = u32::from(net.ip) & u32::from(net.mask);
    let first = Ipv4Addr::from(base + 1);
    Some(if first == net.ip { Ipv4Addr::from(base + 2) } else { first })
}

/// What each device came to: reached at any address counts as reached, and
/// an address of it on another network doesn't count when another of its
/// addresses is on this one (a phone offers its VPN's address too).
pub fn by_device(found: Vec<(String, bool, Finding)>) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut labels: Vec<&String> = Vec::new();
    for (label, _, _) in &found {
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    for label in labels {
        let mine: Vec<&(String, bool, Finding)> = found.iter().filter(|(l, _, _)| l == label).collect();
        if label.is_empty() || !mine.iter().any(|(_, _, f)| *f == Finding::Reached) {
            let any_near = mine.iter().any(|(_, near, _)| *near);
            out.extend(mine.into_iter().filter(|(_, near, _)| *near || !any_near).map(|(_, _, f)| f.clone()));
        } else {
            out.push(Finding::Reached);
        }
    }
    out
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
        // An IPv6 address was found nearby or given by the device itself: it's on the local network.
        _ if ip.is_ipv6() => match reach {
            Reach::Refused => Finding::NotOpen { label: label.clone() },
            Reach::Failed => Finding::Failed { label: label.clone(), error: said.clone() },
            _ => Finding::NotAnswering { label: label.clone(), ip },
        },
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
    fn the_way_out_is_asked_for_a_neighbour_on_the_network() {
        let wlan = Net { name: "wlan0".into(), ip: Ipv4Addr::new(192, 168, 1, 44), mask: Ipv4Addr::new(255, 255, 255, 0) };
        assert_eq!(neighbour(&wlan), Some(Ipv4Addr::new(192, 168, 1, 1)));
        let router = Net { name: "en0".into(), ip: Ipv4Addr::new(192, 168, 1, 1), mask: Ipv4Addr::new(255, 255, 255, 0) };
        assert_eq!(neighbour(&router), Some(Ipv4Addr::new(192, 168, 1, 2)));
        let vpn = Net { name: "vgate0".into(), ip: Ipv4Addr::new(172, 30, 232, 16), mask: Ipv4Addr::new(255, 255, 255, 255) };
        assert_eq!(neighbour(&vpn), None);
    }

    #[test]
    fn a_device_counts_by_its_address_on_this_network() {
        let phone = |near: bool, f: Finding| ("Phone".to_string(), near, f);
        let not_answering = Finding::NotAnswering { label: "Phone".into(), ip: "192.168.1.44".parse().unwrap() };
        let other = Finding::OtherNetwork { label: "Phone".into(), theirs: Ipv4Addr::new(172, 30, 232, 16) };
        let found = by_device(vec![phone(false, other.clone()), phone(true, not_answering.clone())]);
        assert_eq!(found, vec![not_answering.clone()]);
        assert!(verdict(true, 2, &found).0.starts_with("Phone at 192.168.1.44 doesn't answer"));
        assert_eq!(by_device(vec![phone(false, other.clone())]), vec![other]);
        assert_eq!(by_device(vec![phone(true, not_answering), phone(true, Finding::Reached)]), vec![Finding::Reached]);
    }

    #[test]
    fn traffic_taken_off_the_network_is_named_even_with_nothing_to_try() {
        let routed = Finding::RoutedAway { network: "192.168.1.0/24".into(), iface: "wlan0".into(), via: "172.30.232.16 (vgate0)".into() };
        let (v, _) = verdict(true, 0, &[routed]);
        assert!(v.starts_with("This device sends Commonplace's traffic for its own network (192.168.1.0/24, on wlan0) out through 172.30.232.16 (vgate0)"), "{v}");
    }

    // Spec: SYN-5
    #[test]
    fn announced_addresses_are_numeric_and_keep_their_scope() {
        assert_eq!(announced("192.168.1.44", 47832), Some("192.168.1.44:47832".parse().unwrap()));
        let scoped = announced("fe80::1%5", 47832).unwrap();
        assert!(matches!(scoped, SocketAddr::V6(v6) if v6.scope_id() == 5 && v6.port() == 47832));
        assert_eq!(announced("fe80::1%en0", 1), None);
        assert_eq!(announced("ff02::1", 1), None);
        assert_eq!(announced("phone.local", 1), None);
        assert_eq!(announced("192.168.1.44%3", 1), None);
    }

    #[test]
    fn scoped_and_routable_addresses_are_tried_as_they_are() {
        let a: Vec<SocketAddr> = vec!["192.168.1.44:1".parse().unwrap(), "[fd00::5]:1".parse().unwrap(), "[fe80::1%3]:1".parse().unwrap()];
        assert_eq!(candidates(&a), a);
    }

    // Spec: SYN-5, SYN-24
    #[tokio::test]
    async fn the_first_address_to_answer_wins() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live = l.local_addr().unwrap();
        let dead = { let d = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); d.local_addr().unwrap() };
        let (_, addr) = connect_any(&[dead, live]).await.expect("the live one");
        assert_eq!(addr, live);
        let failed = connect_any(&[dead]).await.unwrap_err();
        assert_eq!(failed.len(), 1);
        assert!(connect_any(&[]).await.is_err());
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
