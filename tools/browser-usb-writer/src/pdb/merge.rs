//! Append-only DeviceSQL merger. Existing rows never move or get regenerated.
//! Unknown tables, deleted slots, page payloads and preferences remain intact.
use super::{
    page::{DataPage, HeaderStyle, MAX_ROW, PAGE_LEN},
    rows, string,
};
use crate::{PlanInput, PlaylistInput, TrackInput};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_FILE: usize = 128 * 1024 * 1024;
fn u16at(bytes: &[u8], at: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .context("Truncated PDB word")?
            .try_into()?,
    ))
}
fn u32at(bytes: &[u8], at: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .context("Truncated PDB word")?
            .try_into()?,
    ))
}
fn put32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn str_at(bytes: &[u8], at: usize) -> Result<String> {
    string::decode(bytes, at)
        .map(|(text, _)| text)
        .context("Invalid DeviceSQL string")
}
fn row_string(row: &[u8], index: usize) -> Result<String> {
    str_at(row, u16at(row, 94 + index * 2)? as usize)
}
pub(crate) fn safe_path(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/')
            && path.len() <= 4096
            && !path.contains(['\\', '\0'])
            && path
                .split('/')
                .skip(1)
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "Unsafe USB path"
    );
    Ok(())
}
fn next_id(value: &mut u32) -> Result<u32> {
    *value = value.checked_add(1).context("Device ID overflow")?;
    Ok(*value)
}

#[derive(Clone)]
struct Row {
    at: usize,
    bytes: Vec<u8>,
}
#[derive(Clone)]
struct Table {
    pointer: usize,
    first: u32,
    last: u32,
    rows: Vec<Row>,
}
struct Database {
    tables: BTreeMap<u32, Table>,
    sequence: u32,
    reserved: HashMap<u32, HashSet<u32>>,
}
impl Database {
    fn read(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.len() >= PAGE_LEN
                && bytes.len() <= MAX_FILE
                && bytes.len() % PAGE_LEN == 0
                && u32at(bytes, 4)? == PAGE_LEN as u32,
            "Invalid PDB page size"
        );
        let count = u32at(bytes, 8)? as usize;
        ensure!((1..=254).contains(&count), "Invalid PDB table count");
        let mut tables = BTreeMap::new();
        let mut occupied = HashSet::new();
        let mut sequence = u32at(bytes, 20)?;
        let mut reserved: HashMap<u32, HashSet<u32>> = HashMap::new();
        for i in 0..count {
            let pointer = 28 + i * 16;
            let ty = u32at(bytes, pointer)?;
            let first = u32at(bytes, pointer + 8)?;
            let last = u32at(bytes, pointer + 12)?;
            ensure!(!tables.contains_key(&ty), "Duplicate PDB table");
            let mut index = first;
            let mut rows = Vec::new();
            let mut visited = HashSet::new();
            loop {
                ensure!(
                    index > 0
                        && (index as usize) < bytes.len() / PAGE_LEN
                        && visited.insert(index)
                        && occupied.insert(index),
                    "PDB page chain overlaps or cycles"
                );
                let base = index as usize * PAGE_LEN;
                let page = &bytes[base..base + PAGE_LEN];
                ensure!(
                    u32at(page, 4)? == index && u32at(page, 8)? == ty,
                    "PDB page belongs to another table"
                );
                sequence = sequence.max(u32at(page, 16)?);
                if page[27] & 0x40 == 0 && matches!(ty, 0..=8 | 19) {
                    let n = (u16at(page, 24)? & 0x1fff) as usize;
                    let dir = (n / 16) * 36 + if n % 16 > 0 { (n % 16) * 2 + 4 } else { 0 };
                    let heap_end = 40 + u16at(page, 30)? as usize;
                    ensure!(
                        dir <= PAGE_LEN - 40 && heap_end >= 40 && heap_end <= PAGE_LEN - dir,
                        "Invalid PDB heap"
                    );
                    let mut offsets = Vec::new();
                    let mut live = Vec::new();
                    let mut live_offsets = HashSet::new();
                    for slot in 0..n {
                        let group = PAGE_LEN - (slot / 16) * 36;
                        let at = 40 + u16at(page, group - 6 - (slot % 16) * 2)? as usize;
                        let present = u16at(page, group - 4)? & (1 << (slot % 16)) != 0;
                        if at >= 40 && at < heap_end {
                            offsets.push(at);
                        }
                        if present {
                            ensure!(
                                at >= 40 && at < heap_end && live_offsets.insert(at),
                                "Invalid live PDB row"
                            );
                            live.push(at);
                        }
                    }
                    offsets.sort_unstable();
                    offsets.dedup();
                    // Deleted records can still be referenced by player history
                    // or opaque tables. Never recycle their numeric identities.
                    for (i, at) in offsets.iter().enumerate() {
                        let end = offsets.get(i + 1).copied().unwrap_or(heap_end);
                        let row = &page[*at..end];
                        let offset = match ty {
                            0 if u16at(row, 0).ok() == Some(0x24) => Some(72),
                            2 if matches!(u16at(row, 0).ok(), Some(0x60 | 0x64)) => Some(4),
                            3 if matches!(u16at(row, 0).ok(), Some(0x80 | 0x84)) => Some(12),
                            1 | 4 | 5 => Some(0),
                            7 => Some(12),
                            _ => None,
                        };
                        if let Some(id) = offset
                            .and_then(|at| u32at(row, at).ok())
                            .filter(|id| *id > 0)
                        {
                            reserved.entry(ty).or_default().insert(id);
                        }
                    }
                    // Cleared slots may contain stale offsets into a later
                    // live allocation. Only another live start bounds a live
                    // record; we never rewrite that record's bytes anyway.
                    let mut live_starts = live.clone();
                    live_starts.sort_unstable();
                    for at in live {
                        let end = live_starts
                            .iter()
                            .find(|&&next| next > at)
                            .copied()
                            .unwrap_or(heap_end);
                        rows.push(Row {
                            at: base + at,
                            bytes: page[at..end].to_vec(),
                        });
                    }
                }
                if index == last {
                    break;
                }
                index = u32at(page, 12)?;
            }
            tables.insert(
                ty,
                Table {
                    pointer,
                    first,
                    last,
                    rows,
                },
            );
        }
        ensure!(tables.contains_key(&0), "Not a conventional Device Library");
        Ok(Self {
            tables,
            sequence,
            reserved,
        })
    }
    fn rows(&self, ty: u32) -> &[Row] {
        self.tables
            .get(&ty)
            .map(|t| t.rows.as_slice())
            .unwrap_or(&[])
    }
}

