//! Assemble a whole `export.pdb` from the typed export model.
//!
//! Layout follows a fresh rekordbox export: page 0, then for every table its
//! index page followed by its data pages, then one zero page per table as the
//! `empty_candidate`. Sequence numbers only have to be consistent (header
//! sequence above every data page); colors and columns keep rekordbox's fixed
//! 2 and 3.

use super::fixed::Preferences;
use super::page::{header_page, index_page, DataPage, HeaderStyle, MAX_ROW, PAGE_LEN};
use super::rows::{self, MyTag, TrackRow};

pub const NUM_TABLES: u32 = 20;

/// Tables in `exportExt.pdb`: rekordbox writes nine, of which only the My Tag
/// ones (0x03, 0x04) and the row naming their database (0x07) carry rows.
pub const EXT_TABLES: u32 = 9;

/// The `myTagMasterDBID` baken writes: the tags come from a file, not from a
/// rekordbox database. rekordbox writes its own database's id there.
pub const MY_TAG_MASTER_DB_ID: u32 = 0;

#[derive(Debug, Clone)]
pub struct ExportPlaylist {
    pub id: u32,
    /// 0 for top level.
    pub parent: u32,
    pub sort_order: u32,
    pub is_folder: bool,
    pub name: String,
    pub track_ids: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct Export {
    pub tracks: Vec<TrackRow>,
    pub artists: Vec<(u32, String)>,
    /// `(id, artist_id, name)`.
    pub albums: Vec<(u32, u32, String)>,
    pub genres: Vec<(u32, String)>,
    pub labels: Vec<(u32, String)>,
    /// `(id, name)`: only the keys the tracks use, spelled as in the XML.
    pub keys: Vec<(u32, String)>,
    pub playlists: Vec<ExportPlaylist>,
    /// `(id, path of the small "a" file)`, see [`crate::artwork::path`].
    pub artworks: Vec<(u32, String)>,
    pub device_name: String,
    /// The library folder the paths in the rows point into (issue #287).
    pub root: crate::layout::Root,
    /// `YYYY-MM-DD`.
    pub export_date: String,
    /// My Tags (issue #281): every column, each followed by its tags. Empty
    /// means rekordbox's four columns without tags, see [`Export::my_tag_rows`].
    pub my_tags: Vec<MyTag>,
    /// `(track id, tag id)`, by track, then column and position, as
    /// rekordbox lists them.
    pub my_tag_tracks: Vec<(u32, u32)>,
    /// rekordbox's defaults, or the stick's own (issue #289).
    pub preferences: Preferences,
    /// Play history a player recorded on the stick, carried over (issue
    /// #286): `(id, name)` of each list.
    pub history_lists: Vec<(u32, String)>,
    /// `(track id, list id, entry index)`, every play of [`Export::history_lists`].
    pub history_entries: Vec<(u32, u32, u32)>,
}

impl Export {
    /// [`Export::my_tags`], or rekordbox's four empty columns.
    pub fn my_tag_rows(&self) -> Vec<MyTag> {
        if !self.my_tags.is_empty() {
            return self.my_tags.clone();
        }
        crate::mytags::DEFAULT_COLUMNS
            .iter()
            .zip(0..)
            .map(|(name, i)| MyTag {
                id: i + 1,
                parent: 0,
                position: i,
                name: name.to_string(),
            })
            .collect()
    }
}

/// A row that no page can hold (issue #293): a track whose text in the XML
/// (most likely its comment) comes to kilobytes. [`crate::plan`] leaves such
/// tracks out by name, so this only reaches a caller for another table.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "row {index} of table {table} takes {len} bytes, and a database page holds at most {MAX_ROW}"
)]
pub struct RowTooLarge {
    pub table: u32,
    pub index: usize,
    pub len: usize,
}

/// Encodes one row given its position in the page.
type Row<'a> = Box<dyn Fn(usize) -> Vec<u8> + 'a>;

fn row<'a>(f: impl Fn(usize) -> Vec<u8> + 'a) -> Row<'a> {
    Box::new(f)
}

struct Table<'a> {
    ty: u32,
    style: HeaderStyle,
    /// Fixed sequence for colors/columns, otherwise taken from the counter.
    seq: Option<u32>,
    rows: Vec<Row<'a>>,
}

fn empty_tables<'a>(n: u32) -> Vec<Table<'a>> {
    (0..n)
        .map(|ty| Table {
            ty,
            style: HeaderStyle::Normal,
            seq: None,
            rows: Vec::new(),
        })
        .collect()
}

