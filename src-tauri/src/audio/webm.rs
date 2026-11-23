//! A WebM file of one Opus track (AUD-7): the EBML header, then a Segment of
//! known size holding a SeekHead, Info, Tracks, Chapters, Clusters of about
//! five seconds, and Cues pointing at each Cluster, so players seek without
//! reading the whole file. Every Opus packet is a SimpleBlock; positions in
//! the SeekHead are written 8 bytes wide, so its size is known up front.

/// Clusters start every this many milliseconds (block times are 16-bit offsets).
const CLUSTER_MS: u64 = 5_000;

/// A chapter: its title and where it starts, in milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub title: String,
    pub start_ms: u64,
}

/// What a WebM Opus file says about its one track.
pub struct OpusTrack<'a> {
    /// Each packet, `frame_ms` long, in order.
    pub packets: &'a [Vec<u8>],
    pub frame_ms: u64,
    /// The encoder's delay, in 48 kHz samples.
    pub pre_skip: u16,
    pub channels: u8,
    pub input_rate: u32,
    pub duration_ms: f64,
}

fn id_bytes(id: u32) -> Vec<u8> {
    let b = id.to_be_bytes();
    let skip = b.iter().position(|&x| x != 0).unwrap_or(3);
    b[skip..].to_vec()
}

/// An element's size as an EBML variable-length integer, as short as it fits.
fn size(n: usize) -> Vec<u8> {
    let n = n as u64;
    for len in 1..=8u32 {
        // All ones is reserved for "unknown".
        if n < (1u64 << (7 * len)) - 1 {
            let mut out = vec![0u8; len as usize];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = (n >> (8 * (len as usize - 1 - i))) as u8;
            }
            out[0] |= 1 << (8 - len);
            return out;
        }
    }
    let mut out = vec![0x01];
    out.extend_from_slice(&n.to_be_bytes()[1..]);
    out
}

fn elem(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = id_bytes(id);
    out.extend(size(payload.len()));
    out.extend_from_slice(payload);
    out
}

fn uint(id: u32, v: u64) -> Vec<u8> {
    let b = v.to_be_bytes();
    let skip = b.iter().position(|&x| x != 0).unwrap_or(7);
    elem(id, &b[skip..])
}

/// An unsigned integer always 8 bytes wide, so the element's size doesn't depend on it.
fn uint8(id: u32, v: u64) -> Vec<u8> {
    elem(id, &v.to_be_bytes())
}

fn float(id: u32, v: f64) -> Vec<u8> {
    elem(id, &v.to_be_bytes())
}

fn string(id: u32, s: &str) -> Vec<u8> {
    elem(id, s.as_bytes())
}

fn concat(parts: impl IntoIterator<Item = Vec<u8>>) -> Vec<u8> {
    parts.into_iter().flatten().collect()
}

/// Opus's identification header (RFC 7845 §5.1), which WebM carries as CodecPrivate.
pub fn opus_head(channels: u8, pre_skip: u16, input_rate: u32) -> Vec<u8> {
    let mut out = b"OpusHead".to_vec();
    out.push(1);
    out.push(channels);
    out.extend_from_slice(&pre_skip.to_le_bytes());
    out.extend_from_slice(&input_rate.to_le_bytes());
    out.extend_from_slice(&0i16.to_le_bytes());
    out.push(0);
    out
}

const EBML: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
const TRACKS: u32 = 0x1654_AE6B;
const CHAPTERS: u32 = 0x1043_A770;
const CLUSTER: u32 = 0x1F43_B675;
const CUES: u32 = 0x1C53_BB6B;

fn seek_head(positions: &[(u32, u64)]) -> Vec<u8> {
    let seeks = positions
        .iter()
        .map(|&(id, pos)| elem(SEEK, &concat([elem(SEEK_ID, &id_bytes(id)), uint8(SEEK_POSITION, pos)])));
    elem(SEEK_HEAD, &concat(seeks))
}

