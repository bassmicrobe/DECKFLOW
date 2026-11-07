#[derive(Debug, Clone, Default)]
pub struct Tempo {
    pub inizio: f64,
    pub bpm: f64,
    pub metro: String,
    pub battito: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Cue {
    pub name: String,
    /// rekordbox `Type`: 0 cue, 1 fade-in, 2 fade-out, 3 load, 4 loop.
    pub kind: u32,
    pub start: f64,
    pub end: Option<f64>,
    /// -1 memory cue, 0..=7 hot cue A..H.
    pub num: i32,
    pub rgb: Option<(u8, u8, u8)>,
    /// `Name` started with [`ACTIVE_LOOP_MARKER`], which is not kept in `name`.
    pub marked: bool,
}

impl Cue {
    pub fn is_hot(&self) -> bool {
        self.num >= 0
    }
    pub fn is_loop(&self) -> bool {
        self.kind == 4 || self.end.is_some()
    }
    pub fn is_memory_loop(&self) -> bool {
        !self.is_hot() && self.is_loop()
    }
}

/// The XML has no field for an active loop (a memory loop the player engages
/// when playback reaches it), so a memory loop whose `Name` starts with this,
/// in any case, is one (issue #210).
pub const ACTIVE_LOOP_MARKER: &str = "[active]";

fn split_marker(name: String) -> (String, bool) {
    let trimmed = name.trim_start();
    match trimmed.get(..ACTIVE_LOOP_MARKER.len()) {
        Some(head) if head.eq_ignore_ascii_case(ACTIVE_LOOP_MARKER) => (
            trimmed[ACTIVE_LOOP_MARKER.len()..].trim_start().to_string(),
            true,
        ),
        _ => (name, false),
    }
}

/// The track's active loop: players take one, so the earliest marked memory loop.
pub fn active_loop(cues: &[Cue]) -> Option<&Cue> {
    cues.iter()
        .filter(|c| c.marked && c.is_memory_loop())
        .min_by(|a, b| a.start.total_cmp(&b.start))
}

#[derive(Debug, Clone, Default)]
pub struct Track {
    pub id: u64,
    pub name: String,
    pub artist: String,
    pub composer: String,
    pub album: String,
    pub grouping: String,
    pub genre: String,
    pub kind: String,
    pub size: u64,
    pub total_time: u32,
    pub disc_number: u32,
    pub track_number: u32,
    pub year: u32,
    pub average_bpm: f64,
    pub date_added: String,
    pub bit_rate: u32,
    pub sample_rate: u32,
    pub comments: String,
    pub play_count: u32,
    /// 0, 51, 102, 153, 204, 255 for 0..=5 stars.
    pub rating: u32,
    /// Decoded filesystem path.
    pub location: String,
    pub remixer: String,
    pub tonality: String,
    pub label: String,
    pub mix: String,
    /// `0xRRGGBB`.
    pub colour: Option<u32>,
    pub tempos: Vec<Tempo>,
    pub cues: Vec<Cue>,
}

impl Track {
    pub fn file_name(&self) -> &str {
        self.location.rsplit('/').next().unwrap_or(&self.location)
    }
    pub fn stars(&self) -> u8 {
        (self.rating / 51).min(5) as u8
    }
    /// BPM of the first grid segment, or `AverageBpm` without a grid; loop
    /// lengths in the cue sections are counted in these beats.
    pub fn grid_bpm(&self) -> f64 {
        self.tempos.first().map_or(self.average_bpm, |t| t.bpm)
    }
}