#[derive(Clone)]
struct ExistingTrack {
    id: u32,
    path: String,
    analysis: String,
    value: Value,
}
#[derive(Clone)]
struct Node {
    id: u32,
    parent: u32,
    order: u32,
    folder: bool,
    name: String,
    tracks: Vec<(u32, u32)>,
}
struct Catalog {
    tracks: Vec<ExistingTrack>,
    nodes: Vec<Node>,
    names: HashMap<u32, Vec<(u32, String)>>,
    albums: Vec<(u32, u32, String)>,
    max: HashMap<String, u32>,
}
impl Catalog {
    fn read(db: &Database) -> Result<Self> {
        let mut names = HashMap::new();
        let mut max = HashMap::new();
        for (ty, label) in [(1, "genre"), (2, "artist"), (4, "label"), (5, "key")] {
            let mut values = Vec::new();
            let mut seen = HashSet::new();
            for row in db.rows(ty) {
                let r = &row.bytes;
                let (id, at) = if ty == 2 {
                    let subtype = u16at(r, 0)?;
                    ensure!([0x60, 0x64].contains(&subtype), "Unknown artist row layout");
                    (
                        u32at(r, 4)?,
                        if subtype & 4 != 0 {
                            u16at(r, 10)? as usize
                        } else {
                            *r.get(9).context("Invalid artist name")? as usize
                        },
                    )
                } else {
                    (u32at(r, 0)?, if ty == 5 { 8 } else { 4 })
                };
                ensure!(id > 0 && seen.insert(id), "Duplicate entity ID");
                values.push((id, str_at(r, at)?));
            }
            max.insert(
                label.into(),
                values.iter().map(|(id, _)| *id).max().unwrap_or(0),
            );
            names.insert(ty, values);
        }
        let mut albums = Vec::new();
        let mut album_ids = HashSet::new();
        for row in db.rows(3) {
            let r = &row.bytes;
            let subtype = u16at(r, 0)?;
            ensure!([0x80, 0x84].contains(&subtype), "Unknown album row layout");
            let id = u32at(r, 12)?;
            ensure!(id > 0 && album_ids.insert(id), "Duplicate album ID");
            let at = if subtype & 4 != 0 {
                u16at(r, 22)? as usize
            } else {
                *r.get(21).context("Invalid album name")? as usize
            };
            albums.push((id, u32at(r, 8)?, str_at(r, at)?));
        }
        max.insert(
            "album".into(),
            albums.iter().map(|(id, _, _)| *id).max().unwrap_or(0),
        );
        for (ty, label) in [
            (0, "track"),
            (1, "genre"),
            (2, "artist"),
            (3, "album"),
            (4, "label"),
            (5, "key"),
            (7, "playlist"),
        ] {
            let reserved = db
                .reserved
                .get(&ty)
                .into_iter()
                .flatten()
                .copied()
                .max()
                .unwrap_or(0);
            max.entry(label.into())
                .and_modify(|value| *value = (*value).max(reserved))
                .or_insert(reserved);
        }
        let name_index: HashMap<_, _> = names
            .iter()
            .flat_map(|(ty, items)| {
                items
                    .iter()
                    .map(move |(id, name)| ((*ty, *id), name.as_str()))
            })
            .collect();
        let album_index: HashMap<_, _> = albums
            .iter()
            .map(|(id, _, name)| (*id, name.as_str()))
            .collect();
        let name = |ty, id| name_index.get(&(ty, id)).copied().unwrap_or("");
        let mut tracks = Vec::new();
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        for row in db.rows(0) {
            let r = &row.bytes;
            ensure!(
                r.len() >= 136 && u16at(r, 0)? == 0x24,
                "Unknown track row layout"
            );
            let id = u32at(r, 72)?;
            let path = row_string(r, 20)?;
            let analysis = row_string(r, 14)?;
            safe_path(&path)?;
            if !analysis.is_empty() {
                safe_path(&analysis)?;
            }
            ensure!(
                id > 0 && ids.insert(id) && paths.insert(path.to_lowercase()),
                "Duplicate track ID or audio path"
            );
            let size = u32at(r, 16)?;
            let album_id = u32at(r, 64)?;
            let file_type = u16at(r, 90)?;
            let value = json!({"numericId":id,"id":id.to_string(),"usbPath":path,"analysisPath":analysis,"size":size,
                "title":row_string(r,17)?,"filename":row_string(r,19)?,"artist":name(2,u32at(r,68)?),
                "composer":name(2,u32at(r,12)?),"remixer":name(2,u32at(r,44)?),"originalArtist":name(2,u32at(r,36)?),
                "album":album_index.get(&album_id).copied().unwrap_or(""),
                "genre":name(1,u32at(r,60)?),"key":name(5,u32at(r,32)?),"label":name(4,u32at(r,40)?),
                "bpm":u32at(r,56)? as f64/100.0,"duration":u16at(r,84)?,"sampleRate":u32at(r,8)?,"bitRate":u32at(r,48)?,"bitDepth":u16at(r,82)?,
                "trackNumber":u32at(r,52)?,"discNumber":u16at(r,76)?,"playCount":u16at(r,78)?,"year":u16at(r,80)?,"rating":r[89],"colorId":r[88],"fileType":file_type,
                "codec":if file_type==6{"alac"}else{""},"comments":row_string(r,16)?,"addedDate":row_string(r,15)?,"dateCreated":row_string(r,10)?,"releaseDate":row_string(r,11)?,"mixName":row_string(r,12)?,"masterContentId":u32at(r,20)?});
            tracks.push(ExistingTrack {
                id,
                path,
                analysis,
                value,
            });
        }
        max.insert(
            "track".into(),
            ids.iter()
                .copied()
                .max()
                .unwrap_or(0)
                .max(*max.get("track").unwrap_or(&0)),
        );
        let mut nodes = Vec::new();
        let mut node_ids = HashSet::new();
        for row in db.rows(7) {
            let r = &row.bytes;
            let id = u32at(r, 12)?;
            let folder = u32at(r, 16)?;
            ensure!(
                id > 0 && node_ids.insert(id) && folder <= 1,
                "Invalid playlist node"
            );
            nodes.push(Node {
                id,
                parent: u32at(r, 0)?,
                order: u32at(r, 8)?,
                folder: folder == 1,
                name: str_at(r, 20)?,
                tracks: Vec::new(),
            });
        }
        for row in db.rows(8) {
            let r = &row.bytes;
            let list = u32at(r, 8)?;
            let track = u32at(r, 4)?;
            let node = nodes
                .iter_mut()
                .find(|n| n.id == list)
                .context("Playlist entry has no node")?;
            ensure!(
                !node.folder && ids.contains(&track),
                "Invalid playlist track reference"
            );
            node.tracks.push((u32at(r, 0)?, track));
        }
        for node in &nodes {
            let mut parent = node.parent;
            let mut ancestors = HashSet::from([node.id]);
            while parent != 0 {
                ensure!(ancestors.insert(parent), "Playlist folder cycle");
                let folder = nodes
                    .iter()
                    .find(|n| n.id == parent && n.folder)
                    .context("Missing parent folder")?;
                parent = folder.parent;
            }
        }
        for node in &mut nodes {
            node.tracks.sort_by_key(|(order, _)| *order);
        }
        max.insert(
            "playlist".into(),
            node_ids
                .iter()
                .copied()
                .max()
                .unwrap_or(0)
                .max(*max.get("playlist").unwrap_or(&0)),
        );
        Ok(Self {
            tracks,
            nodes,
            names,
            albums,
            max,
        })
    }
    fn metadata(&self) -> Value {
        let named = |ty| {
            self.names
                .get(&ty)
                .into_iter()
                .flatten()
                .map(|(id, name)| json!({"numericId":id,"name":name}))
                .collect::<Vec<_>>()
        };
        json!({"existingTracks":self.tracks.iter().map(|t|t.value.clone()).collect::<Vec<_>>(),"idFloors":self.max,
            "playlistMappings":self.nodes.iter().map(|n|json!({"id":null,"numericId":n.id,"parentId":n.parent,"sortOrder":n.order,"isFolder":n.folder,"name":n.name,"trackIds":n.tracks.iter().map(|(_,id)|id).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "entityMappings":{"artists":named(2),"genres":named(1),"keys":named(5),"labels":named(4),"albums":self.albums.iter().map(|(id,artist,name)|json!({"numericId":id,"artistId":artist,"name":name})).collect::<Vec<_>>()}})
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendPlaylist {
    playlist_id: u32,
    track_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevicePlaylist {
    numeric_id: u32,
    parent_id: u32,
    sort_order: u32,
    is_folder: bool,
    name: String,
    track_ids: Vec<u32>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeInput {
    #[serde(default)]
    tracks: Vec<TrackInput>,
    #[serde(default)]
    playlists: Vec<PlaylistInput>,
    #[serde(default)]
    append_playlists: Vec<AppendPlaylist>,
    #[serde(default)]
    existing_track_ids: HashMap<String, u32>,
    #[serde(default)]
    id_floors: HashMap<String, u32>,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    device_playlists: Vec<DevicePlaylist>,
}

pub(crate) fn inspect(bytes: &[u8]) -> Result<(Value, Vec<Vec<u8>>)> {
    Ok((
        Catalog::read(&Database::read(bytes)?)?.metadata(),
        Vec::new(),
    ))
}

pub(crate) fn append_device_playlists(
    mut result: (Value, Vec<Vec<u8>>),
    lists: Vec<DevicePlaylist>,
) -> Result<(Value, Vec<Vec<u8>>)> {
    if lists.is_empty() {
        return Ok(result);
    }
    let (meta, bytes) = merge(
        &result.1[0],
        MergeInput {
            device_playlists: lists,
            ..MergeInput::default()
        },
    )?;
    result.0["playlistMappings"]
        .as_array_mut()
        .unwrap()
        .extend(meta["playlistMappings"].as_array().unwrap().iter().cloned());
    result.0["idFloors"] = meta["idFloors"].clone();
    result.0["pdbLength"] = meta["pdbLength"].clone();
    result.1 = bytes;
    Ok(result)
}

fn rewrite_track_string(row: &mut Vec<u8>, index: usize, value: &str) -> Result<()> {
    let mut values = (0..21)
        .map(|i| row_string(row, i))
        .collect::<Result<Vec<_>>>()?;
    values[index] = value.into();
    let mut out = row[..94].to_vec();
    out.resize(136, 0);
    for (i, value) in values.iter().enumerate() {
        let encoded = string::encode(value);
        if encoded[0] == 0x90 {
            out.resize(out.len().next_multiple_of(4), 0);
        }
        ensure!(out.len() <= u16::MAX as usize, "Track row too long");
        let at = out.len() as u16;
        out[94 + i * 2..96 + i * 2].copy_from_slice(&at.to_le_bytes());
        out.extend(encoded);
    }
    out.resize(out.len().next_multiple_of(4), 0);
    *row = out;
    Ok(())
}
fn append_rows(
    bytes: &mut Vec<u8>,
    db: &Database,
    ty: u32,
    rows: &[Vec<u8>],
    sequence: &mut u32,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let table = db
        .tables
        .get(&ty)
        .context("Required PDB table is missing")?;
    let start = (bytes.len() / PAGE_LEN) as u32;
    let mut pages = Vec::new();
    let mut page = DataPage::new(start, ty, next_id(sequence)?, HeaderStyle::Normal);
    for raw in rows {
        ensure!(raw.len() <= MAX_ROW, "New PDB row is too large");
        let mut row = raw.clone();
        if matches!(ty, 0 | 2 | 3) {
            row[2..4].copy_from_slice(&((page.rows() as u16) * 0x20).to_le_bytes());
        }
        if !page.try_push(&row) {
            pages.push(page);
            page = DataPage::new(
                start + pages.len() as u32,
                ty,
                next_id(sequence)?,
                HeaderStyle::Normal,
            );
            if matches!(ty, 0 | 2 | 3) {
                row[2..4].fill(0);
            }
            ensure!(page.try_push(&row), "PDB row cannot fit");
        }
    }
    if !page.is_empty() {
        pages.push(page);
    }
    let old_next = u32at(bytes, table.last as usize * PAGE_LEN + 12)?;
    for i in 0..pages.len() {
        pages[i].next = if i + 1 < pages.len() {
            pages[i + 1].index
        } else {
            old_next
        };
    }
    put32(bytes, table.last as usize * PAGE_LEN + 12, start);
    put32(
        bytes,
        table.last as usize * PAGE_LEN + 16,
        next_id(sequence)?,
    );
    if table.first == table.last && bytes[table.first as usize * PAGE_LEN + 27] & 0x40 != 0 {
        put32(bytes, table.first as usize * PAGE_LEN + 44, start);
    }
    put32(bytes, table.pointer + 12, pages.last().unwrap().index);
    ensure!(
        bytes.len() + pages.len() * PAGE_LEN <= MAX_FILE,
        "Merged PDB exceeds 128 MiB"
    );
    for page in pages {
        bytes.extend(page.to_bytes());
    }
    Ok(())
}

pub(crate) fn merge(original: &[u8], mut input: MergeInput) -> Result<(Value, Vec<Vec<u8>>)> {
    ensure!(
        input.tracks.len() <= 10000
            && input.playlists.len() <= 1000
            && input.append_playlists.len() <= 1000
            && input.device_playlists.len() <= 1000,
        "Too many merge items"
    );
    let db = Database::read(original)?;
    let mut catalog = Catalog::read(&db)?;
    let before = catalog.metadata();
    let old_track_count = catalog.tracks.len();
    ensure!(
        old_track_count + input.tracks.len() <= 10000,
        "Merged library exceeds 10000 tracks"
    );
    let mut counters = catalog.max.clone();
    for (key, value) in &input.id_floors {
        counters
            .entry(key.clone())
            .and_modify(|old| *old = (*old).max(*value))
            .or_insert(*value);
    }
    let mut ids = input.existing_track_ids.clone();
    let known_ids: HashSet<_> = catalog.tracks.iter().map(|t| t.id).collect();
    ensure!(
        ids.values().all(|id| known_ids.contains(id)),
        "Unknown existing track ID alias"
    );
    let mut additions: BTreeMap<u32, Vec<Vec<u8>>> = BTreeMap::new();
    let mut planned = Vec::new();
    let mut mappings = HashMap::new();
    let mut reused_paths: HashSet<_> = catalog
        .tracks
        .iter()
        .map(|t| t.path.to_lowercase())
        .collect();
    let mut occupied_analysis: HashSet<_> = catalog
        .tracks
        .iter()
        .filter(|t| !t.analysis.is_empty())
        .map(|t| t.analysis.to_lowercase())
        .collect();
    let mut node_mappings = Vec::new();
    let mut appended = Vec::new();
    if !input.tracks.is_empty() {
        let tracks = std::mem::take(&mut input.tracks);
        let requested_ids: HashMap<_, _> = tracks
            .iter()
            .map(|t| (t.id.clone(), t.numeric_id))
            .collect();
        let master_ids: HashMap<_, _> = tracks
            .iter()
            .filter_map(|t| t.master_content_id.map(|id| (t.id.clone(), id)))
            .collect();
        let reused: HashSet<_> = tracks
            .iter()
            .filter(|t| t.reuse_device_file.is_some())
            .map(|t| t.id.clone())
            .collect();
        let (mut fresh_meta, chunks) = crate::plan(PlanInput {
            tracks,
            playlists: Vec::new(),
            device_name: input.device_name.clone(),
            id_floors: HashMap::new(),
            device_playlists: Vec::new(),
            include_all_playlist: false,
        })?;
        let fresh_db = Database::read(&chunks[0])?;
        let fresh_catalog = Catalog::read(&fresh_db)?;
        let mut remaps: HashMap<u32, HashMap<u32, u32>> = HashMap::new();
        for (ty, label) in [(1, "genre"), (2, "artist"), (4, "label"), (5, "key")] {
            let existing = catalog.names.entry(ty).or_default();
            let mut map = HashMap::new();
            map.insert(0, 0);
            for (old, name) in fresh_catalog.names.get(&ty).into_iter().flatten() {
                let id = if let Some((id, _)) = existing.iter().find(|(_, n)| n == name) {
                    *id
                } else {
                    let id = next_id(counters.entry(label.into()).or_default())?;
                    existing.push((id, name.clone()));
                    let row = if ty == 2 {
                        rows::artist(0, id, name)
                    } else if ty == 5 {
                        rows::key(id, name)
                    } else {
                        rows::named(id, name)
                    };
                    additions.entry(ty).or_default().push(row);
                    id
                };
                map.insert(*old, id);
            }
            remaps.insert(ty, map);
        }
        let mut album_map = HashMap::from([(0, 0)]);
        for (old, artist, name) in &fresh_catalog.albums {
            let artist = remaps[&2][artist];
            let id = if let Some((id, _, _)) = catalog
                .albums
                .iter()
                .find(|(_, a, n)| *a == artist && n == name)
            {
                *id
            } else {
                let id = next_id(counters.entry("album".into()).or_default())?;
                catalog.albums.push((id, artist, name.clone()));
                additions
                    .entry(3)
                    .or_default()
                    .push(rows::album(0, id, artist, name));
                id
            };
            album_map.insert(*old, id);
        }
        let mut used_ids = db
            .reserved
            .get(&0)
            .cloned()
            .unwrap_or_else(|| known_ids.clone());
        for (index, row) in fresh_db.rows(0).iter().enumerate() {
            let item = &mut fresh_meta["tracks"][index];
            let app_id = item["id"]
                .as_str()
                .context("Missing planned ID")?
                .to_string();
            let path = item["usbPath"].as_str().unwrap().to_string();
            ensure!(
                reused_paths.insert(path.to_lowercase()),
                "Audio path already exists on USB; use its existing track instead"
            );
            ensure!(
                !ids.contains_key(&app_id),
                "New track ID conflicts with an existing alias"
            );
            let requested = requested_ids.get(&app_id).copied().flatten();
            let id = if let Some(id) = requested {
                ensure!(
                    id > 0 && !used_ids.contains(&id),
                    "Requested track ID already exists"
                );
                counters
                    .entry("track".into())
                    .and_modify(|value| *value = (*value).max(id));
                id
            } else {
                next_id(counters.entry("track".into()).or_default())?
            };
            ensure!(used_ids.insert(id), "Duplicate new track ID");
            ids.insert(app_id.clone(), id);
            mappings.insert(app_id.clone(), id);
            item["numericId"] = json!(id);
            let mut bytes = row.bytes.clone();
            put32(&mut bytes, 72, id);
            put32(
                &mut bytes,
                20,
                master_ids.get(&app_id).copied().unwrap_or(id),
            );
            for (offset, ty) in [
                (12, 2),
                (36, 2),
                (44, 2),
                (68, 2),
                (60, 1),
                (32, 5),
                (40, 4),
            ] {
                let old = u32at(&bytes, offset)?;
                put32(
                    &mut bytes,
                    offset,
                    *remaps[&ty].get(&old).context("Unmapped entity")?,
                );
            }
            let old = u32at(&bytes, 64)?;
            put32(&mut bytes, 64, album_map[&old]);
            let mut analysis = item["anlzPaths"]["dat"].as_str().unwrap().to_string();
            if reused.contains(&app_id) {
                ensure!(
                    occupied_analysis.insert(analysis.to_lowercase()),
                    "Analysis path belongs to another track"
                );
            } else {
                let dir = item["anlzDir"].as_str().unwrap().to_string();
                let mut slot = 0u16;
                loop {
                    analysis = format!("{dir}/ANLZ{slot:04}.DAT");
                    if occupied_analysis.insert(analysis.to_lowercase()) {
                        break;
                    }
                    slot = slot.checked_add(1).context("Analysis directory full")?;
                }
                let base = analysis[..analysis.len() - 4].to_string();
                item["anlzIndex"] = json!(slot);
                item["anlzPaths"] =
                    json!({"dat":analysis,"ext":format!("{base}.EXT"),"ex2":format!("{base}.2EX")});
                rewrite_track_string(&mut bytes, 14, &analysis)?;
            }
            additions.entry(0).or_default().push(bytes);
            planned.push(item.clone());
        }
    }
    let valid_ids: HashSet<_> = known_ids
        .iter()
        .copied()
        .chain(mappings.values().copied())
        .collect();
    let resolve = |values: &[String]| -> Result<Vec<u32>> {
        values
            .iter()
            .map(|value| {
                ids.get(value)
                    .copied()
                    .context("Playlist references an unknown app track ID")
            })
            .collect()
    };
    for list in input.playlists {
        ensure!(
            !list.name.trim().is_empty()
                && list.name.len() <= 1024
                && list.folder_path.len() <= 32
                && list.track_ids.len() <= 100000,
            "Invalid new playlist"
        );
        let mut parent = 0;
        for name in list.folder_path {
            let matches: Vec<_> = catalog
                .nodes
                .iter()
                .filter(|n| n.folder && n.parent == parent && n.name == name)
                .collect();
            ensure!(matches.len() <= 1, "Ambiguous existing playlist folder");
            parent = if let Some(node) = matches.first() {
                node.id
            } else {
                let id = next_id(counters.entry("playlist".into()).or_default())?;
                let order = catalog
                    .nodes
                    .iter()
                    .filter(|n| n.parent == parent)
                    .map(|n| n.order)
                    .max()
                    .map(|n| n.checked_add(1).context("Playlist order overflow"))
                    .transpose()?
                    .unwrap_or(0);
                additions
                    .entry(7)
                    .or_default()
                    .push(rows::playlist_node(parent, order, id, true, &name));
                node_mappings.push(json!({"id":null,"numericId":id,"parentId":parent,"sortOrder":order,"isFolder":true,"name":name,"trackIds":[]}));
                catalog.nodes.push(Node {
                    id,
                    parent,
                    order,
                    folder: true,
                    name,
                    tracks: Vec::new(),
                });
                id
            };
        }
        let track_ids = resolve(&list.track_ids)?;
        let id = next_id(counters.entry("playlist".into()).or_default())?;
        let order = catalog
            .nodes
            .iter()
            .filter(|n| n.parent == parent)
            .map(|n| n.order)
            .max()
            .map(|n| n.checked_add(1).context("Playlist order overflow"))
            .transpose()?
            .unwrap_or(0);
        additions
            .entry(7)
            .or_default()
            .push(rows::playlist_node(parent, order, id, false, &list.name));
        for (i, track) in track_ids.iter().enumerate() {
            additions
                .entry(8)
                .or_default()
                .push(rows::playlist_entry(i as u32 + 1, *track, id));
        }
        node_mappings.push(json!({"id":list.id,"numericId":id,"parentId":parent,"sortOrder":order,"isFolder":false,"name":list.name,"trackIds":track_ids}));
        catalog.nodes.push(Node {
            id,
            parent,
            order,
            folder: false,
            name: list.name,
            tracks: track_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (i as u32 + 1, *id))
                .collect(),
        });
    }
    for append in input.append_playlists {
        ensure!(
            append.track_ids.len() <= 100000,
            "Playlist append too large"
        );
        let wanted = resolve(&append.track_ids)?;
        let node = catalog
            .nodes
            .iter_mut()
            .find(|n| n.id == append.playlist_id && !n.folder)
            .context("Append target playlist does not exist")?;
        let mut present: HashSet<_> = node.tracks.iter().map(|(_, id)| *id).collect();
        let mut position = node
            .tracks
            .iter()
            .map(|(order, _)| *order)
            .max()
            .unwrap_or(0);
        let mut added = Vec::new();
        for track in wanted {
            ensure!(valid_ids.contains(&track), "Unknown track ID");
            if present.insert(track) {
                let order = next_id(&mut position)?;
                additions
                    .entry(8)
                    .or_default()
                    .push(rows::playlist_entry(order, track, node.id));
                node.tracks.push((order, track));
                added.push(track);
            }
        }
        if !added.is_empty() {
            appended.push(json!({"playlistId":node.id,"trackIds":added}));
        }
    }
    for list in input.device_playlists {
        ensure!(
            list.numeric_id > 0
                && !catalog.nodes.iter().any(|n| n.id == list.numeric_id)
                && !db
                    .reserved
                    .get(&7)
                    .is_some_and(|ids| ids.contains(&list.numeric_id)),
            "Device playlist ID already exists"
        );
        ensure!(
            !list.name.trim().is_empty()
                && list.name.len() <= 1024
                && list.track_ids.len() <= 100000
                && (!list.is_folder || list.track_ids.is_empty()),
            "Invalid device playlist"
        );
        ensure!(
            list.track_ids.iter().all(|id| valid_ids.contains(id)),
            "Device playlist references an unknown track"
        );
        counters
            .entry("playlist".into())
            .and_modify(|n| *n = (*n).max(list.numeric_id))
            .or_insert(list.numeric_id);
        additions.entry(7).or_default().push(rows::playlist_node(
            list.parent_id,
            list.sort_order,
            list.numeric_id,
            list.is_folder,
            &list.name,
        ));
        for (i, id) in list.track_ids.iter().enumerate() {
            additions.entry(8).or_default().push(rows::playlist_entry(
                i as u32 + 1,
                *id,
                list.numeric_id,
            ));
        }
        node_mappings.push(json!({"id":null,"numericId":list.numeric_id,"parentId":list.parent_id,"sortOrder":list.sort_order,"isFolder":list.is_folder,"name":list.name,"trackIds":list.track_ids}));
        catalog.nodes.push(Node {
            id: list.numeric_id,
            parent: list.parent_id,
            order: list.sort_order,
            folder: list.is_folder,
            name: list.name,
            tracks: list
                .track_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (i as u32 + 1, *id))
                .collect(),
        });
    }
    let mut output = original.to_vec();
    let mut sequence = db.sequence;
    let changed = additions.values().any(|rows| !rows.is_empty());
    for (ty, rows) in &additions {
        append_rows(&mut output, &db, *ty, rows, &mut sequence)?;
    }
    if !planned.is_empty() {
        for property in db.rows(19) {
            if u16at(&property.bytes, 0)? == 0x280 {
                put32(
                    &mut output,
                    property.at + 4,
                    (old_track_count + planned.len()) as u32,
                );
            }
        }
    }
    if changed {
        let pages = (output.len() / PAGE_LEN) as u32;
        put32(&mut output, 12, pages);
        put32(&mut output, 20, next_id(&mut sequence)?);
    }
    let after = Catalog::read(&Database::read(&output)?)?;
    let metadata = json!({"pdbLength":output.len(),"tracks":planned,"idMappings":mappings,"playlistMappings":node_mappings,
        "appendPlaylistTracks":appended,"entityMappings":after.metadata()["entityMappings"],"existingTracks":before["existingTracks"],"existingPlaylists":before["playlistMappings"],"idFloors":after.max});
    Ok((metadata, vec![output]))
}

/// A fresh database can be remapped in place: all row sizes remain identical.
pub(crate) fn remap_new(
    mut result: (Value, Vec<Vec<u8>>),
    tracks: &[TrackInput],
    floors: &HashMap<String, u32>,
) -> Result<(Value, Vec<Vec<u8>>)> {
    let bytes = &mut result.1[0];
    let db = Database::read(bytes)?;
    let mut maps: HashMap<&str, HashMap<u32, u32>> = HashMap::new();
    for (label, ty, offset) in [
        ("track", 0, 72),
        ("artist", 2, 4),
        ("album", 3, 12),
        ("genre", 1, 0),
        ("label", 4, 0),
        ("key", 5, 0),
        ("playlist", 7, 12),
    ] {
        let mut count = *floors.get(label).unwrap_or(&0);
        let mut map = HashMap::from([(0, 0)]);
        let mut used = HashSet::new();
        for (i, row) in db.rows(ty).iter().enumerate() {
            let old = u32at(&row.bytes, offset)?;
            let requested = if label == "track" {
                tracks[i].numeric_id
            } else {
                None
            };
            let id = if let Some(id) = requested {
                ensure!(id > 0, "Zero track ID");
                count = count.max(id);
                id
            } else {
                next_id(&mut count)?
            };
            ensure!(used.insert(id), "Duplicate explicit numeric ID");
            map.insert(old, id);
        }
        maps.insert(label, map);
    }
    let change = |bytes: &mut [u8], at: usize, label: &str| -> Result<()> {
        let old = u32at(bytes, at)?;
        put32(
            bytes,
            at,
            *maps[label].get(&old).context("Unmapped fresh PDB ID")?,
        );
        Ok(())
    };
    for (index, row) in db.rows(0).iter().enumerate() {
        for (offset, label) in [
            (72, "track"),
            (12, "artist"),
            (36, "artist"),
            (44, "artist"),
            (68, "artist"),
            (64, "album"),
            (60, "genre"),
            (32, "key"),
            (40, "label"),
        ] {
            change(bytes, row.at + offset, label)?;
        }
        if tracks[index].master_content_id.is_none() {
            change(bytes, row.at + 20, "track")?;
        }
    }
    for row in db.rows(1) {
        change(bytes, row.at, "genre")?;
    }
    for row in db.rows(2) {
        change(bytes, row.at + 4, "artist")?;
    }
    for row in db.rows(3) {
        change(bytes, row.at + 8, "artist")?;
        change(bytes, row.at + 12, "album")?;
    }
    for row in db.rows(4) {
        change(bytes, row.at, "label")?;
    }
    for row in db.rows(5) {
        change(bytes, row.at, "key")?;
        change(bytes, row.at + 4, "key")?;
    }
    for row in db.rows(7) {
        change(bytes, row.at, "playlist")?;
        change(bytes, row.at + 12, "playlist")?;
    }
    for row in db.rows(8) {
        change(bytes, row.at + 4, "track")?;
        change(bytes, row.at + 8, "playlist")?;
    }
    for item in result.0["tracks"].as_array_mut().unwrap() {
        let old = item["numericId"].as_u64().unwrap() as u32;
        item["numericId"] = json!(maps["track"][&old]);
    }
    for (_, id) in result.0["idMappings"].as_object_mut().unwrap() {
        *id = json!(maps["track"][&(id.as_u64().unwrap() as u32)]);
    }
    let snapshot = Catalog::read(&Database::read(bytes)?)?.metadata();
    let original_lists = result.0["playlistMappings"].clone();
    result.0["playlistMappings"] = snapshot["playlistMappings"].clone();
    for (new, old) in result.0["playlistMappings"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(original_lists.as_array().unwrap())
    {
        new["id"] = old["id"].clone();
    }
    result.0["entityMappings"] = snapshot["entityMappings"].clone();
    result.0["idFloors"] = snapshot["idFloors"].clone();
    Ok(result)
}