fn tables(e: &Export) -> Vec<Table<'_>> {
    let mut t = empty_tables(NUM_TABLES);

    t[0].rows = e
        .tracks
        .iter()
        .map(|tr| row(move |pos| tr.encode(pos)))
        .collect();
    t[1].rows = e
        .genres
        .iter()
        .map(|(id, n)| row(move |_| rows::named(*id, n)))
        .collect();
    t[2].rows = e
        .artists
        .iter()
        .map(|(id, n)| row(move |pos| rows::artist(pos, *id, n)))
        .collect();
    t[3].rows = e
        .albums
        .iter()
        .map(|(id, artist, n)| row(move |pos| rows::album(pos, *id, *artist, n)))
        .collect();
    t[4].rows = e
        .labels
        .iter()
        .map(|(id, n)| row(move |_| rows::named(*id, n)))
        .collect();
    t[5].rows = e
        .keys
        .iter()
        .map(|(id, n)| row(move |_| rows::key(*id, n)))
        .collect();
    let prefs = &e.preferences;
    t[6].style = HeaderStyle::Fixed;
    t[6].seq = Some(2);
    t[6].rows = prefs
        .colors
        .iter()
        .map(|(id, n)| row(move |_| rows::color(*id, n)))
        .collect();
    t[7].rows = e
        .playlists
        .iter()
        .map(|p| {
            row(move |_| rows::playlist_node(p.parent, p.sort_order, p.id, p.is_folder, &p.name))
        })
        .collect();
    t[8].rows =
        e.playlists
            .iter()
            .flat_map(|p| {
                p.track_ids.iter().enumerate().map(move |(i, tid)| {
                    row(move |_| rows::playlist_entry(i as u32 + 1, *tid, p.id))
                })
            })
            .collect();
    t[11].rows = e
        .history_lists
        .iter()
        .map(|(id, n)| row(move |_| rows::named(*id, n)))
        .collect();
    t[12].rows = e
        .history_entries
        .iter()
        .map(|&(track, list, index)| row(move |_| rows::history_entry(track, list, index)))
        .collect();
    t[13].rows = e
        .artworks
        .iter()
        .map(|(id, path)| row(move |_| rows::named(*id, path)))
        .collect();
    t[16].style = HeaderStyle::Fixed;
    t[16].seq = Some(3);
    t[16].rows = prefs
        .columns
        .iter()
        .map(|(id, code, c)| row(move |_| rows::column(*id, *code, c)))
        .collect();
    t[17].rows = prefs
        .categories
        .iter()
        .map(|r| row(move |_| r.to_vec()))
        .collect();
    t[18].rows = prefs
        .sorts
        .iter()
        .map(|r| row(move |_| r.to_vec()))
        .collect();
    t[19].rows = vec![row(move |_| {
        rows::history_property(
            e.tracks.len() as u32,
            prefs.display,
            &e.export_date,
            &e.device_name,
        )
    })];
    t
}

/// `exportExt.pdb`'s tables, laid out like rekordbox's: the tag page has the
/// header of the fixed tables (row count in `unknown5`), the others the usual one.
fn ext_tables(e: &Export, master_db_id: u32) -> Vec<Table<'static>> {
    let mut t = empty_tables(EXT_TABLES);
    t[3].style = HeaderStyle::Fixed;
    t[3].rows = e
        .my_tag_rows()
        .into_iter()
        .map(|tag| row(move |pos| rows::my_tag(pos, &tag)))
        .collect();
    t[4].rows = e
        .my_tag_tracks
        .iter()
        .map(|&(track, tag)| row(move |_| rows::my_tag_track(track, tag)))
        .collect();
    t[7].rows = vec![row(move |_| rows::my_tag_master(master_db_id))];
    t
}

/// Serialise the export. The result is a whole number of 4096-byte pages.
pub fn write(e: &Export) -> Result<Vec<u8>, RowTooLarge> {
    assemble(&tables(e))
}

/// `exportExt.pdb`, the Device Library's My Tags (issue #281), in the same
/// page layout as `export.pdb`.
pub fn write_ext(e: &Export) -> Result<Vec<u8>, RowTooLarge> {
    assemble(&ext_tables(e, MY_TAG_MASTER_DB_ID))
}

fn assemble(tables: &[Table]) -> Result<Vec<u8>, RowTooLarge> {
    let num_tables = tables.len() as u32;
    let mut pages: Vec<Vec<u8>> = vec![Vec::new()]; // page 0 filled last
    let mut pointers = Vec::new();
    let mut next_seq = 10u32;
    let mut max_seq = 3u32;
    // (table index, index page position, data pages) resolved once empties are known
    let mut pending: Vec<(u32, usize, Vec<DataPage>)> = Vec::new();

    for t in tables {
        let index_pos = pages.len();
        pages.push(Vec::new());
        let mut data: Vec<DataPage> = Vec::new();
        let mut page = DataPage::new(pages.len() as u32, t.ty, 0, t.style);
        for (index, make) in t.rows.iter().enumerate() {
            let row = make(page.rows());
            if row.len() > MAX_ROW {
                return Err(RowTooLarge {
                    table: t.ty,
                    index,
                    len: row.len(),
                });
            }
            if !page.try_push(&row) {
                data.push(page);
                page = DataPage::new((pages.len() + data.len()) as u32, t.ty, 0, t.style);
                let row = make(0);
                assert!(
                    page.try_push(&row),
                    "a row of at most MAX_ROW fits an empty page"
                );
            }
        }
        if !page.is_empty() {
            data.push(page);
        }
        for p in &mut data {
            p.seq = match t.seq {
                Some(s) => s,
                None => {
                    next_seq += 1;
                    next_seq
                }
            };
            max_seq = max_seq.max(p.seq);
            pages.push(Vec::new());
        }
        pending.push((t.ty, index_pos, data));
    }

    let first_empty = pages.len() as u32;
    for (i, (ty, index_pos, mut data)) in pending.into_iter().enumerate() {
        let empty = first_empty + i as u32;
        let first_data = data.first().map(|p| p.index);
        let last = data.last().map(|p| p.index).unwrap_or(index_pos as u32);
        pointers.push((ty, empty, index_pos as u32, last));
        pages[index_pos] = index_page(
            index_pos as u32,
            ty,
            first_data.unwrap_or(empty),
            first_data,
        );
        let n = data.len();
        for (k, p) in data.iter_mut().enumerate() {
            p.next = if k + 1 < n { p.index + 1 } else { empty };
            pages[p.index as usize] = p.to_bytes();
        }
    }
    for _ in 0..num_tables {
        pages.push(vec![0u8; PAGE_LEN]);
    }
    pages[0] = header_page(num_tables, pages.len() as u32, max_seq + 1, &pointers);
    Ok(pages.concat())
}
