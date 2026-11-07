//! Browser-only Device Library writer. Upstream binary layouts are MIT baken
//! 4.10.0, revision 50d2ba07fdad49d3a95e02d2951ac7a67197e85a; see LICENSE.baken.
//! No filesystem, decoder, SQLite, threading, or host service is linked.
#![allow(dead_code)]

mod anlz;
mod collection;
mod layout;
mod mytags;
mod pdb;

use anlz::generate::waveform::Meter;
use anyhow::{bail, ensure, Context, Result};
use collection::{Cue, Tempo, Track};
use pdb::rows::TrackRow;
use pdb::writer::{Export, ExportPlaylist};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TrackInput {
    id: String,
    filename: String,
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    genre: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    comments: String,
    #[serde(default)]
    composer: String,
    #[serde(default)]
    original_artist: String,
    #[serde(default)]
    remixer: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    track_number: u32,
    #[serde(default)]
    disc_number: u16,
    #[serde(default)]
    play_count: u16,
    #[serde(default)]
    year: u16,
    #[serde(default)]
    rating: u8,
    #[serde(default)]
    color_id: u8,
    #[serde(default)]
    date_created: String,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    mix_name: String,
    #[serde(default)]
    added_date: String,
    #[serde(default)]
    codec: String,
    bpm: f64,
    duration: f64,
    #[serde(default)]
    size: u32,
    #[serde(default)]
    sample_rate: u32,
    #[serde(default)]
    bit_rate: u32,
    #[serde(default = "default_depth")]
    bit_depth: u16,
    #[serde(default)]
    tempos: Vec<TempoInput>,
    #[serde(default)]
    position_marks: Vec<CueInput>,
    #[serde(default)]
    usb_path: String,
    #[serde(default)]
    numeric_id: Option<u32>,
    #[serde(default)]
    master_content_id: Option<u32>,
    #[serde(default)]
    reuse_device_file: Option<ReuseDeviceFile>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReuseDeviceFile {
    usb_path: String,
    analysis_path: String,
}
fn default_depth() -> u16 {
    16
}
#[derive(Deserialize, Default)]
struct TempoInput {
    start: f64,
    bpm: f64,
    #[serde(default)]
    meter: String,
    beat: u32,
}
#[derive(Deserialize, Default)]
struct CueInput {
    #[serde(default)]
    name: String,
    #[serde(rename = "type")]
    kind: u32,
    start: f64,
    #[serde(default)]
    end: Option<f64>,
    num: i32,
    #[serde(default)]
    color: Option<(u8, u8, u8)>,
}
impl TrackInput {
    fn track(&self) -> Result<Track> {
        ensure!(
            self.duration.is_finite() && self.duration > 0.0 && self.duration <= 65535.0,
            "Invalid track duration"
        );
        ensure!(
            self.bpm.is_finite() && (20.0..=600.0).contains(&self.bpm),
            "Invalid BPM"
        );
        ensure!(
            self.tempos.len() <= 100000 && self.position_marks.len() <= 1024,
            "Too many tempo or cue entries"
        );
        let mut previous = -1.0;
        let mut tempos = Vec::new();
        for t in &self.tempos {
            ensure!(
                t.start.is_finite()
                    && t.start >= 0.0
                    && t.start < self.duration
                    && t.start > previous,
                "Invalid tempo position"
            );
            ensure!(
                t.bpm.is_finite()
                    && (20.0..=655.35).contains(&t.bpm)
                    && (1..=4).contains(&t.beat)
                    && t.meter == "4/4",
                "Unsupported tempo"
            );
            previous = t.start;
            tempos.push(Tempo {
                inizio: t.start,
                bpm: t.bpm,
                metro: t.meter.clone(),
                battito: t.beat,
            });
        }
        let mut used = [false; 8];
        let mut cues = Vec::new();
        for c in &self.position_marks {
            ensure!(
                c.start.is_finite()
                    && c.start >= 0.0
                    && c.start < self.duration
                    && (-1..=7).contains(&c.num),
                "Invalid cue position"
            );
            ensure!(
                c.name.encode_utf16().count() <= 1024 && c.kind <= 4,
                "Invalid cue metadata"
            );
            if let Some(end) = c.end {
                ensure!(
                    end.is_finite() && end > c.start && end <= self.duration,
                    "Invalid loop end"
                );
            }
            if c.num >= 0 {
                ensure!(!used[c.num as usize], "Duplicate HOT CUE");
                used[c.num as usize] = true;
            }
            let name = c.name.trim_start();
            let marked = name
                .get(..8)
                .is_some_and(|s| s.eq_ignore_ascii_case("[active]"));
            cues.push(Cue {
                name: if marked {
                    name[8..].trim_start().to_string()
                } else {
                    c.name.clone()
                },
                kind: c.kind,
                start: c.start,
                end: c.end,
                num: c.num,
                rgb: c.color,
                marked,
            });
        }
        Ok(Track {
            name: self.title.clone(),
            average_bpm: self.bpm,
            total_time: self.duration.ceil() as u32,
            tempos,
            cues,
            ..Track::default()
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistInput {
    #[serde(default)]
    id: String,
    name: String,
    track_ids: Vec<String>,
    #[serde(default)]
    folder_path: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInput {
    tracks: Vec<TrackInput>,
    #[serde(default)]
    playlists: Vec<PlaylistInput>,
    device_name: String,
    #[serde(default)]
    id_floors: HashMap<String, u32>,
    #[serde(default)]
    device_playlists: Vec<pdb::merge::DevicePlaylist>,
    #[serde(default = "default_true")]
    include_all_playlist: bool,
}
fn default_true() -> bool {
    true
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedTrack {
    id: String,
    numeric_id: u32,
    usb_path: String,
    anlz_dir: String,
    anlz_index: u16,
    anlz_paths: Value,
}

fn named(values: &mut Vec<(u32, String)>, value: &str) -> u32 {
    if value.is_empty() {
        return 0;
    }
    if let Some((id, _)) = values.iter().find(|(_, name)| name == value) {
        return *id;
    }
    let id = values.len() as u32 + 1;
    values.push((id, value.into()));
    id
}
fn plan(input: PlanInput) -> Result<(Value, Vec<Vec<u8>>)> {
    ensure!(
        (!input.tracks.is_empty() || !input.include_all_playlist) && input.tracks.len() <= 10000,
        "Expected 1–10000 tracks"
    );
    ensure!(input.playlists.len() <= 1000, "Too many playlists");
    let mut export = Export {
        device_name: input.device_name,
        ..Export::default()
    };
    let mut planned = Vec::new();
    let mut ids = HashMap::new();
    let mut paths = std::collections::HashSet::new();
    let mut slots = anlz::hash::AnlzSlots::default();
    let mut analysis_paths = std::collections::HashSet::new();
    for track in &input.tracks {
        if let Some(reuse) = &track.reuse_device_file {
            ensure!(
                analysis_paths.insert(reuse.analysis_path.to_lowercase()),
                "Analysis path belongs to another track"
            );
        }
    }
    for (index, track) in input.tracks.iter().enumerate() {
        if track.reuse_device_file.is_some() {
            ensure!(
                track.duration.is_finite()
                    && (0.0..=65535.0).contains(&track.duration)
                    && track.bpm.is_finite()
                    && (0.0..=655.35).contains(&track.bpm),
                "Invalid reused track metadata"
            );
        } else {
            track.track()?;
        }
        let id = index as u32 + 1;
        ensure!(
            ids.insert(track.id.clone(), id).is_none(),
            "Duplicate track id"
        );
        ensure!(
            (track.usb_path.starts_with("/Contents/DECKFLOW/")
                || track.reuse_device_file.is_some())
                && !track
                    .usb_path
                    .split('/')
                    .any(|part| part == ".." || part == "."),
            "Invalid USB path"
        );
        ensure!(
            paths.insert(track.usb_path.to_lowercase()),
            "Colliding USB paths"
        );
        ensure!(
            track.size > 0
                && ((8000..=384000).contains(&track.sample_rate)
                    || (track.reuse_device_file.is_some() && track.sample_rate == 0)),
            "Audio size and sample rate required"
        );
        let extension = track
            .filename
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let file_type = match extension.as_str() {
            "mp3" => 1,
            "m4a" | "mp4" => {
                if track.codec.eq_ignore_ascii_case("alac") {
                    6
                } else {
                    4
                }
            }
            "flac" => 5,
            "wav" | "wave" => 11,
            "aif" | "aiff" => 12,
            _ => bail!("Unsupported CDJ audio format"),
        };
        let artist_id = named(&mut export.artists, &track.artist);
        let composer_id = named(&mut export.artists, &track.composer);
        let original_artist_id = named(&mut export.artists, &track.original_artist);
        let remixer_id = named(&mut export.artists, &track.remixer);
        let label_id = named(&mut export.labels, &track.label);
        let genre_id = named(&mut export.genres, &track.genre);
        let key_id = named(&mut export.keys, &track.key);
        let album_id = if track.album.is_empty() {
            0
        } else if let Some((id, _, _)) = export
            .albums
            .iter()
            .find(|(_, artist, name)| *artist == artist_id && name == &track.album)
        {
            *id
        } else {
            let id = export.albums.len() as u32 + 1;
            export.albums.push((id, artist_id, track.album.clone()));
            id
        };
        let (dir, slot, base) = if let Some(reuse) = &track.reuse_device_file {
            pdb::merge::safe_path(&reuse.usb_path)?;
            pdb::merge::safe_path(&reuse.analysis_path)?;
            ensure!(
                reuse.usb_path == track.usb_path
                    && reuse.analysis_path.to_ascii_uppercase().ends_with(".DAT"),
                "Invalid reused device paths"
            );
            let base = reuse.analysis_path[..reuse.analysis_path.len() - 4].to_string();
            let (dir, name) = base
                .rsplit_once('/')
                .context("Missing analysis directory")?;
            let slot = name
                .strip_prefix("ANLZ")
                .context("Invalid analysis filename")?
                .parse::<u16>()?;
            (dir.to_string(), slot, base)
        } else {
            let (dir, mut slot) = slots.assign(&track.usb_path);
            let base = loop {
                let base = format!("{dir}/ANLZ{slot:04}");
                if analysis_paths.insert(format!("{base}.DAT").to_lowercase()) {
                    break base;
                }
                slot = slot.checked_add(1).context("Analysis directory full")?;
            };
            (dir, slot, base)
        };
        let dat = format!("{base}.DAT");
        export.tracks.push(TrackRow {
            id,
            master_content_id: track.master_content_id.unwrap_or(id),
            sample_rate: track.sample_rate,
            file_size: track.size,
            bitrate: track.bit_rate,
            sample_depth: track.bit_depth,
            tempo: (track.bpm * 100.0).round() as u32,
            duration_seconds: track.duration.ceil() as u16,
            artist_id,
            composer_id,
            original_artist_id,
            remixer_id,
            label_id,
            album_id,
            genre_id,
            key_id,
            file_type,
            track_number: track.track_number,
            disc_number: track.disc_number,
            play_count: track.play_count,
            year: track.year,
            rating: track.rating,
            color_id: track.color_id,
            release_date: track.release_date.clone(),
            mix_name: track.mix_name.clone(),
            title: track.title.clone(),
            filename: track.usb_path.rsplit('/').next().unwrap().into(),
            file_path: track.usb_path.clone(),
            analyze_path: dat.clone(),
            comment: track.comments.clone(),
            date_added: track.added_date.clone(),
            date_created: if track.date_created.is_empty() {
                track.added_date.clone()
            } else {
                track.date_created.clone()
            },
            ..TrackRow::default()
        });
        planned.push(PlannedTrack {
            id: track.id.clone(),
            numeric_id: id,
            usb_path: track.usb_path.clone(),
            anlz_dir: dir,
            anlz_index: slot,
            anlz_paths: json!({"dat":dat,"ext":format!("{base}.EXT"),"ex2":format!("{base}.2EX")}),
        });
    }
    let mut all_name = "DECKFLOW ALL".to_string();
    while input.playlists.iter().any(|p| p.name == all_name) {
        all_name.push_str(" ·");
    }
    if input.include_all_playlist {
        export.playlists.push(ExportPlaylist {
            id: 1,
            parent: 0,
            sort_order: 0,
            is_folder: false,
            name: all_name,
            track_ids: (1..=input.tracks.len() as u32).collect(),
        });
    }
    let mut folders: HashMap<Vec<String>, u32> = HashMap::new();
    let mut playlist_app_ids = HashMap::new();
    for playlist in input.playlists {
        ensure!(
            playlist.folder_path.len() <= 32 && playlist.track_ids.len() <= 100000,
            "Playlist too large"
        );
        let mut parent = 0;
        let mut path = Vec::new();
        for name in playlist.folder_path {
            path.push(name.clone());
            parent = if let Some(id) = folders.get(&path) {
                *id
            } else {
                let id = export.playlists.len() as u32 + 1;
                let sort_order = export
                    .playlists
                    .iter()
                    .filter(|p| p.parent == parent)
                    .count() as u32;
                export.playlists.push(ExportPlaylist {
                    id,
                    parent,
                    sort_order,
                    is_folder: true,
                    name,
                    track_ids: Vec::new(),
                });
                folders.insert(path.clone(), id);
                id
            };
        }
        let track_ids = playlist
            .track_ids
            .iter()
            .map(|id| ids.get(id).copied().context("Playlist track missing"))
            .collect::<Result<_>>()?;
        let id = export.playlists.len() as u32 + 1;
        let sort_order = export
            .playlists
            .iter()
            .filter(|p| p.parent == parent)
            .count() as u32;
        playlist_app_ids.insert(id, playlist.id.clone());
        export.playlists.push(ExportPlaylist {
            id,
            parent,
            sort_order,
            is_folder: false,
            name: playlist.name,
            track_ids,
        });
    }
    let bytes = pdb::writer::write(&export)?;
    let mappings: HashMap<_, _> = planned
        .iter()
        .map(|track| (track.id.clone(), track.numeric_id))
        .collect();
    let playlist_mappings:Vec<_>=export.playlists.iter().map(|list|json!({"id":playlist_app_ids.get(&list.id),"numericId":list.id,"parentId":list.parent,"sortOrder":list.sort_order,"isFolder":list.is_folder,"name":list.name,"trackIds":list.track_ids})).collect();
    let entities = json!({"artists":export.artists.iter().map(|(id,name)|json!({"numericId":id,"name":name})).collect::<Vec<_>>(),
        "albums":export.albums.iter().map(|(id,artist,name)|json!({"numericId":id,"artistId":artist,"name":name})).collect::<Vec<_>>(),
        "genres":export.genres.iter().map(|(id,name)|json!({"numericId":id,"name":name})).collect::<Vec<_>>(),
        "labels":export.labels.iter().map(|(id,name)|json!({"numericId":id,"name":name})).collect::<Vec<_>>(),
        "keys":export.keys.iter().map(|(id,name)|json!({"numericId":id,"name":name})).collect::<Vec<_>>()});
    let mut result = (
        json!({"tracks":planned,"pdbLength":bytes.len(),"idMappings":mappings,"playlistMappings":playlist_mappings,"entityMappings":entities,
            "idFloors":{"track":export.tracks.len(),"artist":export.artists.len(),"album":export.albums.len(),"genre":export.genres.len(),"key":export.keys.len(),"label":export.labels.len(),"playlist":export.playlists.len()}}),
        vec![bytes],
    );
    if input.id_floors.values().any(|value| *value > 0)
        || input.tracks.iter().any(|track| track.numeric_id.is_some())
    {
        result = pdb::merge::remap_new(result, &input.tracks, &input.id_floors)?;
    }
    pdb::merge::append_device_playlists(result, input.device_playlists)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishInput {
    track: TrackInput,
    usb_path: String,
    #[serde(default)]
    mp3_audio_frames: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchInput {
    track: TrackInput,
    kind: String,
    hot_only: bool,
}

/// Preserve opaque per-cue fields and the device palette when a parsed USB
/// cue is edited. The reader returns player RGB, while XML uses different
/// RGB values for the same palette entries; re-quantizing changes some colors.
fn preserve_hot_metadata(old: &[u8], fresh: &[u8], cues: &[Cue]) -> Result<Vec<u8>> {
    let extended = &old[..4] == b"PCO2";
    let header = if extended { 20 } else { 24 };
    let count_at = if extended { 16 } else { 18 };
    let entries = |bytes: &[u8]| -> Result<Vec<Vec<u8>>> {
        ensure!(bytes.len() >= header, "Truncated HOT CUE container");
        let count = u16::from_be_bytes(bytes[count_at..count_at + 2].try_into().unwrap());
        let mut at = header;
        let mut result = Vec::new();
        for _ in 0..count {
            ensure!(at + 16 <= bytes.len(), "Truncated HOT CUE entry");
            let len = u32::from_be_bytes(bytes[at + 8..at + 12].try_into().unwrap()) as usize;
            ensure!(
                len >= if extended { 28 } else { 56 } && len <= bytes.len() - at,
                "Invalid HOT CUE entry length"
            );
            ensure!(
                &bytes[at..at + 4] == if extended { b"PCP2" } else { b"PCPT" },
                "Invalid HOT CUE entry tag"
            );
            result.push(bytes[at..at + len].to_vec());
            at += len;
        }
        ensure!(at == bytes.len(), "Trailing HOT CUE data");
        Ok(result)
    };
    let original = entries(old)?;
    let mut output = old[..header].to_vec();
    output[count_at..count_at + 2].copy_from_slice(&fresh[count_at..count_at + 2]);
    for next in entries(fresh)? {
        let number = u32::from_be_bytes(next[12..16].try_into().unwrap());
        let Some(previous) = original.iter().find(|row| row[12..16] == next[12..16]) else {
            output.extend(next);
            continue;
        };
        if !extended {
            if previous[28] == next[28] && previous[32..40] == next[32..40] {
                output.extend_from_slice(previous);
            } else {
                // Unknown seek fields belong to the old position. For an
                // edited position use the upstream encoder's neutral fields.
                output.extend(next);
            }
            continue;
        }
        if previous.len() < 44 {
            output.extend(next);
            continue;
        }
        let comment_len = u32::from_be_bytes(previous[40..44].try_into().unwrap()) as usize;
        ensure!(
            comment_len % 2 == 0 && comment_len <= previous.len() - 44,
            "Invalid HOT CUE comment"
        );
        let old_color = 44 + comment_len;
        if old_color + 4 > previous.len() {
            output.extend(next);
            continue;
        }
        let next_comment_len = u32::from_be_bytes(next[40..44].try_into().unwrap()) as usize;
        let next_color = 44 + next_comment_len;
        let timing_changed = previous[16] != next[16] || previous[20..28] != next[20..28];
        let mut row = if timing_changed {
            next[..44].to_vec()
        } else {
            previous[..44].to_vec()
        };
        row[16] = next[16];
        row[20..28].copy_from_slice(&next[20..28]);
        // Loop fractions are meaningful metadata; retain them unless the loop
        // itself changed, in which case the new endpoints determine them.
        if timing_changed {
            row[36..40].copy_from_slice(&next[36..40]);
        }
        row[40..44].copy_from_slice(&next[40..44]);
        row.extend_from_slice(&next[44..next_color]);
        let original_rgb = (
            previous[old_color + 1],
            previous[old_color + 2],
            previous[old_color + 3],
        );
        let unchanged_color = cues
            .iter()
            .find(|cue| cue.num >= 0 && cue.num as u32 + 1 == number)
            .is_some_and(|cue| {
                cue.rgb == Some(original_rgb) || (cue.rgb.is_none() && previous[old_color] == 0)
            });
        row.extend_from_slice(if unchanged_color {
            &previous[old_color..old_color + 4]
        } else {
            &next[next_color..next_color + 4]
        });
        row.extend_from_slice(if timing_changed {
            &next[next_color + 4..]
        } else {
            &previous[old_color + 4..]
        });
        let length = row.len() as u32;
        row[8..12].copy_from_slice(&length.to_be_bytes());
        output.extend(row);
    }
    let length = output.len() as u32;
    output[8..12].copy_from_slice(&length.to_be_bytes());
    Ok(output)
}

/// Preserve the entire original header and every unrelated section verbatim.
/// A HOT-only edit also preserves the complete memory-CUE sections, including
/// unknown player metadata, colors and active-loop flags.
fn patch(bytes: &[u8], input: PatchInput) -> Result<Vec<u8>> {
    let track = input.track.track()?;
    ensure!(
        bytes.len() >= 28 && &bytes[..4] == b"PMAI",
        "Not an ANLZ file"
    );
    let u32at = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let header = u32at(4);
    ensure!(
        header >= 28 && header <= bytes.len() && u32at(8) == bytes.len(),
        "Invalid ANLZ length"
    );
    let kind = match input.kind.as_str() {
        "DAT" => Some(anlz::cues::Kind::Dat),
        "EXT" => Some(anlz::cues::Kind::Ext),
        "2EX" => None,
        _ => bail!("Unknown ANLZ kind"),
    };
    let mut replacements: Vec<_> = kind
        .map(|kind| anlz::cues::sections(kind, &track.cues, track.grid_bpm()))
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !input.hot_only || s.bytes[12..16] == 1u32.to_be_bytes())
        .map(|s| {
            (
                s.tag,
                u32::from_be_bytes(s.bytes[12..16].try_into().unwrap()),
                Some(s.bytes),
            )
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut parts = Vec::new();
    let mut at = header;
    while at < bytes.len() {
        ensure!(bytes.len() - at >= 12, "Truncated ANLZ section");
        let tag: [u8; 4] = bytes[at..at + 4].try_into().unwrap();
        let len = u32at(at + 8);
        let section_header = u32at(at + 4);
        ensure!(
            len >= 12 && len <= bytes.len() - at && (12..=len).contains(&section_header),
            "Invalid ANLZ section length"
        );
        let list = if matches!(&tag, b"PCOB" | b"PCO2") {
            ensure!(len >= 16, "Truncated CUE section");
            let list = u32at(at + 12) as u32;
            ensure!(seen.insert((tag, list)), "Duplicate CUE section");
            Some(list)
        } else {
            None
        };
        parts.push((tag, list, bytes[at..at + len].to_vec()));
        at += len;
    }
    let rank = |tag: [u8; 4], list: Option<u32>| -> u8 {
        match (&tag, list) {
            (b"PCOB", Some(1)) => 0,
            (b"PCOB", Some(0)) => 1,
            (b"PCO2", Some(1)) => 2,
            (b"PCO2", Some(0)) => 3,
            (b"PQT2" | b"PWV5" | b"PWV4", _) => 4,
            _ => 255,
        }
    };
    // Missing containers go before the next canonical cue/grid/color section;
    // preserve the relative order and bytes of every original unrelated item.
    for (tag, list, replacement) in &mut replacements {
        let fresh = replacement.take().unwrap();
        if let Some(part) = parts
            .iter_mut()
            .find(|(t, l, _)| t == tag && *l == Some(*list))
        {
            part.2 = if *list == 1 {
                preserve_hot_metadata(&part.2, &fresh, &track.cues)?
            } else {
                fresh
            };
        } else {
            let target_rank = rank(*tag, Some(*list));
            let at = parts
                .iter()
                .position(|(t, l, _)| {
                    let r = rank(*t, *l);
                    r > target_rank && r < 255
                })
                .unwrap_or(parts.len());
            parts.insert(at, (*tag, Some(*list), fresh));
        }
    }
    let mut out = bytes[..header].to_vec();
    for (_, _, part) in parts {
        out.extend(part);
    }
    let len = out.len() as u32;
    out[8..12].copy_from_slice(&len.to_be_bytes());
    Ok(out)
}

struct ActiveMeter {
    meter: Meter,
    channels: usize,
    sample_rate: u32,
    frames: u64,
}
thread_local! {
    static OUTPUT:RefCell<Vec<u8>>=const {RefCell::new(Vec::new())};
    static METERS:RefCell<HashMap<u32,ActiveMeter>>=RefCell::new(HashMap::new());
    static NEXT_METER:RefCell<u32>=const {RefCell::new(1)};
}
fn respond(result: Result<(Value, Vec<Vec<u8>>)>) -> u32 {
    let (status, metadata, chunks) = match result {
        Ok((meta, chunks)) => (0, meta, chunks),
        Err(error) => (1, json!({"error":error.to_string()}), Vec::new()),
    };
    let json = serde_json::to_vec(&metadata).unwrap();
    let mut bytes = Vec::with_capacity(4 + json.len() + chunks.iter().map(Vec::len).sum::<usize>());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend(json);
    for chunk in chunks {
        bytes.extend(chunk);
    }
    OUTPUT.with(|out| *out.borrow_mut() = bytes);
    status
}
unsafe fn parse<T: for<'de> Deserialize<'de>>(ptr: *const u8, len: usize) -> Result<T> {
    ensure!(len <= 64 * 1024 * 1024, "Metadata too large");
    Ok(serde_json::from_slice(std::slice::from_raw_parts(
        ptr, len,
    ))?)
}
#[no_mangle]
pub extern "C" fn df_alloc(len: usize) -> *mut u8 {
    // The same ABI buffer carries f32 PCM; an explicit u64 allocation keeps
    // its alignment valid even for empty buffers and on different allocators.
    let words = vec![0u64; len.div_ceil(8)].into_boxed_slice();
    Box::into_raw(words) as *mut u8
}
#[no_mangle]
pub unsafe extern "C" fn df_free(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        ptr.cast::<u64>(),
        len.div_ceil(8),
    )));
}
#[no_mangle]
pub extern "C" fn df_result_ptr() -> *const u8 {
    OUTPUT.with(|out| out.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn df_result_len() -> usize {
    OUTPUT.with(|out| out.borrow().len())
}
#[no_mangle]
pub unsafe extern "C" fn df_plan(ptr: *const u8, len: usize) -> u32 {
    respond(parse(ptr, len).and_then(plan))
}
#[no_mangle]
pub unsafe extern "C" fn df_inspect(ptr: *const u8, len: usize) -> u32 {
    respond((|| {
        ensure!(len <= 128 * 1024 * 1024, "PDB is too large");
        pdb::merge::inspect(std::slice::from_raw_parts(ptr, len))
    })())
}
#[no_mangle]
pub unsafe extern "C" fn df_merge(
    pdb_ptr: *const u8,
    pdb_len: usize,
    ptr: *const u8,
    len: usize,
) -> u32 {
    respond((|| {
        ensure!(pdb_len <= 128 * 1024 * 1024, "PDB is too large");
        let input = parse(ptr, len)?;
        pdb::merge::merge(std::slice::from_raw_parts(pdb_ptr, pdb_len), input)
    })())
}
#[no_mangle]
pub extern "C" fn df_meter_new(rate: u32, channels: usize) -> u32 {
    respond((|| {
        ensure!(
            (8000..=384000).contains(&rate) && (1..=8).contains(&channels),
            "Invalid PCM format"
        );
        let id = NEXT_METER.with(|next| {
            let mut next = next.borrow_mut();
            let id = *next;
            *next = next.wrapping_add(1).max(1);
            id
        });
        METERS.with(|meters| {
            let mut meters = meters.borrow_mut();
            ensure!(meters.len() < 8, "Too many active analysis meters");
            meters.insert(
                id,
                ActiveMeter {
                    meter: Meter::new(rate, channels),
                    channels,
                    sample_rate: rate,
                    frames: 0,
                },
            );
            Ok(())
        })?;
        Ok((json!({"id":id}), Vec::new()))
    })())
}
#[no_mangle]
pub unsafe extern "C" fn df_meter_push(id: u32, ptr: *const f32, len: usize) -> u32 {
    respond(METERS.with(|meters| {
        let mut meters = meters.borrow_mut();
        let active = meters.get_mut(&id).context("Analysis meter closed")?;
        ensure!(
            len <= 8 * 1024 * 1024 && len % active.channels == 0,
            "PCM chunk must contain whole interleaved frames"
        );
        let pcm = std::slice::from_raw_parts(ptr, len);
        ensure!(
            pcm.iter().all(|sample| sample.is_finite()),
            "Invalid PCM samples"
        );
        ensure!(
            active.frames + ((len / active.channels) as u64)
                <= u64::from(active.sample_rate) * 65535,
            "Audio too long"
        );
        active.meter.push(pcm);
        active.frames += (len / active.channels) as u64;
        Ok((json!({}), Vec::new()))
    }))
}
#[no_mangle]
pub unsafe extern "C" fn df_meter_finish(id: u32, ptr: *const u8, len: usize) -> u32 {
    respond((|| {
        let input: FinishInput = parse(ptr, len)?;
        let track = input.track.track()?;
        ensure!(
            input.usb_path.starts_with('/'),
            "Absolute USB-relative path required"
        );
        let active = METERS
            .with(|meters| meters.borrow_mut().remove(&id))
            .context("Analysis meter closed")?;
        ensure!(active.frames > 0, "No PCM audio received");
        let audio = active.meter.finish();
        ensure!(
            (audio.duration_ms() / 1000.0 - input.track.duration).abs() <= 1.0,
            "Decoded audio duration differs from metadata"
        );
        let [dat, ext, ex2] = anlz::generate::assemble::build_files(
            &track,
            &input.usb_path,
            &audio,
            input.mp3_audio_frames,
        );
        let chunks = vec![dat.to_bytes(), ext.to_bytes(), ex2.to_bytes()];
        Ok((
            json!({"datLength":chunks[0].len(),"extLength":chunks[1].len(),"ex2Length":chunks[2].len()}),
            chunks,
        ))
    })())
}
#[no_mangle]
pub extern "C" fn df_meter_free(id: u32) {
    METERS.with(|meters| {
        meters.borrow_mut().remove(&id);
    });
}
#[no_mangle]
pub unsafe extern "C" fn df_patch(
    ptr: *const u8,
    len: usize,
    json_ptr: *const u8,
    json_len: usize,
) -> u32 {
    respond((|| {
        ensure!(len <= 128 * 1024 * 1024, "ANLZ file too large");
        let input = parse(json_ptr, json_len)?;
        let bytes = patch(std::slice::from_raw_parts(ptr, len), input)?;
        Ok((json!({"length":bytes.len()}), vec![bytes]))
    })())
}
