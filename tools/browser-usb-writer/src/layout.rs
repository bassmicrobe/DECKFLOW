/// The folder at the stick's root that holds the library: `rekordbox/`,
/// `USBANLZ/`, `Artwork/` and the settings files. The audio stays in
/// `/Contents` either way. rekordbox 7 reads a library from either and writes
/// the hidden `.PIONEER` on an HFS+ stick (measured with 7.2.18 on a
/// journaled HFS+ stick with an MBR, issue #287), `PIONEER` elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Root {
    #[default]
    Pioneer,
    Hidden,
}

impl Root {
    pub const ALL: [Root; 2] = [Root::Pioneer, Root::Hidden];

    /// The folder's name, `PIONEER` or `.PIONEER`.
    pub fn name(self) -> &'static str {
        match self {
            Root::Pioneer => "PIONEER",
            Root::Hidden => ".PIONEER",
        }
    }
}