// Spec: AUD-7
/// The whole file, for a track of Opus packets, with a title and chapters.
pub fn webm_opus(track: &OpusTrack, title: &str, chapters: &[Chapter]) -> Vec<u8> {
    let header = elem(
        EBML,
        &concat([
            uint(0x4286, 1),
            uint(0x42F7, 1),
            uint(0x42F2, 4),
            uint(0x42F3, 8),
            string(0x4282, "webm"),
            uint(0x4287, 4),
            uint(0x4285, 2),
        ]),
    );
    let info = elem(
        INFO,
        &concat([
            uint(0x2A_D7B1, 1_000_000),
            float(0x4489, track.duration_ms),
            string(0x4D80, "Commonplace"),
            string(0x5741, "Commonplace"),
            string(0x7BA9, title),
        ]),
    );
    let tracks = elem(
        TRACKS,
        &elem(
            0xAE,
            &concat([
                uint(0xD7, 1),
                uint(0x73C5, 1),
                uint(0x83, 2),
                string(0x86, "A_OPUS"),
                elem(0x63A2, &opus_head(track.channels, track.pre_skip, track.input_rate)),
                uint(0x56AA, u64::from(track.pre_skip) * 1_000_000_000 / 48_000),
                uint(0x56BB, 80_000_000),
                elem(0xE1, &concat([float(0xB5, 48_000.0), uint(0x9F, u64::from(track.channels))])),
            ]),
        ),
    );
    let atoms = chapters.iter().enumerate().map(|(i, c)| {
        elem(
            0xB6,
            &concat([
                uint(0x73C4, i as u64 + 1),
                uint(0x91, c.start_ms * 1_000_000),
                elem(0x80, &concat([string(0x85, &c.title), string(0x437C, "eng")])),
            ]),
        )
    });
    let chapters_el = elem(CHAPTERS, &elem(0x45B9, &concat(atoms)));

    // Clusters, every CLUSTER_MS, remembering each one's time and where it starts.
    let mut clusters: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut current: Option<(u64, Vec<u8>)> = None;
    for (i, packet) in track.packets.iter().enumerate() {
        let t = i as u64 * track.frame_ms;
        if current.as_ref().is_none_or(|(start, _)| t - start >= CLUSTER_MS) {
            if let Some(done) = current.take() {
                clusters.push(done);
            }
            current = Some((t, uint(0xE7, t)));
        }
        if let Some((start, body)) = current.as_mut() {
            let offset = i16::try_from(t - *start).unwrap_or(i16::MAX);
            let mut block = vec![0x81];
            block.extend_from_slice(&offset.to_be_bytes());
            block.push(0x80);
            block.extend_from_slice(packet);
            body.extend(elem(0xA3, &block));
        }
    }
    clusters.extend(current);
    let clusters: Vec<(u64, Vec<u8>)> = clusters.into_iter().map(|(t, body)| (t, elem(CLUSTER, &body))).collect();

    // Where everything is, from the start of the Segment's data.
    let head_len = seek_head(&[(INFO, 0), (TRACKS, 0), (CHAPTERS, 0), (CUES, 0)]).len() as u64;
    let info_at = head_len;
    let tracks_at = info_at + info.len() as u64;
    let chapters_at = tracks_at + tracks.len() as u64;
    let mut at = chapters_at + chapters_el.len() as u64;
    let mut cue_points = Vec::new();
    for (t, c) in &clusters {
        cue_points.push(elem(0xBB, &concat([uint(0xB3, *t), elem(0xB7, &concat([uint(0xF7, 1), uint(0xF1, at)]))])));
        at += c.len() as u64;
    }
    let cues_at = at;
    let cues = elem(CUES, &concat(cue_points));
    let head = seek_head(&[(INFO, info_at), (TRACKS, tracks_at), (CHAPTERS, chapters_at), (CUES, cues_at)]);

    let body = concat([head, info, tracks, chapters_el].into_iter().chain(clusters.into_iter().map(|(_, c)| c)).chain([cues]));
    concat([header, elem(SEGMENT, &body)])
}

#[cfg(test)]
pub mod read {
    //! Just enough EBML reading to check what's written.

    /// The element at `at`: its id, where its data starts, and how long it is.
    pub fn element(b: &[u8], at: usize) -> Option<(u32, usize, usize)> {
        let first = *b.get(at)?;
        let id_len = first.leading_zeros() as usize + 1;
        let mut id = 0u32;
        for i in 0..id_len {
            id = (id << 8) | u32::from(*b.get(at + i)?);
        }
        let s = at + id_len;
        let first = *b.get(s)?;
        let len = first.leading_zeros() as usize + 1;
        let mut size = u64::from(first & (0xFF >> len));
        for i in 1..len {
            size = (size << 8) | u64::from(*b.get(s + i)?);
        }
        Some((id, s + len, size as usize))
    }

