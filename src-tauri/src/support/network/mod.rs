pub mod identify;
pub mod info;
mod observations;
pub mod scan;
use std::{collections::BTreeSet, time::Instant};
#[derive(Default)]
pub struct DiscoveryState {
    pub session: String,
    pub scanned: BTreeSet<(String, u16)>,
    pub last_scan: Option<Instant>,
    pub scans: u8,
    pub probes: Vec<Instant>,
}
impl DiscoveryState {
    pub fn session(&mut self, id: &str) {
        if self.session != id {
            *self = Self::default();
            self.session = id.into();
        }
    }
}
