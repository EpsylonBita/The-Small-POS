//! Safety policy for the temporary event-only Grandstream SIP observer.
//!
//! An event observer is not a user agent and must not answer or terminate a
//! SIP dialog.  In particular, returning `486 Busy Here` can make an HT813
//! stop the PSTN call before the attached analogue telephone answers.  The
//! production default is therefore passive.  The old response behavior is
//! available only behind an intentionally alarming, non-default Cargo feature
//! for reproducing legacy lab behavior.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EventOnlyInvitePolicy {
    #[default]
    ObserveOnly,
    RejectBusyLegacy,
}

impl EventOnlyInvitePolicy {
    pub const fn response_statuses(self) -> &'static [u16] {
        match self {
            Self::ObserveOnly => &[],
            Self::RejectBusyLegacy => &[100, 486],
        }
    }
}

pub const fn compiled_event_only_policy() -> EventOnlyInvitePolicy {
    if cfg!(feature = "callerid-unsafe-legacy-busy-rejection") {
        EventOnlyInvitePolicy::RejectBusyLegacy
    } else {
        EventOnlyInvitePolicy::ObserveOnly
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_default_observes_caller_id_without_answering_the_sip_leg() {
        assert_eq!(
            compiled_event_only_policy(),
            EventOnlyInvitePolicy::ObserveOnly
        );
        assert!(compiled_event_only_policy().response_statuses().is_empty());
    }

    #[test]
    fn legacy_busy_rejection_requires_an_explicit_policy() {
        assert_eq!(
            EventOnlyInvitePolicy::RejectBusyLegacy.response_statuses(),
            &[100, 486]
        );
    }
}
