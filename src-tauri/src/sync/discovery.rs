//! Finding the book's other devices on the local network.
//!
//! Every device answers on UDP [`PORT`]. A device looking for its book sends
//! a probe — to the network's broadcast address, and straight to every
//! address a peer was last seen at — naming its book by a short tag (never
//! the book id itself). Devices of that book answer with their id and the
//! TCP port they sync on. Nothing here is trusted: discovery only says where
//! to knock, and the encrypted handshake decides who's at the door.
//!
//! Plain broadcast rather than mDNS: a phone can send one without holding a
//! multicast lock, and the answer comes back to it directly.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::time::{timeout, Instant};

// Spec: SYN-5, SYN-6
/// Tally uses 47821/47822; Commonplace stays clear of them so both run side by side.
pub const PORT: u16 = 47831;
const QUERY: &str = "MYBOOK/1 Q";
const REPLY: &str = "MYBOOK/1 R";

/// A device of the book that answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub device_id: String,
    pub addr: SocketAddr,
}

fn parse_query(msg: &str) -> Option<(&str, &str)> {
    let mut parts = msg.strip_prefix(QUERY)?.split_whitespace();
    Some((parts.next()?, parts.next()?))
}

fn parse_reply(msg: &str) -> Option<(&str, &str, u16)> {
    let mut parts = msg.strip_prefix(REPLY)?.split_whitespace();
    Some((parts.next()?, parts.next()?, parts.next()?.parse().ok()?))
}

/// Answers probes for this device's book until the socket fails. `state`
/// says, at the moment a probe arrives, (book tag, device id, TCP port) —
/// or nothing while this device isn't in a book.
pub async fn respond<F>(socket: UdpSocket, state: F)
where
    F: Fn() -> Option<(String, String, u16)>,
{
    let mut buf = [0u8; 512];
    loop {
        let Ok((n, from)) = socket.recv_from(&mut buf).await else { return };
        let Ok(msg) = std::str::from_utf8(&buf[..n]) else { continue };
        let Some((tag, asker)) = parse_query(msg) else { continue };
        let Some((my_tag, me, port)) = state() else { continue };
        if tag != my_tag || asker == me {
            continue;
        }
        let _ = socket.send_to(format!("{REPLY} {my_tag} {me} {port}").as_bytes(), from).await;
    }
}

// Spec: SYN-2
/// Binds the answering socket on every interface, sharing the port: another
/// app may hold it too (an earlier version still installed, a development
/// build beside the real one), and searches are broadcast, so each hears them.
pub async fn bind_responder(port: u16) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(unix)]
    s.set_reuse_port(true)?;
    s.set_broadcast(true)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port).into())?;
    UdpSocket::from_std(s.into())
}

/// Where to send a probe: the broadcast address, plus each address a peer
/// was last reached at (its discovery port, same host).
pub fn targets(last_addrs: &[String], port: u16) -> Vec<SocketAddr> {
    let mut out = vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), port)];
    for a in last_addrs {
        if let Ok(sa) = a.parse::<SocketAddr>() {
            out.push(SocketAddr::new(sa.ip(), port));
        }
    }
    out.dedup();
    out
}

/// Asks who of the book `tag` is around, listening for answers for `wait`.
pub async fn probe(tag: &str, me: &str, targets: &[SocketAddr], wait: Duration) -> Vec<Found> {
    let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await else { return vec![] };
    let _ = socket.set_broadcast(true);
    let query = format!("{QUERY} {tag} {me}");
    for t in targets {
        let _ = socket.send_to(query.as_bytes(), t).await;
    }
    let deadline = Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    let mut buf = [0u8; 512];
    while let Ok(Ok((n, from))) = timeout(deadline.saturating_duration_since(Instant::now()), socket.recv_from(&mut buf)).await {
        let Ok(msg) = std::str::from_utf8(&buf[..n]) else { continue };
        let Some((t, id, port)) = parse_reply(msg) else { continue };
        if t != tag || id == me {
            continue;
        }
        let f = Found { device_id: id.to_string(), addr: SocketAddr::new(from.ip(), port) };
        if !found.contains(&f) {
            found.push(f);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn devices_of_the_book_answer_and_others_do_not() {
        let mut answering = Vec::new();
        for (tag, id, port) in [("book-a", "phone", 5001u16), ("book-a", "mac", 5002), ("book-b", "stranger", 5003)] {
            let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let addr = socket.local_addr().unwrap();
            tokio::spawn(respond(socket, move || Some((tag.to_string(), id.to_string(), port))));
            answering.push(addr);
        }
        let mut found = probe("book-a", "phone", &answering, Duration::from_millis(300)).await;
        found.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        // Not itself, not another book: just the Mac, at its sync port.
        assert_eq!(found, vec![Found { device_id: "mac".into(), addr: "127.0.0.1:5002".parse().unwrap() }]);
    }

    #[tokio::test]
    async fn a_device_outside_any_book_stays_quiet() {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        tokio::spawn(respond(socket, || None));
        assert!(probe("book-a", "phone", &[addr], Duration::from_millis(200)).await.is_empty());
    }

    #[test]
    fn junk_is_ignored() {
        assert_eq!(parse_query("hello"), None);
        assert_eq!(parse_reply("MYBOOK/1 R tag id notaport"), None);
        assert_eq!(parse_reply("MYBOOK/1 R tag id 47832"), Some(("tag", "id", 47832)));
    }

    // Spec: SYN-2
    #[tokio::test]
    async fn two_apps_can_answer_on_the_same_port() {
        let port = 47_900 + (std::process::id() % 90) as u16;
        let first = bind_responder(port).await.expect("first");
        let second = bind_responder(port).await.expect("second, beside the first");
        assert_eq!(first.local_addr().unwrap().port(), second.local_addr().unwrap().port());
    }

    #[test]
    fn probes_go_to_the_broadcast_address_and_last_known_peers() {
        let t = targets(&["192.168.1.5:47832".into(), "garbage".into()], PORT);
        assert_eq!(t, vec!["255.255.255.255:47831".parse().unwrap(), "192.168.1.5:47831".parse().unwrap()]);
    }
}
