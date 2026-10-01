//! Physical screen ownership for the local external display windows.
//!
//! The kitchen display and the customer display each project into one fixed
//! window label on at most one physical monitor. A monitor is identified by a
//! fingerprint of its name, position, size and scale factor. Enumeration indexes
//! are never identity, so a changed monitor list cannot move a reservation onto
//! another screen. The monitor showing the cashier window is never an external
//! target, and while that monitor is unknown no monitor is. The OS primary flag
//! is informational only: an external TV that Windows made primary is offered
//! like any other screen.
//!
//! A lease is Opening while its window is built and placed, Active once shown
//! and Closing until that window's Destroyed event; its monitor stays occupied in
//! every phase, also when the cashier window moves onto it. Only the callbacks
//! and failure paths of the window `instance` holding a lease can release it.
//! Every successful open returns a fresh presentation token, and an open of a
//! content that already has a lease is a compare-and-set on that token: only a
//! request naming the current token reopens the running presentation, and a
//! request naming none only starts a content without a lease. So a delayed open,
//! close or callback of an older session never reuses, rotates, closes or
//! releases a newer one.
//!
//! Pure std, testable without the Tauri graph:
//! `rustc --edition 2021 --test src/commands/system_ui/display_lease.rs`.

/// One connected monitor as seen by the lease table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonitorSlot {
    /// Opaque physical identity from [`monitor_fingerprint`].
    pub id: String,
    /// The OS primary monitor. Informational only: it may be an external TV.
    pub is_primary: bool,
    /// The monitor showing the cashier POS window; every monitor while that is unknown.
    pub hosts_pos: bool,
}

impl MonitorSlot {
    /// Not the cashier's monitor: a valid external screen, the OS primary included.
    pub fn is_external(&self) -> bool {
        !self.hosts_pos
    }
}

/// Classifies the connected monitors, given as `(fingerprint, is OS primary)`,
/// against the monitor showing the cashier window. An unknown cashier monitor,
/// unread or missing from this list, marks every monitor as the cashier's, so no
/// monitor is external instead of all of them.
pub fn monitor_slots(monitors: Vec<(String, bool)>, pos_id: Option<&str>) -> Vec<MonitorSlot> {
    let pos_id = pos_id.filter(|pos| monitors.iter().any(|(id, _)| id == pos));
    monitors
        .into_iter()
        .map(|(id, is_primary)| MonitorSlot {
            hosts_pos: pos_id.map_or(true, |pos| pos == id),
            is_primary,
            id,
        })
        .collect()
}

