//! Cue sections. rekordbox's local analysis files carry empty `PCOB`/`PCO2`
//! containers and rekordbox fills them from its database at export time;
//! `expressport` fills them from `POSITION_MARK` instead. Layouts were read
//! off a real export and are reproduced byte for byte by the tests.

use super::section::{section, AnlzFile, Section};
use crate::collection::{active_loop, Cue};

const HOT: u32 = 1;
const MEMORY: u32 = 0;
const NO_LOOP: u32 = 0xFFFF_FFFF;
/// `PCPT` status of an active loop; every other entry has 0.
const ACTIVE_LOOP: u32 = 4;
/// Hot cues A to H are `Num` 0..=7.
const HOT_CUES: i32 = 8;
/// A to C go into the `.DAT` `PCOB`, D to H into the `.EXT` one.
const DAT_HOT_CUES: i32 = 3;

fn ms(seconds: f64) -> u32 {
    (seconds * 1000.0).round() as u32
}

/// Split into (hot, memory). rekordbox writes each list in the reverse of
/// the XML `POSITION_MARK` order (its database order); the prev/next chain
/// in `PCPT` then simply follows list position. Verified on a real export
/// whose memory cues were neither ascending nor descending in time.
/// Hot cues past H, which an XML from another tool can carry, are dropped.
fn split(cues: &[Cue]) -> (Vec<&Cue>, Vec<&Cue>) {
    let (mut hot, mut mem): (Vec<&Cue>, Vec<&Cue>) = cues
        .iter()
        .filter(|c| c.num < HOT_CUES)
        .partition(|c| c.is_hot());
    hot.reverse();
    mem.reverse();
    (hot, mem)
}

fn cue_type(c: &Cue) -> u8 {
    if c.is_loop() {
        2
    } else {
        1
    }
}

fn loop_ms(c: &Cue) -> u32 {
    c.end.filter(|_| c.is_loop()).map(ms).unwrap_or(NO_LOOP)
}

/// `PCOB` (56-byte `PCPT` entries); the `.EXT` file keeps an empty one for
/// the memory list. The entry for `active` is marked as the active loop, the
/// way rekordbox marks one (the reference export's only loop).
fn pcob(list: u32, cues: &[&Cue], active: Option<&Cue>) -> Section {
    let mut p = Vec::with_capacity(12 + cues.len() * 56);
    p.extend_from_slice(&list.to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes());
    p.extend_from_slice(&(cues.len() as u16).to_be_bytes());
    let memory_count = if list == MEMORY && !cues.is_empty() {
        cues.len() as u32 - 1
    } else {
        NO_LOOP
    };
    p.extend_from_slice(&memory_count.to_be_bytes());
    let n = cues.len();
    for (i, c) in cues.iter().enumerate() {
        p.extend_from_slice(b"PCPT");
        p.extend_from_slice(&0x1cu32.to_be_bytes());
        p.extend_from_slice(&0x38u32.to_be_bytes());
        p.extend_from_slice(&hot_number(c).to_be_bytes());
        let status = if active.is_some_and(|a| std::ptr::eq(a, *c)) {
            ACTIVE_LOOP
        } else {
            0
        };
        p.extend_from_slice(&status.to_be_bytes());
        p.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        let (first, last) = if list == HOT {
            (0xFFFF, 0xFFFF)
        } else {
            (
                if i == 0 { 0xFFFF } else { (i - 1) as u16 },
                if i + 1 == n { 0xFFFF } else { (i + 1) as u16 },
            )
        };
        p.extend_from_slice(&first.to_be_bytes());
        p.extend_from_slice(&last.to_be_bytes());
        p.push(cue_type(c));
        p.extend_from_slice(&[0x00, 0x03, 0xe8]);
        p.extend_from_slice(&ms(c.start).to_be_bytes());
        p.extend_from_slice(&loop_ms(c).to_be_bytes());
        p.extend_from_slice(&[0u8; 16]);
    }
    section(b"PCOB", 0x18, &p)
}

fn hot_number(c: &Cue) -> u32 {
    if c.is_hot() {
        c.num as u32 + 1
    } else {
        0
    }
}

/// The 16 colours of rekordbox's hot cue menu: the code the `.EXT` stores,
/// the colour the XML gives (the one rekordbox shows) and the colour bytes
/// after the code (the player's own palette). Read off rekordbox 7.2.18's
/// export of a hot cue in each colour (issue #236), except light blue and
/// cyan, which were not set there: their XML colours come from rekordbox's
/// menu and their bytes from the same player palette.
const HOT_CUE_COLOURS: [HotCueColour; 16] = [
    (0x01, (48, 90, 255), [0x00, 0x00, 0xff]),
    (0x05, (80, 180, 255), [0x00, 0x70, 0xff]),
    (0x09, (0, 224, 255), [0x00, 0xe0, 0xff]),
    (0x0e, (31, 163, 146), [0x00, 0xff, 0xa3]),
    (0x12, (16, 177, 118), [0x00, 0xff, 0x47]),
    (GREEN, (40, 226, 20), [0x1a, 0xff, 0x00]),
    (0x1a, (165, 225, 22), [0x80, 0xff, 0x00]),
    (0x1e, (180, 190, 4), [0xe6, 0xff, 0x00]),
    (0x20, (195, 175, 4), [0xff, 0xe8, 0x00]),
    (0x26, (224, 100, 27), [0xff, 0x5e, 0x00]),
    (0x2a, (230, 40, 40), [0xff, 0x00, 0x00]),
    (0x2d, (255, 18, 123), [0xff, 0x00, 0x45]),
    (0x31, (222, 68, 207), [0xff, 0x00, 0xa1]),
    (0x38, (180, 50, 255), [0xb3, 0x00, 0xff]),
    (0x3c, (170, 114, 255), [0x4d, 0x00, 0xff]),
    (0x3e, (100, 115, 255), [0x1a, 0x00, 0xff]),
];
const GREEN: u8 = 0x16;
/// `(code, XML colour, colour bytes)`.
type HotCueColour = (u8, (u8, u8, u8), [u8; 3]);
/// rekordbox's hot cue without a colour: code 0, green bytes.
const NO_COLOUR: [u8; 4] = [0, 0x1a, 0xff, 0x00];

