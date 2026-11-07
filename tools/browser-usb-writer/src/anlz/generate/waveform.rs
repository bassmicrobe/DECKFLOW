//! Waveform sections computed from decoded audio.
//!
//! The rules were recovered by comparing rekordbox 7.2 analysis files with the
//! audio they describe (1070 tracks, issue #147). Two of them reproduce
//! rekordbox byte for byte on 99.5% of columns: the monochrome height and the
//! whiteness of the scrolling waveform. The colour and three-band sections are
//! approximations fitted to the same data; their exact filters and gains are
//! not recoverable and the tests compare them with a tolerance.
//!
//! Column grid: every detail section has 150 columns per second, column `i`
//! covering samples `[round(i * rate / 150), round((i + 1) * rate / 150))` of
//! the mono mix `(L + R) / 2`. The previews (400, 100 and 1200 columns) are
//! aggregates of those columns.
//!
//! Tracks are measured as they are decoded ([`Meter`]), so only the columns
//! are ever held, a few MB for a whole track (issue #171).

use crate::anlz::section::{section, Section};

/// Preview and detail waveforms of one track.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Waveforms {
    /// `PWV3`: 5-bit height, 3-bit whiteness per 1/150 s.
    pub pwv3: Vec<u8>,
    /// `PWV5`: rrrgggbbbhhhhh00 per 1/150 s.
    pub pwv5: Vec<u16>,
    /// `PWV7`: low, mid, high per 1/150 s, 0..=127.
    pub pwv7: Vec<[u8; 3]>,
    /// `PWVC`: low, mid, high gain.
    pub gains: [u16; 3],
    /// `PWAV`: 400 columns.
    pub pwav: Vec<u8>,
    /// `PWV2`: 100 columns, 4-bit height.
    pub pwv2: Vec<u8>,
    /// `PWV6`: 1200 columns of low, mid, high.
    pub pwv6: Vec<[u8; 3]>,
    /// `PWV4`: 1200 columns of six bytes.
    pub pwv4: Vec<[u8; 6]>,
}

const COLUMNS_PER_SECOND: f64 = 150.0;
const PREVIEW_COLUMNS: usize = 400;
const TINY_COLUMNS: usize = 100;
const COLOUR_COLUMNS: usize = 1200;

/// Second-order Butterworth low-pass whose peak, relative to the column peak,
/// is the whiteness.
const WHITENESS_LOWPASS_HZ: f64 = 150.0;
/// Three-band crossovers.
const LOW_HZ: f64 = 300.0;
const MID_LOW_HZ: f64 = 250.0;
const MID_HIGH_HZ: f64 = 1500.0;
const HIGH_HZ: f64 = 2500.0;
/// Per-column release of the band envelopes (low, mid, high).
const RELEASE: [f64; 3] = [0.97, 0.93, 0.90];
/// Gain rule per band: `clamp(round(target / max_envelope), floor, cap)`, and
/// the byte scale applied on top of the gain.
/// rekordbox never writes a preview column lower than these: on the
/// reference stick every `PWAV` height is at least 2 and every `PWV2` byte
/// at least 1 (587 of 587 `.DAT` files). Nexus-era firmware reads a zero
/// column as an unfinished preview and draws its own (issue #285).
const PWAV_MIN_HEIGHT: u8 = 2;
const PWV2_MIN_HEIGHT: u8 = 1;
/// What rekordbox writes for its quietest `PWAV` columns: height 2,
/// whiteness 5 (8449 of the 9809 height-2 columns on the reference stick).
const PWAV_FLOOR: u8 = (5 << 5) | PWAV_MIN_HEIGHT;

const GAIN_TARGET: [f64; 3] = [78.0, 105.0, 115.0];
const GAIN_FLOOR: [u16; 3] = [80, 80, 95];
const GAIN_CAP: [u16; 3] = [267, 300, 500];
const BAND_SCALE: [f64; 3] = [1.25, 1.15, 0.6];
/// `PWV6` is the column mean of `PWV7` times these; `PWV4` bytes 3..=5 are
/// `PWV6` times these.
const PWV6_SCALE: [f64; 3] = [0.56, 0.71, 2.0];
const PWV4_SCALE: [f64; 3] = [2.4, 1.6, 1.1];

