//! `PQTZ` beat grid from the XML `TEMPO` list, and the empty `PQT2`.
//!
//! Expansion rule, found by comparing against rekordbox 7 analysis files:
//! every `TEMPO` opens a segment of beats at `Inizio + i * 60000 / Bpm`
//! milliseconds, rounded to the nearest ms, numbered from `Battito` and
//! cycling 1..=4. A segment followed by another one holds
//! `round((next.Inizio - Inizio) / period)` beats (at least one); the last
//! segment runs while the unrounded time is below the track duration.
//!
//! Grids edited in rekordbox carry segments whose `Bpm` does not describe
//! their spacing (a one-beat `Bpm="654.33"` on a 140 BPM track), where that
//! count is wrong. The `Battito` step to the next `TEMPO` is the count mod 4
//! on every segment of a real export, so it settles those (issue #212).

use crate::anlz::section::{section, Section};
use crate::collection::Tempo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Beat {
    /// Position in the bar, 1..=4.
    pub number: u16,
    /// BPM x 100.
    pub tempo: u16,
    pub time_ms: u32,
}

/// Beats in a segment `x` periods long. `step` is the `Battito` difference
/// to the next `TEMPO` mod 4, when the track's `Battito` can be trusted.
fn segment_beats(x: f64, step: Option<u32>) -> usize {
    let rounded = x.round().max(1.0);
    let Some(step) = step else {
        return rounded as usize;
    };
    let fits = |c: f64| (x - c).abs() <= c * 0.01;
    if fits(rounded) && rounded as u32 % 4 == step {
        return rounded as usize;
    }
    let first = if step == 0 { 4.0 } else { step as f64 };
    let nearest = first + 4.0 * ((x - first) / 4.0).round().max(0.0);
    if fits(nearest) {
        nearest as usize
    } else {
        first as usize
    }
}

pub fn beats(tempos: &[Tempo], duration_ms: f64) -> Vec<Beat> {
    // Some writers put `Battito="1"` on every `TEMPO`; that says nothing.
    let bar_steps = tempos.iter().all(|t| (1..=4).contains(&t.battito))
        && tempos.iter().any(|t| t.battito != tempos[0].battito);
    let mut out = Vec::new();
    for (k, t) in tempos.iter().enumerate() {
        if t.bpm <= 0.0 || !t.bpm.is_finite() {
            continue;
        }
        let period = 60000.0 / t.bpm;
        let start = t.inizio * 1000.0;
        let count = match tempos.get(k + 1) {
            Some(next) => segment_beats(
                (next.inizio * 1000.0 - start) / period,
                bar_steps.then(|| (next.battito + 4 - t.battito) % 4),
            ),
            None => {
                let mut n = 0;
                while start + n as f64 * period < duration_ms {
                    n += 1;
                }
                n
            }
        };
        let tempo = (t.bpm * 100.0).round() as u16;
        let mut number = t.battito.clamp(1, 4) as u16;
        for i in 0..count {
            out.push(Beat {
                number,
                tempo,
                time_ms: (start + i as f64 * period).round() as u32,
            });
            number = number % 4 + 1;
        }
    }
    out
}

pub fn pqtz(tempos: &[Tempo], duration_ms: f64) -> Section {
    let beats = beats(tempos, duration_ms);
    let mut payload = Vec::with_capacity(12 + 8 * beats.len());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.extend_from_slice(&0x0008_0000u32.to_be_bytes());
    payload.extend_from_slice(&(beats.len() as u32).to_be_bytes());
    for b in &beats {
        payload.extend_from_slice(&b.number.to_be_bytes());
        payload.extend_from_slice(&b.tempo.to_be_bytes());
        payload.extend_from_slice(&b.time_ms.to_be_bytes());
    }
    section(b"PQTZ", 0x18, &payload)
}

/// `PQT2` as rekordbox writes it without an extended grid (56 bytes).
pub fn pqt2_empty() -> Section {
    let mut payload = [0u8; 44];
    payload[4..8].copy_from_slice(&[0x01, 0x00, 0x00, 0x02]);
    section(b"PQT2", 0x38, &payload)
}