    /// The children of the element whose data is `b[from..to]`.
    pub fn children(b: &[u8], from: usize, to: usize) -> Vec<(u32, usize, usize)> {
        let mut out = Vec::new();
        let mut at = from;
        while at < to {
            let Some((id, data, len)) = element(b, at) else { break };
            out.push((id, data, len));
            at = data + len;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::read::{children, element};
    use super::*;

    #[test]
    fn sizes_are_ebml_vints() {
        assert_eq!(size(0), vec![0x80]);
        assert_eq!(size(126), vec![0xFE]);
        assert_eq!(size(127), vec![0x40, 0x7F]);
        assert_eq!(size(300), vec![0x41, 0x2C]);
        assert_eq!(id_bytes(0x1A45_DFA3), vec![0x1A, 0x45, 0xDF, 0xA3]);
        assert_eq!(id_bytes(0xA3), vec![0xA3]);
    }

    #[test]
    fn a_file_with_clusters_cues_and_chapters() {
        let packets: Vec<Vec<u8>> = (0..600).map(|i| vec![0xF8, (i % 256) as u8]).collect();
        let track = OpusTrack { packets: &packets, frame_ms: 20, pre_skip: 312, channels: 1, input_rate: 24_000, duration_ms: 12_000.0 };
        let chapters = [Chapter { title: "One".into(), start_ms: 0 }, Chapter { title: "Two".into(), start_ms: 6_000 }];
        let b = webm_opus(&track, "A paper", &chapters);
        let (ebml, data, len) = element(&b, 0).unwrap();
        assert_eq!(ebml, EBML);
        let (segment, seg_data, seg_len) = element(&b, data + len).unwrap();
        assert_eq!(segment, SEGMENT);
        assert_eq!(seg_data + seg_len, b.len(), "the Segment's size is the rest of the file");
        let top = children(&b, seg_data, seg_data + seg_len);
        let ids: Vec<u32> = top.iter().map(|c| c.0).collect();
        assert_eq!(ids[..4], [SEEK_HEAD, INFO, TRACKS, CHAPTERS]);
        let clusters: Vec<_> = top.iter().filter(|c| c.0 == CLUSTER).collect();
        assert_eq!(clusters.len(), 3, "12 s in clusters of 5 s");
        let blocks: usize = clusters.iter().map(|&&(_, d, l)| children(&b, d, d + l).iter().filter(|c| c.0 == 0xA3).count()).sum();
        assert_eq!(blocks, 600);
        // Each cue points at a cluster, from the start of the Segment's data.
        let cues = top.iter().find(|c| c.0 == CUES).unwrap();
        let points = children(&b, cues.1, cues.1 + cues.2);
        assert_eq!(points.len(), 3);
        for (point, cluster) in points.iter().zip(&clusters) {
            let tp = children(&b, point.1, point.1 + point.2).into_iter().find(|c| c.0 == 0xB7).unwrap();
            let pos = children(&b, tp.1, tp.1 + tp.2).into_iter().find(|c| c.0 == 0xF1).unwrap();
            let mut v = 0usize;
            for &x in &b[pos.1..pos.1 + pos.2] {
                v = (v << 8) | x as usize;
            }
            let (id, _, _) = element(&b, seg_data + v).unwrap();
            assert_eq!(id, CLUSTER);
            assert_eq!(seg_data + v + id_bytes(CLUSTER).len(), cluster.1 - size(cluster.2).len());
        }
        // The SeekHead points at the Cues.
        let head = top[0];
        let last = children(&b, head.1, head.1 + head.2).pop().unwrap();
        let pos = children(&b, last.1, last.1 + last.2).into_iter().find(|c| c.0 == SEEK_POSITION).unwrap();
        let v = u64::from_be_bytes(b[pos.1..pos.1 + 8].try_into().unwrap()) as usize;
        assert_eq!(element(&b, seg_data + v).unwrap().0, CUES);
    }
}