/// Direct form I biquad.
#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a0: f64, a1: f64, a2: f64) -> Self {
        Biquad {
            b: [b[0] / a0, b[1] / a0, b[2] / a0],
            a: [a1 / a0, a2 / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    /// RBJ cookbook low-pass, Q = 1/sqrt(2).
    fn lowpass(fc: f64, rate: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * fc / rate;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        Self::new(
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0],
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    fn highpass(fc: f64, rate: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * fc / rate;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        Self::new(
            [(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0],
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    #[inline]
    fn step(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// Per-column measurements at 150 columns per second.
#[derive(Debug, Default, Clone)]
pub(crate) struct Column {
    peak: f64,
    white: f64,
    band: [f64; 3],
    sumsq: f64,
    samples: u32,
}

/// A decoded track reduced to its columns and the numbers the rest of the
/// analysis needs.
#[derive(Debug, Clone, Default)]
pub struct Measured {
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: u64,
    pub(crate) columns: Vec<Column>,
}

impl Measured {
    pub fn duration_ms(&self) -> f64 {
        self.frames as f64 * 1000.0 / self.sample_rate.max(1) as f64
    }
}

/// Measures interleaved audio into columns as it arrives.
pub struct Meter {
    sample_rate: u32,
    rate: f64,
    channels: usize,
    frames: u64,
    /// Finished columns; `current` is the one being filled.
    columns: Vec<Column>,
    current: Column,
    next_edge: u64,
    /// Whiteness low-pass, low, mid high-pass, mid low-pass, high.
    filters: [Biquad; 5],
}

impl Meter {
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        let rate = sample_rate.max(1) as f64;
        Meter {
            sample_rate,
            rate,
            channels,
            frames: 0,
            columns: Vec::new(),
            current: Column::default(),
            next_edge: (rate / COLUMNS_PER_SECOND).round() as u64,
            filters: [
                Biquad::lowpass(WHITENESS_LOWPASS_HZ, rate),
                Biquad::lowpass(LOW_HZ, rate),
                Biquad::highpass(MID_LOW_HZ, rate),
                Biquad::lowpass(MID_HIGH_HZ, rate),
                Biquad::highpass(HIGH_HZ, rate),
            ],
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) {
        let channels = self.channels.max(1);
        // locals, so the per-sample state stays in registers
        let [mut white, mut low, mut mid_hp, mut mid_lp, mut high] = self.filters;
        let (mut frames, mut next_edge) = (self.frames, self.next_edge);
        let mut c = std::mem::take(&mut self.current);
        for frame in interleaved.chunks_exact(channels) {
            while frames >= next_edge {
                self.columns.push(std::mem::take(&mut c));
                next_edge = ((self.columns.len() + 1) as f64 * self.rate / COLUMNS_PER_SECOND)
                    .round() as u64;
            }
            let x = frame.iter().map(|&s| s as f64).sum::<f64>() / channels as f64;
            c.peak = c.peak.max(x.abs());
            c.white = c.white.max(white.step(x).abs());
            c.band[0] = c.band[0].max(low.step(x).abs());
            c.band[1] = c.band[1].max(mid_lp.step(mid_hp.step(x)).abs());
            c.band[2] = c.band[2].max(high.step(x).abs());
            c.sumsq += x * x;
            c.samples += 1;
            frames += 1;
        }
        self.current = c;
        self.filters = [white, low, mid_hp, mid_lp, high];
        (self.frames, self.next_edge) = (frames, next_edge);
    }

    /// `ceil(frames * 150 / rate)` columns: a last column that starts at
    /// the end of the audio stays empty.
    pub fn finish(mut self) -> Measured {
        let n = ((self.frames as f64 * COLUMNS_PER_SECOND / self.rate).ceil() as usize).max(1);
        self.columns.push(self.current);
        debug_assert!(self.columns.len() <= n);
        self.columns.resize(n, Column::default());
        Measured {
            sample_rate: self.sample_rate,
            channels: self.channels,
            frames: self.frames,
            columns: self.columns,
        }
    }
}

/// `floor(31.5 * (peak / track peak)^2)`, rekordbox's height rule.
fn height(peak: f64, track_peak: f64) -> u8 {
    if track_peak <= 0.0 {
        return 0;
    }
    let q = peak / track_peak;
    ((31.5 * q * q).floor() as u8).min(31)
}

/// `7 - floor(8 * lowpassed peak / peak)`; silence counts as white.
fn whiteness(low: f64, peak: f64) -> u8 {
    if peak <= 0.0 {
        return 7;
    }
    let r = (low / peak).clamp(0.0, 1.0);
    (7 - ((8.0 * r).floor() as i32).min(7)) as u8
}

/// Mean of `values[a..b]` with `b > a` guaranteed by the caller.
fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

/// Split `n` items into `parts` consecutive ranges, each at least one item
/// long (ranges overlap when `n < parts`).
fn ranges(n: usize, parts: usize) -> impl Iterator<Item = std::ops::Range<usize>> {
    (0..parts).map(move |k| {
        let a = (k * n / parts).min(n - 1);
        let b = ((k + 1) * n / parts).clamp(a + 1, n);
        a..b
    })
}

pub fn analyze(audio: &Measured) -> Waveforms {
    let columns = &audio.columns;
    let n = columns.len();
    let track_peak = columns.iter().map(|c| c.peak).fold(0.0, f64::max);

    let heights: Vec<u8> = columns.iter().map(|c| height(c.peak, track_peak)).collect();
    let whites: Vec<u8> = columns.iter().map(|c| whiteness(c.white, c.peak)).collect();
    let pwv3: Vec<u8> = heights
        .iter()
        .zip(&whites)
        .map(|(h, w)| (w << 5) | h)
        .collect();

    // Band envelopes with release, then the gain that scales the loudest
    // column of each band to its target level.
    let mut env = vec![[0.0f64; 3]; n];
    for (i, c) in columns.iter().enumerate() {
        for j in 0..3 {
            let prev = if i == 0 {
                0.0
            } else {
                env[i - 1][j] * RELEASE[j]
            };
            env[i][j] = c.band[j].max(prev);
        }
    }
    let mut gains = [0u16; 3];
    for j in 0..3 {
        let max = env.iter().map(|e| e[j]).fold(0.0, f64::max);
        gains[j] = if max > 0.0 {
            ((GAIN_TARGET[j] / max).round() as u16).clamp(GAIN_FLOOR[j], GAIN_CAP[j])
        } else {
            GAIN_FLOOR[j]
        };
    }
    let pwv7: Vec<[u8; 3]> = env
        .iter()
        .map(|e| {
            let mut out = [0u8; 3];
            for j in 0..3 {
                out[j] = (BAND_SCALE[j] * gains[j] as f64 * e[j]).round().min(127.0) as u8;
            }
            out
        })
        .collect();

    // Colour: each band's share of the strongest band, on a square root so
    // faint bands still tint the column.
    let pwv5: Vec<u16> = columns
        .iter()
        .zip(&heights)
        .map(|(c, &h)| {
            let max = c.band.iter().cloned().fold(0.0, f64::max);
            let level = |b: f64| -> u16 {
                if max <= 0.0 {
                    0
                } else {
                    (7.0 * (b / max).sqrt()).round().min(7.0) as u16
                }
            };
            (level(c.band[0]) << 13)
                | (level(c.band[1]) << 10)
                | (level(c.band[2]) << 7)
                | ((h as u16) << 2)
        })
        .collect();

    // Previews from RMS per column group.
    let rms_over = |r: std::ops::Range<usize>| -> f64 {
        let (sumsq, samples) = columns[r]
            .iter()
            .fold((0.0, 0u32), |(s, k), c| (s + c.sumsq, k + c.samples));
        if samples == 0 {
            0.0
        } else {
            (sumsq / samples as f64).sqrt()
        }
    };
    let rms400: Vec<f64> = ranges(n, PREVIEW_COLUMNS).map(rms_over).collect();
    let rms_max = rms400.iter().cloned().fold(0.0, f64::max);
    let whites_f: Vec<f64> = whites.iter().map(|&w| w as f64).collect();
    let white200: Vec<u8> = ranges(n, PREVIEW_COLUMNS / 2)
        .map(|r| mean(&whites_f[r]).round() as u8)
        .collect();
    let pwav: Vec<u8> = rms400
        .iter()
        .enumerate()
        .map(|(k, &rms)| {
            let h = if rms_max > 0.0 {
                (24.0 * rms / rms_max).round() as u8
            } else {
                0
            };
            if h < PWAV_MIN_HEIGHT {
                PWAV_FLOOR
            } else {
                (white200[k / 2].min(7) << 5) | h.min(31)
            }
        })
        .collect();
    let rms100: Vec<f64> = ranges(n, TINY_COLUMNS).map(rms_over).collect();
    let rms100_max = rms100.iter().cloned().fold(0.0, f64::max);
    let pwv2: Vec<u8> = rms100
        .iter()
        .map(|&rms| {
            let h = if rms100_max > 0.0 {
                ((15.0 * (rms / rms100_max).sqrt()).round() as u8).min(15)
            } else {
                0
            };
            h.max(PWV2_MIN_HEIGHT)
        })
        .collect();

    // Three-band and colour previews from the detail bytes.
    let band_f: Vec<[f64; 3]> = pwv7
        .iter()
        .map(|b| [b[0] as f64, b[1] as f64, b[2] as f64])
        .collect();
    let pwv6: Vec<[u8; 3]> = ranges(n, COLOUR_COLUMNS)
        .map(|r| {
            let mut out = [0u8; 3];
            for j in 0..3 {
                let m = band_f[r.clone()].iter().map(|b| b[j]).sum::<f64>() / r.len() as f64;
                out[j] = (PWV6_SCALE[j] * m).round().min(127.0) as u8;
            }
            out
        })
        .collect();
    let pwv4: Vec<[u8; 6]> = pwv6
        .iter()
        .map(|b6| {
            let mut b = [0u8; 6];
            for j in 0..3 {
                b[3 + j] = (PWV4_SCALE[j] * b6[j] as f64).round().min(127.0) as u8;
            }
            let (r, g, bl) = (b[3] as f64, b[4] as f64, b[5] as f64);
            let max = r.max(g).max(bl);
            if max > 0.0 {
                b[2] = (0.91 * (r * r + g * g + bl * bl).sqrt()).round().min(127.0) as u8;
                b[0] = (0.88 * max + 38.0).round().min(127.0) as u8;
                b[1] = (203.0 - 0.49 * b[0] as f64).round().clamp(0.0, 255.0) as u8;
            }
            b
        })
        .collect();

    Waveforms {
        pwv3,
        pwv5,
        pwv7,
        gains,
        pwav,
        pwv2,
        pwv6,
        pwv4,
    }
}

fn be32(v: u32) -> [u8; 4] {
    v.to_be_bytes()
}

impl Waveforms {
    /// `PWAV` and `PWV2` for the `.DAT` file, in rekordbox's order.
    pub fn dat_sections(&self) -> Vec<Section> {
        vec![
            preview_section(b"PWAV", &self.pwav),
            preview_section(b"PWV2", &self.pwv2),
        ]
    }

    /// `PWV3`, `PWV5` and `PWV4` for the `.EXT` file (callers place `PWV3`
    /// first and the other two after the cue and grid sections).
    pub fn pwv3_section(&self) -> Section {
        detail_section(b"PWV3", 1, 0x0096_0000, &self.pwv3)
    }

    pub fn pwv5_section(&self) -> Section {
        let bytes: Vec<u8> = self.pwv5.iter().flat_map(|v| v.to_be_bytes()).collect();
        detail_section(b"PWV5", 2, 0x0096_0305, &bytes)
    }

    pub fn pwv4_section(&self) -> Section {
        let bytes: Vec<u8> = self.pwv4.iter().flatten().copied().collect();
        detail_section(b"PWV4", 6, 0, &bytes)
    }

    /// `PWV7`, `PWV6` and `PWVC` for the `.2EX` file, in rekordbox's order.
    pub fn two_ex_sections(&self) -> Vec<Section> {
        let pwv7: Vec<u8> = self.pwv7.iter().flatten().copied().collect();
        let pwv6: Vec<u8> = self.pwv6.iter().flatten().copied().collect();
        let mut p6 = Vec::with_capacity(8 + pwv6.len());
        p6.extend_from_slice(&be32(3));
        p6.extend_from_slice(&be32(self.pwv6.len() as u32));
        p6.extend_from_slice(&pwv6);
        let mut pc = Vec::with_capacity(8);
        pc.extend_from_slice(&0u16.to_be_bytes());
        for g in self.gains {
            pc.extend_from_slice(&g.to_be_bytes());
        }
        vec![
            detail_section(b"PWV7", 3, 0x0096_0000, &pwv7),
            section(b"PWV6", 0x14, &p6),
            section(b"PWVC", 0x0e, &pc),
        ]
    }
}

/// `len_data, 0x00010000, data` with a 20-byte header (`PWAV`, `PWV2`).
fn preview_section(tag: &[u8; 4], data: &[u8]) -> Section {
    let mut p = Vec::with_capacity(8 + data.len());
    p.extend_from_slice(&be32(data.len() as u32));
    p.extend_from_slice(&be32(0x0001_0000));
    p.extend_from_slice(data);
    section(tag, 0x14, &p)
}

/// `len_entry_bytes, len_entries, unknown, data` with a 24-byte header.
fn detail_section(tag: &[u8; 4], entry_bytes: u32, unknown: u32, data: &[u8]) -> Section {
    let mut p = Vec::with_capacity(12 + data.len());
    p.extend_from_slice(&be32(entry_bytes));
    p.extend_from_slice(&be32(data.len() as u32 / entry_bytes));
    p.extend_from_slice(&be32(unknown));
    p.extend_from_slice(data);
    section(tag, 0x18, &p)
}