/// Physical identity of a monitor. A disconnect, resolution, scale or
/// arrangement change yields a different identity, never another monitor's.
pub fn monitor_fingerprint(
    name: &str,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> String {
    let scale = if scale_factor.is_finite() {
        (scale_factor * 1000.0).round() as i64
    } else {
        0
    };
    format!("{name}|{x},{y}|{width}x{height}|{scale}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeasePhase {
    Opening,
    Active,
    Closing,
}

impl LeasePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            LeasePhase::Opening => "opening",
            LeasePhase::Active => "active",
            LeasePhase::Closing => "closing",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub content: String,
    pub display_id: String,
    /// Presentation token of the latest successful open; every reopen rotates it.
    pub token: String,
    /// The window build this lease belongs to.
    pub instance: u64,
    pub phase: LeasePhase,
    /// The window exists and its Destroyed callback is registered.
    pub built: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisplayRequest {
    /// The first free external monitor.
    Auto,
    /// An opaque id from the capability list.
    Id(String),
    /// Legacy explicit enumeration index, validated against the current list.
    Index(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseError {
    /// The requested monitor is not connected (or changed) now.
    DisplayNotFound,
    /// The requested monitor shows the cashier POS, or the cashier's monitor is unknown.
    ReservedForPos,
    /// Another content holds the requested monitor.
    Occupied(String),
    /// This content is still opening or closing.
    ContentBusy,
    /// This content already shows on another monitor.
    ContentActiveElsewhere(String),
    /// No external monitor is free.
    NoFreeExternal,
    /// The request named no presentation, or not the current one, of a content
    /// that has a lease, or named one that no longer exists (or a malformed one).
    PresentationChanged,
}

impl LeaseError {
    pub fn code(&self) -> &'static str {
        match self {
            LeaseError::DisplayNotFound => "display_not_found",
            LeaseError::ReservedForPos => "display_reserved_for_pos",
            LeaseError::Occupied(_) => "display_occupied",
            LeaseError::ContentBusy => "display_busy",
            LeaseError::ContentActiveElsewhere(_) => "display_content_active",
            LeaseError::NoFreeExternal => "no_external_display",
            LeaseError::PresentationChanged => "display_presentation_changed",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            LeaseError::DisplayNotFound => {
                "The selected screen is not connected. Refresh and choose a connected screen."
            }
            LeaseError::ReservedForPos => {
                "This screen shows the cashier POS. Choose an external monitor or TV."
            }
            LeaseError::Occupied(_) => {
                "This screen is already used by another display. Choose a free screen."
            }
            LeaseError::ContentBusy => {
                "The display is still starting or stopping. Try again in a moment."
            }
            LeaseError::ContentActiveElsewhere(_) => {
                "This display already runs on another screen. Stop it first."
            }
            LeaseError::NoFreeExternal => {
                "No free external screen is connected. The cashier screen is never used."
            }
            LeaseError::PresentationChanged => {
                "The display changed meanwhile. Refresh and try again."
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reservation {
    /// Build a new window on `display_id`; `instance` identifies it for release.
    Open { display_id: String, instance: u64 },
    /// The content already shows on this monitor; its token was rotated.
    Reused { display_id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    /// No lease matched (none, or an older token): nothing is closed.
    NotFound,
    /// Destroy this instance's window; the lease stays Closing until Destroyed.
    Destroy(u64),
    /// The window is still being built: the opener's activation fails and it
    /// destroys its own window.
    Deferred,
}

pub struct DisplayLeases {
    leases: Vec<Lease>,
    next_instance: u64,
}

impl DisplayLeases {
    pub const fn new() -> Self {
        Self {
            leases: Vec::new(),
            next_instance: 1,
        }
    }

    pub fn leases(&self) -> &[Lease] {
        &self.leases
    }

    pub fn lease(&self, content: &str) -> Option<&Lease> {
        self.leases.iter().find(|lease| lease.content == content)
    }

    pub fn occupant(&self, display_id: &str) -> Option<&Lease> {
        self.leases
            .iter()
            .find(|lease| lease.display_id == display_id)
    }

    /// Resolves the requested monitor and reserves it for `content` in one step.
    /// An explicit request is validated before anything changes and never falls
    /// back to another monitor. `expected` is the presentation token the caller
    /// held when it issued the request: only the current token of an Active lease
    /// reopens that presentation (rotating its token), a request naming none only
    /// creates while the content has no lease, and every other request changes
    /// nothing. Callers reconcile removed monitors first.
    pub fn reserve(
        &mut self,
        content: &str,
        request: &DisplayRequest,
        expected: Option<&str>,
        monitors: &[MonitorSlot],
        token: String,
    ) -> Result<Reservation, LeaseError> {
        let explicit = match request {
            DisplayRequest::Auto => None,
            DisplayRequest::Id(id) => Some(
                monitors
                    .iter()
                    .find(|monitor| &monitor.id == id)
                    .ok_or(LeaseError::DisplayNotFound)?,
            ),
            DisplayRequest::Index(index) => {
                Some(monitors.get(*index).ok_or(LeaseError::DisplayNotFound)?)
            }
        };
        if explicit.is_some_and(|monitor| !monitor.is_external()) {
            return Err(LeaseError::ReservedForPos);
        }
        if let Some(existing) = self
            .leases
            .iter_mut()
            .find(|lease| lease.content == content)
        {
            let usable = monitors
                .iter()
                .any(|monitor| monitor.id == existing.display_id && monitor.is_external());
            if existing.phase != LeasePhase::Active || !usable {
                return Err(LeaseError::ContentBusy);
            }
            // Compare-and-set: only the holder of the current presentation reopens it.
            if expected != Some(existing.token.as_str()) {
                return Err(LeaseError::PresentationChanged);
            }
            if explicit.is_some_and(|monitor| monitor.id != existing.display_id) {
                return Err(LeaseError::ContentActiveElsewhere(
                    existing.display_id.clone(),
                ));
            }
            existing.token = token;
            return Ok(Reservation::Reused {
                display_id: existing.display_id.clone(),
            });
        }
        // The presentation the caller held is gone: only an open naming none starts anew.
        if expected.is_some() {
            return Err(LeaseError::PresentationChanged);
        }
        let display_id = match explicit {
            Some(monitor) => {
                if let Some(holder) = self.occupant(&monitor.id) {
                    return Err(LeaseError::Occupied(holder.content.clone()));
                }
                monitor.id.clone()
            }
            None => monitors
                .iter()
                .find(|monitor| monitor.is_external() && self.occupant(&monitor.id).is_none())
                .map(|monitor| monitor.id.clone())
                .ok_or(LeaseError::NoFreeExternal)?,
        };
        let instance = self.next_instance;
        self.next_instance += 1;
        self.leases.push(Lease {
            content: content.to_string(),
            display_id: display_id.clone(),
            token,
            instance,
            phase: LeasePhase::Opening,
            built: false,
        });
        Ok(Reservation::Open {
            display_id,
            instance,
        })
    }

    fn instance_mut(&mut self, content: &str, instance: u64) -> Option<&mut Lease> {
        self.leases
            .iter_mut()
            .find(|lease| lease.content == content && lease.instance == instance)
    }

    fn remove_instance(&mut self, content: &str, instance: u64) -> bool {
        let before = self.leases.len();
        self.leases
            .retain(|lease| !(lease.content == content && lease.instance == instance));
        self.leases.len() != before
    }

    /// The window of this reservation exists and its Destroyed callback is registered.
    pub fn mark_built(&mut self, content: &str, instance: u64) -> bool {
        match self.instance_mut(content, instance) {
            Some(lease) => {
                lease.built = true;
                true
            }
            None => false,
        }
    }

    /// Marks a placed and shown window Active. False when it was stopped or its
    /// monitor vanished meanwhile: the caller destroys the window.
    pub fn activate(&mut self, content: &str, instance: u64) -> bool {
        match self.instance_mut(content, instance) {
            Some(lease) if lease.phase == LeasePhase::Opening => {
                lease.phase = LeasePhase::Active;
                true
            }
            _ => false,
        }
    }

    /// Releases a reservation whose window was never built.
    pub fn abort(&mut self, content: &str, instance: u64) -> bool {
        self.remove_instance(content, instance)
    }

    /// A built window is being destroyed (failed placement or left its monitor):
    /// its monitor stays occupied until the Destroyed callback.
    pub fn close_instance(&mut self, content: &str, instance: u64) -> bool {
        match self.instance_mut(content, instance) {
            Some(lease) => {
                lease.phase = LeasePhase::Closing;
                true
            }
            None => false,
        }
    }

    /// Stop request. With a token, only that presentation closes; a stale token
    /// matches nothing. Without one, this content stops. Other content is never touched.
    pub fn begin_close(&mut self, content: &str, token: Option<&str>) -> CloseOutcome {
        let Some(lease) = self
            .leases
            .iter_mut()
            .find(|lease| lease.content == content)
        else {
            return CloseOutcome::NotFound;
        };
        if token.is_some_and(|token| token != lease.token) {
            return CloseOutcome::NotFound;
        }
        lease.phase = LeasePhase::Closing;
        if lease.built {
            CloseOutcome::Destroy(lease.instance)
        } else {
            CloseOutcome::Deferred
        }
    }

    /// The window of `instance` was destroyed: release its monitor. A late
    /// callback of an older window never releases a newer lease.
    pub fn on_destroyed(&mut self, content: &str, instance: u64) -> bool {
        self.remove_instance(content, instance)
    }

    /// Closes every lease whose monitor is no longer connected unchanged, now
    /// shows the cashier POS or has an unknown cashier topology, and returns the
    /// built windows to destroy. Their occupancy stays on the old identity until
    /// the Destroyed callback, so it never moves to the monitor now at the same index.
    pub fn reconcile(&mut self, monitors: &[MonitorSlot]) -> Vec<(String, u64)> {
        let mut destroy = Vec::new();
        for lease in &mut self.leases {
            if monitors
                .iter()
                .any(|monitor| monitor.id == lease.display_id && monitor.is_external())
            {
                continue;
            }
            lease.phase = LeasePhase::Closing;
            if lease.built {
                destroy.push((lease.content.clone(), lease.instance));
            }
        }
        destroy
    }

    /// Built windows, read before looking them up outside the lock.
    pub fn built_instances(&self) -> Vec<(String, u64)> {
        self.leases
            .iter()
            .filter(|lease| lease.built)
            .map(|lease| (lease.content.clone(), lease.instance))
            .collect()
    }

    /// Releases built leases whose window was found gone although its Destroyed
    /// callback never ran. Only the observed instances are released; an unbuilt
    /// reservation belongs to its opener.
    pub fn release_missing(&mut self, gone: &[(String, u64)]) -> usize {
        let before = self.leases.len();
        self.leases.retain(|lease| {
            !(lease.built
                && gone.iter().any(|(content, instance)| {
                    *content == lease.content && *instance == lease.instance
                }))
        });
        before - self.leases.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KDS: &str = "kitchen_display";
    const CD: &str = "customer_display";

    fn slot(id: &str, is_primary: bool, hosts_pos: bool) -> MonitorSlot {
        MonitorSlot {
            id: id.to_string(),
            is_primary,
            hosts_pos,
        }
    }

    /// The primary monitor with the cashier POS plus two external screens.
    fn three_screens() -> Vec<MonitorSlot> {
        vec![
            slot("primary", true, true),
            slot("hdmi-b", false, false),
            slot("hdmi-c", false, false),
        ]
    }

    fn id(value: &str) -> DisplayRequest {
        DisplayRequest::Id(value.to_string())
    }

    /// Reserves, builds and activates like the native command; returns screen and
    /// instance. `expected` is the presentation token the caller holds.
    fn open_holding(
        leases: &mut DisplayLeases,
        content: &str,
        request: DisplayRequest,
        expected: Option<&str>,
        monitors: &[MonitorSlot],
        token: &str,
    ) -> Result<(String, u64), LeaseError> {
        match leases.reserve(content, &request, expected, monitors, token.to_string())? {
            Reservation::Open {
                display_id,
                instance,
            } => {
                assert!(leases.mark_built(content, instance));
                assert!(leases.activate(content, instance));
                Ok((display_id, instance))
            }
            Reservation::Reused { display_id } => {
                Ok((display_id, leases.lease(content).unwrap().instance))
            }
        }
    }

    /// A fresh open: the caller holds no presentation of this content.
    fn open(
        leases: &mut DisplayLeases,
        content: &str,
        request: DisplayRequest,
        monitors: &[MonitorSlot],
        token: &str,
    ) -> Result<(String, u64), LeaseError> {
        open_holding(leases, content, request, None, monitors, token)
    }

    fn reserve_new(leases: &mut DisplayLeases, content: &str, token: &str) -> u64 {
        match leases.reserve(
            content,
            &DisplayRequest::Auto,
            None,
            &three_screens(),
            token.to_string(),
        ) {
            Ok(Reservation::Open { instance, .. }) => instance,
            other => panic!("expected a new window, got {other:?}"),
        }
    }

    /// Screen, window, token and phase of the lease of `content`.
    fn lease_state(
        leases: &DisplayLeases,
        content: &str,
    ) -> Option<(String, u64, String, LeasePhase)> {
        leases.lease(content).map(|lease| {
            (
                lease.display_id.clone(),
                lease.instance,
                lease.token.clone(),
                lease.phase,
            )
        })
    }

    #[test]
    fn two_contents_take_different_external_screens_in_either_order() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        assert_eq!(
            open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k1")
                .unwrap()
                .0,
            "hdmi-b"
        );
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Auto, &screens, "c1")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(leases
            .leases()
            .iter()
            .all(|lease| lease.phase == LeasePhase::Active));
        assert!(leases.occupant("primary").is_none());

        let mut reversed = DisplayLeases::new();
        assert_eq!(
            open(&mut reversed, CD, id("hdmi-b"), &screens, "c1")
                .unwrap()
                .0,
            "hdmi-b"
        );
        assert_eq!(
            open(&mut reversed, KDS, DisplayRequest::Auto, &screens, "k1")
                .unwrap()
                .0,
            "hdmi-c"
        );
    }

    #[test]
    fn a_screen_of_another_content_stays_rejected_until_its_window_is_destroyed() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, kds) = open(&mut leases, KDS, id("hdmi-b"), &screens, "k1").unwrap();
        let taken = Err(LeaseError::Occupied(KDS.to_string()));
        assert_eq!(
            leases.reserve(CD, &id("hdmi-b"), None, &screens, "c1".into()),
            taken
        );
        assert_eq!(
            leases.reserve(CD, &DisplayRequest::Index(1), None, &screens, "c1".into()),
            taken
        );
        // Closing keeps the screen occupied until the window is really gone.
        assert_eq!(leases.begin_close(KDS, None), CloseOutcome::Destroy(kds));
        assert_eq!(
            leases.reserve(CD, &id("hdmi-b"), None, &screens, "c1".into()),
            taken
        );
        assert_eq!(
            leases.reserve(KDS, &DisplayRequest::Auto, None, &screens, "k2".into()),
            Err(LeaseError::ContentBusy)
        );
        assert!(leases.on_destroyed(KDS, kds));
        assert_eq!(
            open(&mut leases, CD, id("hdmi-b"), &screens, "c1")
                .unwrap()
                .0,
            "hdmi-b"
        );
    }

    #[test]
    fn explicit_missing_or_cashier_screens_fail_closed_without_redirect() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        for request in [DisplayRequest::Index(7), id("unplugged")] {
            assert_eq!(
                leases.reserve(KDS, &request, None, &screens, "k".into()),
                Err(LeaseError::DisplayNotFound)
            );
        }
        // Here the primary monitor shows the cashier POS.
        for request in [DisplayRequest::Index(0), id("primary")] {
            assert_eq!(
                leases.reserve(KDS, &request, None, &screens, "k".into()),
                Err(LeaseError::ReservedForPos)
            );
        }
        assert!(leases.leases().is_empty());
        // The cashier moved the POS window to a non-primary screen: that screen is excluded instead.
        let moved = vec![
            slot("primary", true, false),
            slot("hdmi-b", false, true),
            slot("hdmi-c", false, false),
        ];
        assert_eq!(
            leases.reserve(KDS, &id("hdmi-b"), None, &moved, "k".into()),
            Err(LeaseError::ReservedForPos)
        );
        assert_eq!(
            open(&mut leases, KDS, id("hdmi-c"), &moved, "k").unwrap().0,
            "hdmi-c"
        );
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Auto, &moved, "c")
                .unwrap()
                .0,
            "primary"
        );
        assert!(leases.occupant("hdmi-b").is_none());
        // No free external screen is reported instead of covering the POS.
        let mut single = DisplayLeases::new();
        assert_eq!(
            single.reserve(
                CD,
                &DisplayRequest::Auto,
                None,
                &[slot("primary", true, true)],
                "c".into()
            ),
            Err(LeaseError::NoFreeExternal)
        );
        assert!(single.leases().is_empty());
    }

    #[test]
    fn a_stale_close_or_callback_cannot_end_a_newer_session() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, first) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "t1").unwrap();
        // Its holder reopens the running projection: same window, new token.
        assert_eq!(
            leases.reserve(
                KDS,
                &DisplayRequest::Auto,
                Some("t1"),
                &screens,
                "t2".into()
            ),
            Ok(Reservation::Reused {
                display_id: "hdmi-b".into()
            })
        );
        assert_eq!(leases.begin_close(KDS, Some("t1")), CloseOutcome::NotFound);
        assert_eq!(
            leases
                .lease(KDS)
                .map(|lease| (lease.phase, lease.token.as_str())),
            Some((LeasePhase::Active, "t2"))
        );
        // Moving a running projection needs an explicit stop first.
        assert_eq!(
            leases.reserve(KDS, &id("hdmi-c"), Some("t2"), &screens, "t3".into()),
            Err(LeaseError::ContentActiveElsewhere("hdmi-b".into()))
        );
        assert_eq!(
            leases.begin_close(KDS, Some("t2")),
            CloseOutcome::Destroy(first)
        );
        assert!(leases.on_destroyed(KDS, first));
        let (_, second) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "t4").unwrap();
        assert_ne!(first, second);
        // Late callbacks and tokens of the first window leave the new session alone.
        assert!(!leases.on_destroyed(KDS, first));
        assert!(!leases.abort(KDS, first));
        assert!(!leases.close_instance(KDS, first));
        assert!(!leases.activate(KDS, first));
        assert_eq!(leases.begin_close(KDS, Some("t2")), CloseOutcome::NotFound);
        assert_eq!(leases.begin_close(KDS, Some("")), CloseOutcome::NotFound);
        assert_eq!(
            leases.lease(KDS).map(|lease| (lease.instance, lease.phase)),
            Some((second, LeasePhase::Active))
        );
    }

    #[test]
    fn a_late_open_without_the_current_token_never_takes_over_a_newer_presentation() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        // The newer open reaches native first and runs.
        let (screen, newer) =
            open(&mut leases, KDS, DisplayRequest::Auto, &screens, "new").unwrap();
        let current = Some((screen.clone(), newer, "new".to_string(), LeasePhase::Active));
        // The older open arrives late, holding no token or the token of a session that ended.
        for expected in [None, Some("old"), Some("")] {
            for request in [DisplayRequest::Auto, id(&screen), id("hdmi-c")] {
                assert_eq!(
                    leases.reserve(KDS, &request, expected, &screens, "late".into()),
                    Err(LeaseError::PresentationChanged)
                );
                assert_eq!(lease_state(&leases, KDS), current);
            }
        }
        assert!(leases.occupant("hdmi-c").is_none());
        // Its token was never issued, so its cleanup cannot close the newer window either.
        assert_eq!(
            leases.begin_close(KDS, Some("late")),
            CloseOutcome::NotFound
        );
        assert_eq!(leases.begin_close(KDS, Some("old")), CloseOutcome::NotFound);
        assert_eq!(lease_state(&leases, KDS), current);
        // While the newer window is still opening, every other open is refused unchanged too.
        let mut opening = DisplayLeases::new();
        let instance = reserve_new(&mut opening, CD, "new");
        let before = lease_state(&opening, CD);
        for expected in [None, Some("old"), Some("new")] {
            assert_eq!(
                opening.reserve(CD, &DisplayRequest::Auto, expected, &screens, "late".into()),
                Err(LeaseError::ContentBusy)
            );
        }
        assert_eq!(lease_state(&opening, CD), before);
        assert!(opening.mark_built(CD, instance));
        assert!(opening.activate(CD, instance));
    }

    #[test]
    fn only_the_current_token_reopens_and_rotates_the_running_presentation() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (screen, instance) =
            open(&mut leases, CD, DisplayRequest::Auto, &screens, "c1").unwrap();
        // The holder reopens its window explicitly or with Auto: same window and screen, rotated token.
        assert_eq!(
            open_holding(&mut leases, CD, id(&screen), Some("c1"), &screens, "c2"),
            Ok((screen.clone(), instance))
        );
        assert_eq!(
            leases.reserve(CD, &DisplayRequest::Auto, Some("c2"), &screens, "c3".into()),
            Ok(Reservation::Reused {
                display_id: screen.clone()
            })
        );
        let current = Some((
            screen.clone(),
            instance,
            "c3".to_string(),
            LeasePhase::Active,
        ));
        assert_eq!(lease_state(&leases, CD), current);
        // Rotated-away tokens neither reopen nor close it.
        for stale in ["c1", "c2"] {
            assert_eq!(
                leases.reserve(CD, &DisplayRequest::Auto, Some(stale), &screens, "x".into()),
                Err(LeaseError::PresentationChanged)
            );
            assert_eq!(leases.begin_close(CD, Some(stale)), CloseOutcome::NotFound);
        }
        assert_eq!(lease_state(&leases, CD), current);
        assert_eq!(
            leases.begin_close(CD, Some("c3")),
            CloseOutcome::Destroy(instance)
        );
    }

    #[test]
    fn a_token_of_a_destroyed_or_replaced_presentation_never_reopens() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, first) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k1").unwrap();
        // The window was closed from the OS: its Destroyed callback ended the lease.
        assert!(leases.on_destroyed(KDS, first));
        assert_eq!(
            leases.reserve(
                KDS,
                &DisplayRequest::Auto,
                Some("k1"),
                &screens,
                "k2".into()
            ),
            Err(LeaseError::PresentationChanged)
        );
        assert!(leases.leases().is_empty());
        // A fresh open after the OS close gets a new window.
        let (_, second) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k3").unwrap();
        assert_ne!(first, second);
        // The destroyed session's token neither takes over nor closes its replacement.
        assert_eq!(
            leases.reserve(
                KDS,
                &DisplayRequest::Auto,
                Some("k1"),
                &screens,
                "k4".into()
            ),
            Err(LeaseError::PresentationChanged)
        );
        assert_eq!(leases.begin_close(KDS, Some("k1")), CloseOutcome::NotFound);
        assert_eq!(
            lease_state(&leases, KDS),
            Some((
                "hdmi-b".to_string(),
                second,
                "k3".to_string(),
                LeasePhase::Active
            ))
        );
        // Closing: even its holder waits until the window is destroyed.
        assert_eq!(
            leases.begin_close(KDS, Some("k3")),
            CloseOutcome::Destroy(second)
        );
        for expected in [Some("k3"), None] {
            assert_eq!(
                leases.reserve(KDS, &DisplayRequest::Auto, expected, &screens, "k5".into()),
                Err(LeaseError::ContentBusy)
            );
        }
        assert!(leases.on_destroyed(KDS, second));
        assert_eq!(
            leases.reserve(
                KDS,
                &DisplayRequest::Auto,
                Some("k3"),
                &screens,
                "k5".into()
            ),
            Err(LeaseError::PresentationChanged)
        );
        assert!(leases.leases().is_empty());
    }

    #[test]
    fn failed_builds_placements_and_stops_while_opening_release_only_their_instance() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        // A failed build releases at once: no window exists.
        let failed = reserve_new(&mut leases, KDS, "t1");
        assert!(leases.abort(KDS, failed));
        assert!(leases.leases().is_empty());
        // A failed placement keeps the screen until the window's Destroyed callback.
        let misplaced = reserve_new(&mut leases, KDS, "t2");
        assert!(leases.mark_built(KDS, misplaced));
        assert!(leases.close_instance(KDS, misplaced));
        assert_eq!(
            leases.reserve(CD, &id("hdmi-b"), None, &screens, "c".into()),
            Err(LeaseError::Occupied(KDS.to_string()))
        );
        assert!(leases.on_destroyed(KDS, misplaced));
        // A stop while the window is being built is left to the opener, whose activation fails.
        let opening = reserve_new(&mut leases, KDS, "t3");
        assert_eq!(leases.begin_close(KDS, None), CloseOutcome::Deferred);
        assert!(leases.mark_built(KDS, opening));
        assert!(!leases.activate(KDS, opening));
        assert!(leases.on_destroyed(KDS, opening));
        assert!(leases.leases().is_empty());
    }

    #[test]
    fn a_removed_screen_never_transfers_its_occupancy_by_index() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, kds) = open(&mut leases, KDS, DisplayRequest::Index(1), &screens, "k1").unwrap();
        // hdmi-b is unplugged: hdmi-c now has index 1.
        let after = vec![slot("primary", true, true), slot("hdmi-c", false, false)];
        assert_eq!(leases.reconcile(&after), vec![(KDS.to_string(), kds)]);
        assert_eq!(
            leases
                .lease(KDS)
                .map(|lease| (lease.display_id.as_str(), lease.phase)),
            Some(("hdmi-b", LeasePhase::Closing))
        );
        assert!(leases.occupant("hdmi-c").is_none());
        assert_eq!(
            leases.reserve(KDS, &id("hdmi-b"), None, &after, "k2".into()),
            Err(LeaseError::DisplayNotFound)
        );
        assert_eq!(
            leases.reserve(KDS, &DisplayRequest::Auto, None, &after, "k2".into()),
            Err(LeaseError::ContentBusy)
        );
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Index(1), &after, "c1")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(leases.on_destroyed(KDS, kds));
        assert_eq!(
            leases.reserve(KDS, &DisplayRequest::Auto, None, &after, "k3".into()),
            Err(LeaseError::NoFreeExternal)
        );
        // A resolution, arrangement or scale change is another identity, never a silent match.
        let fingerprint =
            |x, width, scale| monitor_fingerprint(r"\\.\DISPLAY2", x, 0, width, 1080, scale);
        assert_eq!(fingerprint(1920, 1920, 1.0), fingerprint(1920, 1920, 1.0));
        assert_ne!(fingerprint(1920, 1920, 1.0), fingerprint(1920, 1280, 1.0));
        assert_ne!(fingerprint(1920, 1920, 1.0), fingerprint(2560, 1920, 1.0));
        assert_ne!(fingerprint(1920, 1920, 1.0), fingerprint(1920, 1920, 1.25));
    }

    #[test]
    fn a_missing_window_releases_only_the_observed_built_instance() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, first) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k1").unwrap();
        let observed = leases.built_instances();
        assert_eq!(observed, vec![(KDS.to_string(), first)]);
        // Meanwhile that window was destroyed and a new one opened.
        assert!(leases.on_destroyed(KDS, first));
        let (_, second) = open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k2").unwrap();
        assert_eq!(leases.release_missing(&observed), 0);
        assert_eq!(leases.lease(KDS).map(|lease| lease.instance), Some(second));
        // An unbuilt reservation is owned by its opener and never released as missing.
        let opening = reserve_new(&mut leases, CD, "c1");
        assert_eq!(leases.release_missing(&[(CD.to_string(), opening)]), 0);
        assert_eq!(leases.release_missing(&[(KDS.to_string(), second)]), 1);
        assert_eq!(leases.leases().len(), 1);
    }

    #[test]
    fn auto_opens_take_different_free_screens_when_the_customer_display_starts_first() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Auto, &screens, "c1")
                .unwrap()
                .0,
            "hdmi-b"
        );
        assert_eq!(
            open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k1")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(leases.occupant("primary").is_none());
    }

    #[test]
    fn explicit_targets_fail_with_their_own_error_and_never_redirect() {
        let screens = vec![
            slot("primary", true, false),
            slot("cashier", false, true),
            slot("hdmi-b", false, false),
            slot("hdmi-c", false, false),
        ];
        let mut leases = DisplayLeases::new();
        open(&mut leases, KDS, id("hdmi-b"), &screens, "k1").unwrap();
        let occupied = LeaseError::Occupied(KDS.to_string());
        for (request, error) in [
            (id("hdmi-b"), occupied.clone()),
            (DisplayRequest::Index(2), occupied),
            (id("unplugged"), LeaseError::DisplayNotFound),
            (DisplayRequest::Index(4), LeaseError::DisplayNotFound),
            (id("cashier"), LeaseError::ReservedForPos),
            (DisplayRequest::Index(1), LeaseError::ReservedForPos),
        ] {
            assert_eq!(
                leases.reserve(CD, &request, None, &screens, "c1".into()),
                Err(error)
            );
            // The free external screens are never taken instead.
            assert!(leases.lease(CD).is_none());
            assert!(leases.occupant("primary").is_none());
            assert!(leases.occupant("hdmi-c").is_none());
        }
        assert_eq!(
            open(&mut leases, CD, id("hdmi-c"), &screens, "c2")
                .unwrap()
                .0,
            "hdmi-c"
        );
    }

    #[test]
    fn a_closing_screen_is_freed_only_by_its_own_destroyed_callback() {
        let screens = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, kds) = open(&mut leases, KDS, id("hdmi-b"), &screens, "k1").unwrap();
        let (_, cd) = open(&mut leases, CD, id("hdmi-c"), &screens, "c1").unwrap();
        assert_eq!(
            leases.begin_close(KDS, Some("k1")),
            CloseOutcome::Destroy(kds)
        );
        // Another content's window or an unknown build frees nothing.
        assert!(!leases.on_destroyed(KDS, cd));
        assert!(!leases.on_destroyed(CD, kds));
        assert!(!leases.on_destroyed(KDS, u64::MAX));
        assert_eq!(
            leases
                .occupant("hdmi-b")
                .map(|lease| (lease.instance, lease.phase)),
            Some((kds, LeasePhase::Closing))
        );
        assert_eq!(
            leases.lease(CD).map(|lease| (lease.instance, lease.phase)),
            Some((cd, LeasePhase::Active))
        );
        assert_eq!(leases.begin_close(CD, None), CloseOutcome::Destroy(cd));
        assert!(leases.on_destroyed(CD, cd));
        // Still closing: hdmi-b is neither granted nor shared; the freed hdmi-c is.
        assert_eq!(
            leases.reserve(CD, &id("hdmi-b"), None, &screens, "c2".into()),
            Err(LeaseError::Occupied(KDS.to_string()))
        );
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Auto, &screens, "c2")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(leases.on_destroyed(KDS, kds));
        assert!(leases.occupant("hdmi-b").is_none());
    }

    #[test]
    fn an_external_os_primary_is_offered_while_only_the_cashier_screen_is_protected() {
        // Three extended screens: Windows made the kitchen TV primary; the cashier POS runs on the second.
        let screens = monitor_slots(
            vec![
                ("tv-primary".into(), true),
                ("cashier".into(), false),
                ("hdmi-c".into(), false),
            ],
            Some("cashier"),
        );
        assert_eq!(
            screens,
            vec![
                slot("tv-primary", true, false),
                slot("cashier", false, true),
                slot("hdmi-c", false, false),
            ]
        );
        let mut leases = DisplayLeases::new();
        assert_eq!(
            open(&mut leases, KDS, DisplayRequest::Auto, &screens, "k1")
                .unwrap()
                .0,
            "tv-primary"
        );
        assert_eq!(
            open(&mut leases, CD, DisplayRequest::Auto, &screens, "c1")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(leases.occupant("cashier").is_none());
        // Either content takes either external screen explicitly; the cashier's is never taken.
        let mut reversed = DisplayLeases::new();
        for request in [id("cashier"), DisplayRequest::Index(1)] {
            assert_eq!(
                reversed.reserve(CD, &request, None, &screens, "c1".into()),
                Err(LeaseError::ReservedForPos)
            );
        }
        assert_eq!(
            open(&mut reversed, CD, id("tv-primary"), &screens, "c1")
                .unwrap()
                .0,
            "tv-primary"
        );
        assert_eq!(
            open(&mut reversed, KDS, DisplayRequest::Index(2), &screens, "k1")
                .unwrap()
                .0,
            "hdmi-c"
        );
        assert!(reversed.occupant("cashier").is_none());
    }

    #[test]
    fn an_unknown_cashier_screen_leaves_no_external_target() {
        let connected = || -> Vec<(String, bool)> {
            vec![
                ("primary".into(), true),
                ("hdmi-b".into(), false),
                ("hdmi-c".into(), false),
            ]
        };
        // The cashier window's monitor could not be read, or is not among the connected ones.
        for pos in [None, Some("unplugged")] {
            let unknown = monitor_slots(connected(), pos);
            assert!(unknown
                .iter()
                .all(|slot| slot.hosts_pos && !slot.is_external()));
            let mut leases = DisplayLeases::new();
            for content in [KDS, CD] {
                assert_eq!(
                    leases.reserve(content, &DisplayRequest::Auto, None, &unknown, "t".into()),
                    Err(LeaseError::NoFreeExternal)
                );
                for target in ["primary", "hdmi-b"] {
                    assert_eq!(
                        leases.reserve(content, &id(target), None, &unknown, "t".into()),
                        Err(LeaseError::ReservedForPos)
                    );
                }
            }
            assert!(leases.leases().is_empty());
        }
        // A cashier monitor that turns unknown closes the running projection; its screen stays held.
        let known = monitor_slots(connected(), Some("primary"));
        let mut leases = DisplayLeases::new();
        let (_, kds) = open(&mut leases, KDS, DisplayRequest::Auto, &known, "k1").unwrap();
        assert_eq!(
            leases.reconcile(&monitor_slots(connected(), None)),
            vec![(KDS.to_string(), kds)]
        );
        assert_eq!(
            leases
                .lease(KDS)
                .map(|lease| (lease.display_id.as_str(), lease.phase)),
            Some(("hdmi-b", LeasePhase::Closing))
        );
        assert_eq!(
            leases.reserve(CD, &id("hdmi-b"), None, &known, "c1".into()),
            Err(LeaseError::Occupied(KDS.to_string()))
        );
        assert!(leases.on_destroyed(KDS, kds));
        assert!(leases.leases().is_empty());
    }

    #[test]
    fn the_cashier_moving_onto_a_leased_screen_closes_it_and_keeps_the_screen_held() {
        let before = three_screens();
        let mut leases = DisplayLeases::new();
        let (_, kds) = open(&mut leases, KDS, id("hdmi-b"), &before, "k1").unwrap();
        let (_, cd) = open(&mut leases, CD, id("hdmi-c"), &before, "c1").unwrap();
        // The cashier drags the POS window onto the kitchen screen.
        let after = vec![
            slot("primary", true, false),
            slot("hdmi-b", false, true),
            slot("hdmi-c", false, false),
        ];
        assert_eq!(leases.reconcile(&after), vec![(KDS.to_string(), kds)]);
        assert_eq!(
            lease_state(&leases, KDS).map(|(screen, instance, _, phase)| (screen, instance, phase)),
            Some(("hdmi-b".to_string(), kds, LeasePhase::Closing))
        );
        assert_eq!(
            lease_state(&leases, CD).map(|(_, instance, _, phase)| (instance, phase)),
            Some((cd, LeasePhase::Active))
        );
        // Its holder can no longer reopen it; the screen stays held until the window is destroyed.
        assert_eq!(
            leases.reserve(KDS, &DisplayRequest::Auto, Some("k1"), &after, "k2".into()),
            Err(LeaseError::ContentBusy)
        );
        assert_eq!(
            leases.occupant("hdmi-b").map(|lease| lease.instance),
            Some(kds)
        );
        assert!(leases.on_destroyed(KDS, kds));
        assert_eq!(
            leases.reserve(KDS, &id("hdmi-b"), None, &after, "k2".into()),
            Err(LeaseError::ReservedForPos)
        );
        // The OS primary the cashier left is a free external screen now.
        assert_eq!(
            open(&mut leases, KDS, DisplayRequest::Auto, &after, "k3")
                .unwrap()
                .0,
            "primary"
        );
        // A window still opening there is stopped too: its opener's activation fails.
        let mut opening = DisplayLeases::new();
        let instance = reserve_new(&mut opening, CD, "c1");
        assert!(opening.reconcile(&after).is_empty());
        assert!(opening.mark_built(CD, instance));
        assert!(!opening.activate(CD, instance));
        assert_eq!(
            opening.occupant("hdmi-b").map(|lease| lease.phase),
            Some(LeasePhase::Closing)
        );
        assert!(opening.on_destroyed(CD, instance));
    }
}