/// Hot cue colour bytes `(code, r, g, b)` as rekordbox 7 writes them. The
/// XML colour names one of [`HOT_CUE_COLOURS`]; any other (an XML from
/// another tool) takes the nearest. Green goes out as [`NO_COLOUR`]: the XML
/// gives both green and no colour as 40/226/20, rekordbox wrote both forms
/// for a green hot cue, and both show green. A hot cue without a colour in
/// the XML gets the same.
fn hot_colour(c: &Cue) -> [u8; 4] {
    let Some((r, g, b)) = c.rgb else {
        return NO_COLOUR;
    };
    let distance = |(pr, pg, pb): (u8, u8, u8)| {
        let d = |x: u8, y: u8| (i32::from(x) - i32::from(y)).pow(2);
        d(r, pr) + d(g, pg) + d(b, pb)
    };
    let &(code, _, [dr, dg, db]) = HOT_CUE_COLOURS
        .iter()
        .min_by_key(|(_, xml, _)| distance(*xml))
        .expect("16 colours");
    if code == GREEN {
        NO_COLOUR
    } else {
        [code, dr, dg, db]
    }
}

/// `PCO2` for the `.EXT` file (88-byte `PCP2` entries, longer with a comment).
fn pco2(list: u32, cues: &[&Cue], bpm_for_loops: f64) -> Section {
    let mut p = Vec::new();
    p.extend_from_slice(&list.to_be_bytes());
    p.extend_from_slice(&(cues.len() as u16).to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes());
    for c in cues {
        let comment: Vec<u8> = if c.name.is_empty() {
            Vec::new()
        } else {
            c.name
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_be_bytes)
                .collect()
        };
        let len = 0x2c + comment.len() + 4 + 40;
        let mut e = Vec::with_capacity(len);
        e.extend_from_slice(b"PCP2");
        e.extend_from_slice(&0x10u32.to_be_bytes());
        e.extend_from_slice(&(len as u32).to_be_bytes());
        e.extend_from_slice(&hot_number(c).to_be_bytes());
        e.push(cue_type(c));
        e.extend_from_slice(&[0x00, 0x03, 0xe8]);
        e.extend_from_slice(&ms(c.start).to_be_bytes());
        e.extend_from_slice(&loop_ms(c).to_be_bytes());
        e.push(0); // memory cue colour id: the XML carries none
        e.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0]);
        let (num, den) = loop_fraction(c, bpm_for_loops);
        e.extend_from_slice(&num.to_be_bytes());
        e.extend_from_slice(&den.to_be_bytes());
        e.extend_from_slice(&(comment.len() as u32).to_be_bytes());
        e.extend_from_slice(&comment);
        e.extend_from_slice(&if list == HOT { hot_colour(c) } else { [0; 4] });
        e.resize(len, 0);
        p.extend_from_slice(&e);
    }
    section(b"PCO2", 0x14, &p)
}

/// Quantised loop length in beats, when the loop is a whole number of beats.
fn loop_fraction(c: &Cue, bpm: f64) -> (u16, u16) {
    match c.end {
        Some(end) if c.is_loop() && bpm > 0.0 => {
            let beats = (end - c.start) * bpm / 60.0;
            let rounded = beats.round();
            if rounded >= 1.0 && (beats - rounded).abs() < 0.02 {
                (rounded as u16, 1)
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    }
}

/// Which analysis file the sections are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Dat,
    Ext,
}

/// The cue sections of one analysis file in rekordbox's order: `PCOB` hot,
/// `PCOB` memory, and in the `.EXT` also `PCO2` hot and `PCO2` memory. The
/// `.DAT` `PCOB` holds hot cues A to C and the `.EXT` one D to H (its memory
/// list stays empty); `PCO2` lists them all. Verified on a real export with
/// hot cues A and G. The active loop is marked in the `.DAT` memory list only;
/// rekordbox's `PCP2` entry for it carries no flag.
pub fn sections(kind: Kind, cues: &[Cue], bpm: f64) -> Vec<Section> {
    let (hot, mem) = split(cues);
    let (dat_hot, ext_hot): (Vec<&Cue>, Vec<&Cue>) =
        hot.iter().copied().partition(|c| c.num < DAT_HOT_CUES);
    match kind {
        Kind::Dat => vec![
            pcob(HOT, &dat_hot, None),
            pcob(MEMORY, &mem, active_loop(cues)),
        ],
        Kind::Ext => vec![
            pcob(HOT, &ext_hot, None),
            pcob(MEMORY, &[], None),
            pco2(HOT, &hot, bpm),
            pco2(MEMORY, &mem, bpm),
        ],
    }
}

/// Replace the cue sections of `file` with ones generated from `cues`,
/// keeping rekordbox's section order.
pub fn splice(file: &mut AnlzFile, kind: Kind, cues: &[Cue], bpm: f64) {
    let mut fresh = sections(kind, cues, bpm).into_iter();
    for s in &mut file.sections {
        if matches!(&s.tag, b"PCOB" | b"PCO2") {
            if let Some(n) = fresh.next() {
                *s = n;
            }
        }
    }
}
